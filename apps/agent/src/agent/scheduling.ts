import { type Automation, type AutomationKind, type ScheduleSpec, computeNextRun, scheduleSpecSchema } from "@talorys/shared";
import type { AutomationRepository } from "../db/repositories/automations";
import type { SettingsService } from "../services/settings";
import type { ActivityLog } from "../services/usage";
import { ValidationError } from "../api/errors";

/**
 * Bridge to the Agents SDK scheduler (Durable Object alarms). Each enabled
 * automation has exactly one pending one-shot SDK schedule for its next run;
 * after it fires we compute the following occurrence in the owner's timezone.
 * This keeps wall-clock rules correct across DST and timezone changes.
 */
export interface Scheduler {
  schedule(at: Date, automationId: string): Promise<string>;
  cancel(scheduleId: string): Promise<void>;
  exists(scheduleId: string): Promise<boolean>;
}

export type AutomationExecutor = (automation: Automation) => Promise<{ status: "success" | "skipped"; result: string }>;

/** A run that was missed (e.g. during an outage) by more than this is executed once on recovery. */
const MAX_CATCH_UP_MS = 24 * 3600_000;

export class AutomationService {
  private readonly activeRuns = new Set<string>();
  constructor(
    private readonly repo: AutomationRepository,
    private readonly settings: SettingsService,
    private readonly activity: ActivityLog,
    private readonly scheduler: Scheduler,
  ) {}

  private async tz(): Promise<string> {
    return (await this.settings.get()).timezone;
  }

  async list(): Promise<Automation[]> {
    return await this.repo.list();
  }

  async get(id: string): Promise<Automation | null> {
    return await this.repo.get(id);
  }

  async create(input: { name: string; kind: AutomationKind; message: string; schedule: ScheduleSpec; enabled: boolean }): Promise<Automation> {
    const schedule = scheduleSpecSchema.parse(input.schedule);
    if ((input.kind === "reminder" || input.kind === "agent_prompt") && !input.message.trim()) {
      throw new ValidationError(input.kind === "reminder" ? "A reminder needs a message." : "An AI automation needs a prompt.");
    }
    const first = computeNextRun(schedule, await this.tz(), new Date());
    if (!first) throw new ValidationError("That time is in the past. Choose a future time.");
    const automation = await this.repo.create({ ...input, schedule });
    await this.activity.record("automation.created", `Created automation “${automation.name}”`);
    return automation.enabled ? this.repo.withLock(automation.id, async () => this.arm(await this.repo.require(automation.id))) : automation;
  }

  async update(
    id: string,
    patch: { name?: string; message?: string; schedule?: ScheduleSpec; enabled?: boolean },
  ): Promise<Automation> {
    return this.repo.withLock(id, async () => {
      const existing = await this.repo.require(id);
      const timingChanged = patch.schedule !== undefined || (patch.enabled !== undefined && patch.enabled !== existing.enabled);
      let next = await this.repo.update(id, {
        name: patch.name,
        message: patch.message,
        schedule: patch.schedule ? scheduleSpecSchema.parse(patch.schedule) : undefined,
        enabled: patch.enabled,
      });
      if (timingChanged) {
        await this.disarm(next);
        next = next.enabled ? await this.arm(next) : await this.repo.update(id, { status: "paused", next_run: null, schedule_id: null });
      }
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    await this.repo.withLock(id, async () => {
      const existing = await this.repo.require(id);
      await this.disarm(existing);
      await this.repo.delete(id);
      await this.activity.record("automation.deleted", `Deleted automation “${existing.name}”`);
    });
  }

  /**
   * Re-arms every enabled automation, e.g. after a timezone change or an import.
   * Disabled automations that still hold a schedule (e.g. disabled by an import) are disarmed.
   */
  async rearmAll(): Promise<void> {
    for (const item of await this.repo.list()) {
      await this.repo.withLock(item.id, async () => {
        const a = await this.repo.get(item.id);
        if (!a) return;
        await this.disarm(a);
        if (a.enabled) await this.arm(a);
        else if (a.schedule_id || a.status === "scheduled") {
          await this.repo.update(a.id, { status: "paused", next_run: null, schedule_id: null });
        }
      });
    }
  }

  /** Caller holds the per-automation lock until scheduler and database agree. */
  private async arm(automation: Automation, after = new Date()): Promise<Automation> {
    const next = computeNextRun(automation.schedule, await this.tz(), after);
    if (!next) {
      return await this.repo.update(automation.id, { status: "completed", enabled: false, next_run: null, schedule_id: null });
    }
    const scheduleId = await this.scheduler.schedule(next, automation.id);
    return await this.repo.update(automation.id, {
      status: "scheduled",
      next_run: next.toISOString(),
      schedule_id: scheduleId,
    });
  }

  private async disarm(automation: Automation): Promise<void> {
    if (automation.schedule_id) await this.scheduler.cancel(automation.schedule_id);
  }

  /**
   * Called when an SDK schedule fires. Stale schedules (automation deleted,
   * paused or re-armed since) are ignored, so double execution cannot happen.
   */
  async fire(automationId: string, scheduleId: string, execute: AutomationExecutor): Promise<void> {
    const claimed = await this.repo.withLock(automationId, async () => {
      // PostgreSQL I/O yields between calls, so claim the matching schedule atomically.
      const automation = await this.repo.claimRun(automationId, scheduleId);
      if (!automation) return null;
      const run = await this.repo.startRun(automation);
      this.activeRuns.add(scheduleId);
      return { automation, run };
    }).catch((error) => {
      this.activeRuns.delete(scheduleId);
      throw error;
    });
    if (!claimed) return;
    const { automation, run } = claimed;
    try {
      // No lock is held while an AI prompt or delivery runs: edits and pause stay responsive.
      let lastResult: string | null = null;
      let lastError: string | null = null;
      try {
        const outcome = await execute(automation);
        lastResult = outcome.result.slice(0, 2000);
        await this.repo.finishRun(run.id, outcome.status, lastResult, null);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await this.repo.finishRun(run.id, "error", null, lastError);
        await this.activity.record("automation.failed", `Automation “${automation.name}” failed: ${lastError}`);
      }
      await this.repo.withLock(automation.id, async () => {
        const current = await this.repo.get(automation.id);
        if (!current) return; // Deleted while executing; never recreate it.
        const updated = await this.repo.update(automation.id, {
          last_run: new Date().toISOString(),
          last_result: lastResult,
          last_error: lastError,
          run_count: current.run_count + 1,
        });
        // A pause, edit or reconciliation may have installed another schedule.
        // Record the result, but only the still-current callback can advance timing.
        if (!current.enabled || current.schedule_id !== scheduleId || current.status !== "running") return;
        const slot = automation.next_run ? new Date(automation.next_run) : new Date();
        const after = new Date(Math.max(Date.now(), slot.getTime()));
        const rearmed = await this.arm(updated, after);
        if (lastError && rearmed.enabled) await this.repo.update(automation.id, { status: "failed" });
      });
      await this.repo.pruneRuns();
    } finally {
      this.activeRuns.delete(scheduleId);
    }
  }

  /**
   * Makes sure every enabled automation has a live SDK schedule. Recovers from
   * interrupted runs and lost schedules; a recently missed run executes once.
   */
  async reconcile(): Promise<{ repaired: number }> {
    let repaired = 0;
    for (const item of await this.repo.list()) {
      await this.repo.withLock(item.id, async () => {
        const a = await this.repo.get(item.id);
        if (!a?.enabled || (a.schedule_id && this.activeRuns.has(a.schedule_id))) return;
        const alive = a.schedule_id ? await this.scheduler.exists(a.schedule_id) : false;
        if (alive && a.status !== "running") return;
        repaired++;
        if (a.schedule_id) await this.scheduler.cancel(a.schedule_id);
        const missedAt = a.next_run ? Date.parse(a.next_run) : NaN;
        if (!Number.isNaN(missedAt) && missedAt <= Date.now() && Date.now() - missedAt < MAX_CATCH_UP_MS) {
          const scheduleId = await this.scheduler.schedule(new Date(Date.now() + 1000), a.id);
          await this.repo.update(a.id, { schedule_id: scheduleId, status: "scheduled" });
        } else {
          await this.arm(a);
        }
      });
    }
    return { repaired };
  }
}
