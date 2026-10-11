import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@talorys/shared";
import { AuthService } from "../src/auth/auth-service";
import { AutomationService, type Scheduler } from "../src/agent/scheduling";
import { SettingsService } from "../src/services/settings";
import type { Services } from "../src/services/container";
import { freshIp, inAgent, password } from "./helpers";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Hold one previously read hash so another request can change it before verification completes. */
class PausedPasswordSettings extends SettingsService {
  readonly read = deferred();
  readonly resume = deferred();
  private paused = false;

  override async getJson<T>(key: string): Promise<T | null> {
    const value = await super.getJson<T>(key);
    if (key === "auth.password_override" && !this.paused) {
      this.paused = true;
      this.read.resolve();
      await this.resume.promise;
    }
    return value;
  }
}

function authWithSettings(services: Services, settings: SettingsService): AuthService {
  const secrets = env as unknown as { OWNER_PASSWORD_HASH: string; SESSION_SECRET: string };
  return new AuthService(services.db, settings, {
    passwordHash: secrets.OWNER_PASSWORD_HASH,
    sessionSecret: secrets.SESSION_SECRET,
  });
}

describe("PostgreSQL authentication concurrency", () => {
  it("rejects an old-password login after a concurrent password change revoked sessions", async () => {
    await inAgent(async ({ services: s }) => {
      const paused = new PausedPasswordSettings(s.db);
      const staleAuth = authWithSettings(s, paused);
      const login = staleAuth.login(password(), freshIp(), "stale request");
      const rejected = expect(login).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await paused.read.promise;
      try {
        await s.auth.changePassword(password(), "Changed-password-123", null, freshIp());
      } finally {
        paused.resume.resolve();
      }
      await rejected;
      expect((await s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_sessions`))?.n).toBe(0);
      const fresh = await s.auth.login("Changed-password-123", freshIp(), "fresh request");
      expect(await s.auth.validate(fresh.token)).not.toBeNull();
    });
  });

  it("does not let two changes verified against the same old password overwrite each other", async () => {
    await inAgent(async ({ services: s }) => {
      const paused = new PausedPasswordSettings(s.db);
      const staleAuth = authWithSettings(s, paused);
      const change = staleAuth.changePassword(password(), "Stale-password-123", null, freshIp());
      const rejected = expect(change).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await paused.read.promise;
      try {
        await s.auth.changePassword(password(), "Winning-password-123", null, freshIp());
      } finally {
        paused.resume.resolve();
      }
      await rejected;
      const stored = await s.settings.getJson<string>("auth.password_override");
      expect(await verifyPassword("Winning-password-123", stored!)).toBe(true);
      expect(await verifyPassword("Stale-password-123", stored!)).toBe(false);
    });
  });

  it("rejects an in-flight old-secret login after a CLI reset", async () => {
    await inAgent(async ({ services: s }) => {
      const paused = new PausedPasswordSettings(s.db);
      const staleAuth = authWithSettings(s, paused);
      const login = staleAuth.login(password(), freshIp(), "old deployment");
      const rejected = expect(login).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await paused.read.promise;
      try {
        const newAuth = new AuthService(s.db, s.settings, {
          passwordHash: await hashPassword("CLI-reset-password-123"),
          sessionSecret: (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET,
        });
        await newAuth.validate("triggers-reset");
      } finally {
        paused.resume.resolve();
      }
      await rejected;
      expect((await s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_sessions`))?.n).toBe(0);
    });
  });
});

function testScheduler() {
  const scheduled = new Map<string, { at: Date; automationId: string }>();
  let sequence = 0;
  const scheduler: Scheduler = {
    async schedule(at, automationId) {
      const id = `schedule-${++sequence}`;
      scheduled.set(id, { at, automationId });
      return id;
    },
    async cancel(id) { scheduled.delete(id); },
    async exists(id) { return scheduled.has(id); },
  };
  return { scheduler, scheduled };
}

describe("PostgreSQL automation completion concurrency", () => {
  it.each(["pause", "reschedule", "rearm", "delete"] as const)("preserves a concurrent %s while a one-shot is executing", async (operation) => {
    await inAgent(async ({ services: s }) => {
      const { scheduler, scheduled } = testScheduler();
      const automations = new AutomationService(s.automationsRepo, s.settings, s.activity, scheduler);
      const created = await automations.create({
        name: "Original", kind: "reminder", message: "Original message", enabled: true,
        schedule: { type: "once", at: "2099-01-01T12:00" },
      });
      const executing = deferred();
      const resume = deferred();
      const fire = automations.fire(created.id, created.schedule_id!, async () => {
        executing.resolve();
        await resume.promise;
        return { status: "success", result: "Delivered" };
      });
      await executing.promise;
      let expected = created;
      try {
        // These operations must finish before execution is released, so the lock
        // cannot be held throughout a long-running automation.
        if (operation === "pause") {
          expected = await automations.update(created.id, { enabled: false, name: "Edited", message: "Edited message" });
        } else if (operation === "reschedule") {
          expected = await automations.update(created.id, { schedule: { type: "once", at: "2099-02-01T12:00" }, name: "Edited" });
        } else if (operation === "rearm") {
          await automations.rearmAll();
          expected = (await automations.get(created.id))!;
        } else {
          await automations.delete(created.id);
        }
      } finally {
        resume.resolve();
      }
      await fire;
      const final = await automations.get(created.id);
      if (operation === "delete") {
        expect(final).toBeNull();
      } else {
        expect(final).toMatchObject({
          enabled: expected.enabled, status: expected.status, name: expected.name, message: expected.message,
          schedule_id: expected.schedule_id, next_run: expected.next_run, schedule: expected.schedule,
          run_count: 1, last_result: "Delivered", last_error: null,
        });
      }
      expect(scheduled.size).toBe(operation === "pause" || operation === "delete" ? 0 : 1);
      expect(await s.automationsRepo.runs()).toMatchObject([{ status: "success", result: "Delivered" }]);
    });
  });

  it("keeps edits and completes a one-shot exactly once despite duplicate callbacks", async () => {
    await inAgent(async ({ services: s }) => {
      const { scheduler, scheduled } = testScheduler();
      const automations = new AutomationService(s.automationsRepo, s.settings, s.activity, scheduler);
      const created = await automations.create({
        name: "Original", kind: "reminder", message: "Original", enabled: true,
        schedule: { type: "once", at: "2099-01-01T12:00" },
      });
      const executing = deferred();
      const resume = deferred();
      let executions = 0;
      const fire = automations.fire(created.id, created.schedule_id!, async () => {
        executions++;
        executing.resolve();
        await resume.promise;
        return { status: "success", result: "Done" };
      });
      await executing.promise;
      try {
        await automations.update(created.id, { name: "Edited", message: "Edited" });
        await automations.fire(created.id, created.schedule_id!, async () => {
          executions++;
          return { status: "success", result: "Duplicate" };
        });
        expect(await automations.reconcile()).toEqual({ repaired: 0 });
      } finally {
        resume.resolve();
      }
      await fire;
      expect(executions).toBe(1);
      expect(await automations.get(created.id)).toMatchObject({
        name: "Edited", message: "Edited", enabled: false, status: "completed", schedule_id: null,
        next_run: null, run_count: 1, last_result: "Done",
      });
      // A real SDK removes a fired schedule; the fake scheduler retains that entry.
      expect(scheduled.size).toBe(1);
    });
  });
});
