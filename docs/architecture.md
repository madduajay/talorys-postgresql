# Architecture

## Components

| Component | Location | Runs on |
| --- | --- | --- |
| Web app (React, Vite, Tailwind, TanStack Query, React Router) | `apps/web/src` | Cloudflare Pages (static) |
| API proxy | `apps/web/functions/api/[[path]].ts` | Pages Function |
| Agent Worker (Hono API + `TalorysAgent`) | `apps/agent/src` | Cloudflare Workers + Durable Objects |
| Shared schemas, recurrence, crypto | `packages/shared` | Bundled into all of the above |
| Installer | `packages/create-talorys` | The owner's machine (Node.js) |

## Request flow

1. The browser loads static assets from `https://<project>.pages.dev`.
2. Calls to `/api/*` (same origin, cookie auth) invoke the Pages Function.
3. The function forwards the **original request** to `env.AGENT.fetch(request)` —
   a service binding to the private Worker. URL, method, headers and body are
   preserved, so the Worker can validate `Origin`. Responses (including SSE
   streams) are returned without buffering.
4. The Worker forwards `/api/*` to `getAgentByName(env.TalorysAgent, "personal-agent")`.
   The instance name is fixed server-side; clients cannot address other agents.
   WebSocket upgrades are refused (the app uses HTTP + SSE only).
5. `TalorysAgent.onRequest` runs the Hono app and accesses application records in PostgreSQL.

## TalorysAgent

`apps/agent/src/agent/talorys-agent.ts` extends the Agents SDK `Agent` class.

- **Application storage**: PostgreSQL through the asynchronous `pg` driver,
  wrapped by `db/database.ts` and repositories in `db/repositories/`.
  `createServices(env, scheduler)` receives connection configuration from the
  Worker environment instead of Durable Object storage.
- **Connection configuration**: local development uses `DATABASE_URL`;
  production uses `env.HYPERDRIVE.connectionString`. Query caching must be
  disabled on the Hyperdrive configuration. Each deployment needs its own
  database: table names and the single-owner instance are not tenant-scoped.
- **SDK storage**: the Cloudflare Agents SDK retains its Durable Object SQLite
  tables and alarms. They are not converted to PostgreSQL. Wrangler's
  `new_sqlite_classes` migration remains intentional.
- **Application migrations**: `db/migrations.ts` contains append-only PostgreSQL
  schema migrations. Initialization applies pending migrations transactionally,
  with a PostgreSQL advisory lock to serialize migration attempts.
- **Full-text search**: PostgreSQL `tsvector`/`tsquery` search for memories and
  notes, backed by GIN indexes; escaped `ILIKE` handles substring fallback and
  other entity searches. This replaces SQLite FTS5.
- **Scheduling**: each enabled automation owns exactly one pending one-shot SDK
  schedule (`this.schedule(date, "runAutomation", { automationId })`). When it
  fires, `AutomationService.fire` runs it, records the run, and computes the next
  occurrence in the owner's timezone. `onStart` reconciles lost or interrupted
  schedules (a run missed by < 24 h executes once).
- **Agent turns**: `agent/runner.ts` builds context (system prompt, relevant
  memories, running summary, recent history within the token budget), calls the
  provider with tools, streams events, persists the result and records usage.

## AI provider abstraction

`ai/provider.ts` defines `AIProvider` (`generate`, `stream`, `generateWithTools`).

- `CloudflareWorkersAIProvider` (`ai/workers-ai.ts`) uses the AI SDK with the
  official `workers-ai-provider`. Reasoning ("thinking") is disabled to save
  Neurons. On the final allowed step, or once the tool budget is spent,
  `toolChoice: "none"` forces a text answer.
- `MockAIProvider` (`ai/mock.ts`) is deterministic, used for local development,
  tests and the opt-in Demo mode. It routes simple intents through the real tool
  pipeline.

Adding a provider (OpenRouter, Gemini, …) means implementing `AIProvider` and
selecting it in `TalorysAgent.aiProvider()`.

## Tools

Tools live in `apps/agent/src/tools/` and are registered in `tools/index.ts`.
Each has a unique name, description, Zod input schema, permission
(`read` | `write` | `destructive`), per-turn cap, UI label and typed result.
`ToolExecutor` enforces validation, the global call budget, per-tool caps,
duplicate-call (loop) detection, explicit confirmation for destructive actions,
and read-only access for scheduled runs. Tools only use the service layer — no
shell, code execution, network or credentials.

## Data model

`tal_settings`, `tal_conversations`, `tal_messages`, `tal_memories`,
`tal_projects`, `tal_tasks`, `tal_notes`, `tal_automations`,
`tal_automation_runs`, `tal_notifications`, `tal_activity`, `tal_sessions`,
`tal_login_attempts`, `tal_usage_daily`, plus application schema-version state.
Search vectors/indexes are in PostgreSQL rather than separate SQLite FTS tables.

## Deployment and consistency boundary

The frontend and API stay on Cloudflare. PostgreSQL is a separate dependency,
accessed through Hyperdrive in production. This fork does not provision a
PostgreSQL provider or promise the upstream all-free deployment model.

Application transactions commit in PostgreSQL. SDK schedule registration lives
in Durable Object storage, so these two systems do not share an atomic
transaction. Startup reconciliation and automation status are important after
failures; avoid running old and new deployments' schedules simultaneously during
migration. Back up the application database and account for SDK scheduling state
when planning disaster recovery.

A SQLite upstream installation requires an explicit app export/import into a
fresh PostgreSQL deployment. No automatic cross-engine migration is performed.
