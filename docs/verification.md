# PostgreSQL migration verification

Verified locally on 2026-10-11 against the source fork of upstream commit
`374735b5a2a2385b6506e9e6612a7a37488c15b7`.

## Checks

- Monorepo TypeScript checks: passed
- Biome lint: passed
- Full build (web, private Worker, installer templates): passed
- Generated production Worker and Pages Function compilation through real Wrangler dry-runs: passed
- Shared package tests: 14 passed
- Web unit tests: 3 passed
- Installer tests: 35 passed
- Package test: local tarball installs outside the monorepo; simulated deployment, repeated-install idempotency, and status command passed
- Compiled-stack HTTP smoke: 58 assertions across 36 actual API requests passed through Vite → real Pages Function → service binding → built Agent → PostgreSQL. This included secret-free export, repeated import, invalid-import rollback, and an actual scheduled Durable Object reminder alarm recorded exactly once.
- Local credential setup tests: 4 passed (randomness, private file permissions, no secret logging, idempotence, explicit URL isolation, and password URL encoding)
- Agent Node unit tests: 23 passed
- Real PostgreSQL/Cloudflare Workers integration tests: 80 passed, including 8 deterministic authentication/scheduling concurrency regressions

Total automated unit/integration/installer tests: **159 passed**, plus the packaged CLI and compiled-stack HTTP smoke checks.

Real integration tests use PostgreSQL 18.4, not an in-memory SQLite substitute.
CI and Docker Compose are configured for PostgreSQL 17; that exact version was
not run in this workspace. Tests cover authentication, rate limiting, sessions,
tasks, projects, memories, notes, PostgreSQL full-text search, escaped search,
message ordering, chat/tools, backups, rollback, migrations, scheduling, and
concurrent callback claims.

## Limits and warnings

- Browser end-to-end assertions could not run in this workspace. Wrangler's dev
  server encounters unavailable network-interface enumeration, and Chromium
  aborts before page launch because its process-singleton socket is not permitted.
  The Playwright suite and isolated PostgreSQL E2E setup remain included for a
  normal development machine or GitHub Actions.
- The Workers integration runner prints workerd request-stream-after-response
  exceptions on some teardown paths while all assertions pass and the process
  exits successfully. The cause has not been established; these warnings are not
  represented as a clean runtime log.
- No live Cloudflare deployment, production Hyperdrive connection, paid database,
  or real Workers AI call was created or verified. AI behavior was tested with
  the deterministic mock provider.
- Existing SQLite application data is not automatically copied. Follow the
  documented fresh-deployment export/import procedure.

Application data resides in PostgreSQL. The Cloudflare Agents SDK still requires
its own SQLite-backed Durable Object for runtime state and schedules.

## Public-source credential hardening

Local setup and CI generate fresh database and app-login credentials instead of
shipping a known default. Compose requires `POSTGRES_PASSWORD`; generated values
live only in ignored, owner-readable `.env` and `.dev.vars` files and are not
printed. Explicit external database URLs never infer destructive test targets.
The PostgreSQL suite was rerun with generated test credentials. Compose/CI YAML
parsing and Playwright test discovery were checked; Docker is unavailable in this
workspace, so the revised Docker Compose CI startup itself was not run here.

After credential hardening: the 4 setup tests, 23 agent unit tests, 80 real
PostgreSQL integration tests, full monorepo typecheck, lint, and 14-test Playwright
discovery passed again. The application and installer implementation were unchanged
in this follow-up; their prior build, installer/package, shared, web, and compiled
HTTP smoke results remain applicable.
