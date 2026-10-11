# Development

Requirements: Node.js 22+, npm and PostgreSQL 17. Docker Compose supplies a
local database; an existing server is also fine.

```bash
npm ci
npm run setup:local
docker compose up -d --wait
npm run dev
```

| Process | Port | Purpose |
| --- | --- | --- |
| PostgreSQL | 5432 | Application records; persistent Docker volume |
| `wrangler dev --local` (apps/agent) | 8787 | Worker and Agents SDK Durable Object |
| `wrangler pages dev` (apps/web) | 8788 | Pages Function and `AGENT` service binding |
| Vite | 5173 | UI with HMR; proxies `/api` to 8788 |

`npm run setup:local` generates random local PostgreSQL and app-login passwords
in git-ignored `.env`, plus `apps/agent/.dev.vars`. Both files are owner-readable
only. The generated database URL connects to local port 5432 and database
`talorys`; no fixed password is built in or printed. Read `TALORYS_DEV_PASSWORD`
from your private `.env` to sign in. You may supply `POSTGRES_PASSWORD`,
`TALORYS_DEV_PASSWORD`, or `DATABASE_URL` yourself before setup.

Existing `.dev.vars` is preserved. Use `npm run setup:local -- --force` only when
you intend to regenerate Worker secrets. PostgreSQL volumes retain their original
password: changing `.env` does not rotate an existing database password. Keep the
original database credential when reusing a volume. Never commit either secret file.

For generated local settings, setup also writes dedicated `_test` and `_e2e`
connection URLs to `.env`; test runners load them automatically. An explicitly
supplied external `DATABASE_URL` is never used to infer a destructive test target:
provide `TALORYS_TEST_DATABASE_URL` and `TALORYS_E2E_DATABASE_URL` separately.

Application schema migrations run automatically during service initialization.
PostgreSQL must already be reachable and the database role must be able to create
and update Talorys tables/indexes. The app does not create the database itself.

The Docker volume holds application data; `.wrangler/state` holds SDK state.
`docker compose down` keeps the volume. Adding `-v` permanently deletes it.
Use independently managed credentials for production.

## Tests and checks

The agent integration suite uses a real, disposable PostgreSQL database. Its
name must end in `_test`; tests reset application tables and must never point at
an owner's database. Create it once:

```bash
docker compose exec postgres createdb -U talorys talorys_test
npm test
```

If `createdb` says the database already exists, reuse it only if it is already
your disposable test database. The `_test` suffix check is a guardrail, not a
backup or permission boundary.

| Script | What it does |
| --- | --- |
| `npm run build` | Web build, Worker dry-run bundle, fork CLI and templates |
| `npm test` | Shared, agent unit/integration (real PostgreSQL), Pages Function and installer tests |
| `npm run test:e2e` | Playwright UI tests against the local stack |
| `npm run test:pack` | Packs the fork installer and checks it outside the monorepo |
| `npm run typecheck` | TypeScript across workspaces |
| `npm run lint` | Biome checks |

E2E requires its own disposable database with a name ending in `_e2e`:

```bash
docker compose exec postgres createdb -U talorys talorys_e2e
npx playwright install chromium
npm run test:e2e
```

E2E resets application tables before starting, uses local mock AI and isolates
its Worker configuration/secrets under ignored `.wrangler` storage. Never point
it at owner data. Application schema-version history is retained between runs.

CI generates fresh credentials and starts PostgreSQL through Docker Compose and keeps agent integration data in
`talorys_test`, separate from the E2E `talorys_e2e` database. No Cloudflare deployment is
needed for local checks. Real-account smoke tests are optional and require
separate Cloudflare/Hyperdrive configuration; they are not a substitute for the
local PostgreSQL suite.

## Real Workers AI locally

```bash
npx wrangler login
npm run dev:remote-ai -w @talorys/agent
```

Use that command instead of `dev:agent`, alongside Pages and Vite. Database
access remains separate from AI access.

## Adding a tool or migration

1. Create `apps/agent/src/tools/<name>.ts` with `defineTool({...})` entries.
2. Register them in `apps/agent/src/tools/index.ts`.
3. Add tests in `apps/agent/test/`.

Repositories and services are asynchronous. Await reads, mutations and
transactions, including tool execution and scheduler callbacks.

Append PostgreSQL migrations in `apps/agent/src/db/migrations.ts` with the next
version. Never edit previously applied entries or silently discard owner data.
Application migrations are independent of Wrangler's Durable Object class
migrations; keep the SDK namespace migration in place.

## Mock AI intents

`remember …`, `add task …`, `add note …`, `complete task …`, `list tasks`,
`remind me in N minutes to …`, `search …`. Other input gets an echo reply.
