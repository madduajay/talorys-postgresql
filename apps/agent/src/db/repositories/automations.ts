import {
  type Automation,
  type AutomationKind,
  type AutomationRun,
  type Notification,
  type ScheduleSpec,
  describeSchedule,
} from "@talorys/shared";
import { type Database, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";

interface AutomationRow extends Omit<Automation, "schedule" | "enabled" | "schedule_description"> {
  schedule: string;
  enabled: number;
}

function toAutomation(row: AutomationRow): Automation {
  const schedule = JSON.parse(row.schedule) as ScheduleSpec;
  return { ...row, schedule, enabled: row.enabled === 1, schedule_description: describeSchedule(schedule) };
}

export class AutomationRepository {
  constructor(private readonly db: Database) {}

  /** Serialize short state/scheduler transitions, never the automation execution. */
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(async () => {
      await this.db.run(`SELECT pg_advisory_xact_lock(1952541808, hashtext(?))`, id);
      return fn();
    });
  }

  async list(): Promise<Automation[]> {
    return (await this.db
      .all<AutomationRow>(`SELECT * FROM tal_automations ORDER BY enabled DESC, next_run IS NULL, next_run ASC, created_at DESC`))
      .map(toAutomation);
  }

  async get(id: string): Promise<Automation | null> {
    const row = await this.db.one<AutomationRow>(`SELECT * FROM tal_automations WHERE id = ?`, id);
    return row ? toAutomation(row) : null;
  }

  async require(id: string): Promise<Automation> {
    const a = await this.get(id);
    if (!a) throw new NotFoundError("Automation not found");
    return a;
  }

  async create(input: { name: string; kind: AutomationKind; message: string; schedule: ScheduleSpec; enabled: boolean }): Promise<Automation> {
    const ts = now();
    const id = newId();
    await this.db.run(
      `INSERT INTO tal_automations (id, name, kind, message, schedule, enabled, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.name, input.kind, input.message, JSON.stringify(input.schedule), input.enabled ? 1 : 0,
      input.enabled ? "scheduled" : "paused", ts, ts,
    );
    return await this.require(id);
  }

  async update(id: string, patch: Partial<Omit<Automation, "id" | "created_at" | "schedule_description">>): Promise<Automation> {
    return this.withLock(id, async () => {
      const existing = await this.require(id);
      const next = { ...existing, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Automation;
      await this.db.run(
        `UPDATE tal_automations SET name = ?, kind = ?, message = ?, schedule = ?, enabled = ?, status = ?, schedule_id = ?,
           next_run = ?, last_run = ?, last_result = ?, last_error = ?, run_count = ?, updated_at = ? WHERE id = ?`,
        next.name, next.kind, next.message, JSON.stringify(next.schedule), next.enabled ? 1 : 0, next.status,
        next.schedule_id, next.next_run, next.last_run, next.last_result, next.last_error, next.run_count, now(), id,
      );
      return await this.require(id);
    });
  }

  async delete(id: string): Promise<void> {
    await this.withLock(id, () => this.db.run(`DELETE FROM tal_automations WHERE id = ?`, id));
  }

  /** Claims a scheduled callback once, even when callbacks arrive concurrently. */
  async claimRun(automationId: string, scheduleId: string): Promise<Automation | null> {
    const row = await this.db.one<AutomationRow>(
      `UPDATE tal_automations SET status = 'running', updated_at = ?
       WHERE id = ? AND enabled = 1 AND schedule_id = ? AND status <> 'running'
       RETURNING *`,
      now(), automationId, scheduleId,
    );
    return row ? toAutomation(row) : null;
  }

  async startRun(automation: Automation): Promise<AutomationRun> {
    const run: AutomationRun = {
      id: newId(),
      automation_id: automation.id,
      automation_name: automation.name,
      started_at: now(),
      finished_at: null,
      status: "running",
      result: null,
      error: null,
    };
    await this.db.run(
      `INSERT INTO tal_automation_runs (id, automation_id, automation_name, started_at, status) VALUES (?, ?, ?, ?, ?)`,
      run.id, run.automation_id, run.automation_name, run.started_at, run.status,
    );
    return run;
  }

  async finishRun(runId: string, status: AutomationRun["status"], result: string | null, error: string | null): Promise<void> {
    await this.db.run(
      `UPDATE tal_automation_runs SET finished_at = ?, status = ?, result = ?, error = ? WHERE id = ?`,
      now(), status, result, error, runId,
    );
  }

  async runs(opts: { limit?: number; status?: string } = {}): Promise<AutomationRun[]> {
    if (opts.status) {
      return await this.db.all<AutomationRun>(
        `SELECT * FROM tal_automation_runs WHERE status = ? ORDER BY started_at DESC LIMIT ?`,
        opts.status, opts.limit ?? 50,
      );
    }
    return await this.db.all<AutomationRun>(`SELECT * FROM tal_automation_runs ORDER BY started_at DESC LIMIT ?`, opts.limit ?? 50);
  }

  /** Keeps the run history bounded. */
  async pruneRuns(keep = 500): Promise<void> {
    await this.db.run(
      `DELETE FROM tal_automation_runs WHERE id NOT IN (SELECT id FROM tal_automation_runs ORDER BY started_at DESC LIMIT ?)`,
      keep,
    );
  }
}

export class NotificationRepository {
  constructor(private readonly db: Database) {}

  async list(opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
    return await this.db.all<Notification>(
      `SELECT * FROM tal_notifications ${opts.unreadOnly ? "WHERE read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT ?`,
      opts.limit ?? 100,
    );
  }

  async unreadCount(): Promise<number> {
    return Number((await this.db.one<{ n: number | string }>(`SELECT count(*) AS n FROM tal_notifications WHERE read_at IS NULL`))?.n ?? 0);
  }

  async create(input: { title: string; body: string; automation_id?: string | null }): Promise<Notification> {
    const n: Notification = {
      id: newId(),
      title: input.title,
      body: input.body,
      automation_id: input.automation_id ?? null,
      read_at: null,
      created_at: now(),
    };
    await this.db.run(
      `INSERT INTO tal_notifications (id, title, body, automation_id, read_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)`,
      n.id, n.title, n.body, n.automation_id, n.created_at,
    );
    await this.db.run(
      `DELETE FROM tal_notifications WHERE id NOT IN (SELECT id FROM tal_notifications ORDER BY created_at DESC LIMIT 500)`,
    );
    return n;
  }

  async markRead(id?: string): Promise<void> {
    if (id) await this.db.run(`UPDATE tal_notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`, now(), id);
    else await this.db.run(`UPDATE tal_notifications SET read_at = ? WHERE read_at IS NULL`, now());
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM tal_notifications WHERE id = ?`, id);
  }
}
