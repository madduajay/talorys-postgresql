import type { Limits, UsageCounters } from "@talorys/shared";
import type { Database } from "../db/database";

type Counter = "ai_requests" | "input_tokens" | "output_tokens" | "tool_calls" | "scheduled_ai_runs" | "ai_errors";

/**
 * Local, application-measured usage. These are estimates made by Talorys, not
 * Cloudflare's billing figures; exact Neuron usage lives in the Cloudflare dashboard.
 */
export class UsageService {
  constructor(private readonly db: Database) {}

  static day(date = new Date()): string {
    return date.toISOString().slice(0, 10);
  }

  async increment(counters: Partial<Record<Counter, number>>, date = new Date()): Promise<void> {
    const day = UsageService.day(date);
    // One upsert keeps a request's counters consistent and avoids a connection per counter.
    await this.db.run(
      `INSERT INTO tal_usage_daily (day, ai_requests, input_tokens, output_tokens, tool_calls, scheduled_ai_runs, ai_errors)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         ai_requests = tal_usage_daily.ai_requests + excluded.ai_requests,
         input_tokens = tal_usage_daily.input_tokens + excluded.input_tokens,
         output_tokens = tal_usage_daily.output_tokens + excluded.output_tokens,
         tool_calls = tal_usage_daily.tool_calls + excluded.tool_calls,
         scheduled_ai_runs = tal_usage_daily.scheduled_ai_runs + excluded.scheduled_ai_runs,
         ai_errors = tal_usage_daily.ai_errors + excluded.ai_errors`,
      day,
      Math.round(counters.ai_requests ?? 0),
      Math.round(counters.input_tokens ?? 0),
      Math.round(counters.output_tokens ?? 0),
      Math.round(counters.tool_calls ?? 0),
      Math.round(counters.scheduled_ai_runs ?? 0),
      Math.round(counters.ai_errors ?? 0),
    );
  }

  async today(): Promise<UsageCounters> {
    return await this.sum(UsageService.day(), UsageService.day());
  }

  async lastDays(days: number): Promise<UsageCounters> {
    const start = new Date(Date.now() - (days - 1) * 86400_000);
    return await this.sum(UsageService.day(start), UsageService.day());
  }

  private async sum(from: string, to: string): Promise<UsageCounters> {
    const row = await this.db.one<Record<string, number | string | null>>(
      `SELECT sum(ai_requests) AS ai_requests, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
              sum(tool_calls) AS tool_calls, sum(scheduled_ai_runs) AS scheduled_ai_runs, sum(ai_errors) AS ai_errors
       FROM tal_usage_daily WHERE day >= ? AND day <= ?`,
      from, to,
    );
    return {
      ai_requests: Number(row?.ai_requests ?? 0),
      input_tokens_estimate: Number(row?.input_tokens ?? 0),
      output_tokens_estimate: Number(row?.output_tokens ?? 0),
      tool_calls: Number(row?.tool_calls ?? 0),
      scheduled_ai_runs: Number(row?.scheduled_ai_runs ?? 0),
      ai_errors: Number(row?.ai_errors ?? 0),
    };
  }

  async canUseAi(limits: Limits): Promise<boolean> {
    return (await this.today()).ai_requests < limits.maxAiRequestsPerDay;
  }

  async canRunScheduledAi(limits: Limits): Promise<boolean> {
    const today = await this.today();
    return today.scheduled_ai_runs < limits.maxScheduledAiRunsPerDay && today.ai_requests < limits.maxAiRequestsPerDay;
  }
}

export class ActivityLog {
  constructor(private readonly db: Database) {}

  async record(type: string, summary: string): Promise<void> {
    await this.db.run(
      `INSERT INTO tal_activity (id, type, summary, created_at) VALUES (?, ?, ?, ?)`,
      crypto.randomUUID(), type, summary.slice(0, 500), new Date().toISOString(),
    );
    await this.db.run(`DELETE FROM tal_activity WHERE id NOT IN (SELECT id FROM tal_activity ORDER BY created_at DESC LIMIT 1000)`);
  }

  async list(limit = 50): Promise<{ id: string; type: string; summary: string; created_at: string }[]> {
    return await this.db.all(`SELECT * FROM tal_activity ORDER BY created_at DESC LIMIT ?`, limit);
  }
}
