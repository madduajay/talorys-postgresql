import { Agent } from "agents";
import { type Automation, type HealthReport, TALORYS_VERSION } from "@talorys/shared";
import type { Env } from "../env";
import { migrate } from "../db/migrations";
import { createServices, type Services } from "../services/container";
import type { Scheduler } from "./scheduling";
import { AgentRunner } from "./runner";
import { createApi } from "../api/app";
import { CloudflareWorkersAIProvider } from "../ai/workers-ai";
import { MockAIProvider } from "../ai/mock";
import type { AIProvider } from "../ai/provider";
import { localDayBounds, formatLocal } from "../services/time";

interface AgentState {
  /** Unread notifications, kept in agent state for cheap polling. */
  unread: number;
}

interface AutomationPayload {
  automationId: string;
}

const api = createApi();

/**
 * The owner's personal agent. Exactly one instance exists per deployment
 * ("personal-agent"). Application data lives in PostgreSQL; the Durable Object
 * still owns Agents SDK state and scheduling.
 */
export class TalorysAgent extends Agent<Env, AgentState> {
  override initialState: AgentState = { unread: 0 };

  private _services: Services | null = null;
  private _ready: Promise<void> | null = null;
  /** In-flight chat turns by conversation, for cancellation. */
  readonly activeRuns = new Map<string, AbortController>();

  get services(): Services {
    if (!this._services) {
      const scheduler: Scheduler = {
        schedule: async (at, automationId) => {
          const s = await this.schedule<AutomationPayload>(at, "runAutomation", { automationId });
          return s.id;
        },
        cancel: async (id) => {
          await this.cancelSchedule(id);
        },
        exists: async (id) => (await this.getScheduleById(id)) !== undefined,
      };
      this._services = createServices(this.env, scheduler);
    }
    return this._services;
  }

  /** Share initialization across concurrent requests; a failed connection can retry. */
  async ensureReady(): Promise<void> {
    if (!this._ready) {
      this._ready = (async () => {
        const services = this.services;
        await migrate(services.db);
        // Also recover schedules when initialization succeeds after a transient startup outage.
        try {
          const { repaired } = await services.automations.reconcile();
          if (repaired > 0) await services.activity.record("automation.reconciled", `Recovered ${repaired} schedule(s) after restart`);
        } catch {
          console.error("Schedule reconciliation failed.");
        }
      })().catch((error) => {
        this._ready = null;
        throw error;
      });
    }
    await this._ready;
  }

  override async onStart(): Promise<void> {
    try {
      await this.ensureReady();
    } catch {
      // Do not poison SDK startup after a temporary database outage or log connection secrets.
      console.error("Agent storage initialization failed; a later request can retry.");
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    try {
      await this.ensureReady();
    } catch {
      const headers = {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "same-origin",
        "retry-after": "5",
      };
      if (request.method === "GET" && new URL(request.url).pathname.replace(/\/$/, "") === "/api/health") {
        const report: HealthReport = {
          ok: false,
          version: TALORYS_VERSION,
          storage: "error",
          schema_version: 0,
          configured: {
            password: !!this.env.OWNER_PASSWORD_HASH,
            session_secret: (this.env.SESSION_SECRET?.length ?? 0) >= 32,
          },
          ai_binding: !!this.env.AI,
          time: new Date().toISOString(),
        };
        return Response.json(report, { status: 503, headers });
      }
      return Response.json({ error: { code: "NOT_CONFIGURED", message: "Application storage is temporarily unavailable. Please try again shortly." } }, { status: 503, headers });
    }
    return api.fetch(request, { agent: this, env: this.env });
  }

  /**
   * Talorys has no sub-agents. Without this, the SDK forwards any `/sub/{class}/{name}/...`
   * request to a fresh facet with its own empty database, bypassing login rate limits.
   */
  override async onBeforeSubAgent(): Promise<Response> {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  }

  /** Chooses the AI provider. The mock is only used in local development or explicit demo mode. */
  async aiProvider(): Promise<AIProvider | null> {
    await this.ensureReady();
    const settings = await this.services.settings.get();
    if (settings.demoMode) return new MockAIProvider();
    if (this.env.TALORYS_ENV === "development" && this.env.TALORYS_MOCK_AI === "1") return new MockAIProvider();
    if (!this.env.AI) return null;
    return new CloudflareWorkersAIProvider(this.env.AI, settings.model);
  }

  async runner(): Promise<AgentRunner> {
    return new AgentRunner(this.services, await this.aiProvider());
  }

  async refreshUnread(): Promise<void> {
    await this.ensureReady();
    const unread = await this.services.notifications.unreadCount();
    if (unread !== this.state.unread) this.setState({ unread });
  }

  /** Scheduled callback invoked by the Agents SDK (Durable Object alarm). */
  async runAutomation(payload: AutomationPayload, schedule: { id: string }): Promise<void> {
    await this.ensureReady();
    await this.services.automations.fire(payload.automationId, schedule.id, (a) => this.executeAutomation(a));
    await this.refreshUnread();
  }

  private async executeAutomation(a: Automation): Promise<{ status: "success" | "skipped"; result: string }> {
    const s = this.services;
    const settings = await s.settings.get();
    switch (a.kind) {
      case "reminder": {
        // Simple reminders never use AI.
        await s.notifications.create({ title: "Reminder", body: a.message || a.name, automation_id: a.id });
        return { status: "success", result: "Reminder delivered" };
      }
      case "task_digest": {
        const bounds = localDayBounds(settings.timezone);
        const overdue = await s.tasks.list({ view: "overdue", limit: 20 });
        const today = (await s.tasks.list({ view: "today", dayStart: bounds.start, dayEnd: bounds.end, limit: 20 })).filter(
          (t) => !overdue.some((o) => o.id === t.id),
        );
        const open = (await s.tasks.list({ status: "open", limit: 200 })).length;
        const line = (t: { title: string; due_at: string | null; priority: string }) =>
          `- ${t.title}${t.due_at ? ` (due ${formatLocal(t.due_at, settings.timezone)})` : ""}${t.priority === "high" || t.priority === "urgent" ? ` · ${t.priority}` : ""}`;
        const parts = [
          overdue.length ? `**Overdue (${overdue.length})**\n${overdue.map(line).join("\n")}` : "",
          today.length ? `**Due today (${today.length})**\n${today.map(line).join("\n")}` : "",
          `${open} open task(s) in total.`,
        ].filter(Boolean);
        if (a.message) parts.unshift(a.message);
        await s.notifications.create({ title: a.name, body: parts.join("\n\n"), automation_id: a.id });
        return { status: "success", result: `${overdue.length} overdue, ${today.length} due today` };
      }
      case "agent_prompt": {
        if (!(await s.usage.canRunScheduledAi(settings.limits))) {
          await s.notifications.create({
            title: a.name,
            body: "Skipped: the daily budget for scheduled AI runs was reached. Adjust it in Settings → AI.",
            automation_id: a.id,
          });
          return { status: "skipped", result: "Scheduled AI budget reached" };
        }
        const text = await (await this.runner()).runScheduledPrompt(a.message);
        await s.notifications.create({ title: a.name, body: text, automation_id: a.id });
        return { status: "success", result: text.slice(0, 300) };
      }
    }
  }
}
