# Talorys · PostgreSQL edition

A PostgreSQL-backed adaptation of [Talorys](https://github.com/rociiu/talorys),
the single-owner personal AI assistant. Chat, memories, tasks, notes, projects,
automations, sessions, settings and usage records live in PostgreSQL.
The React frontend, Cloudflare Workers API, Workers AI integration and
Cloudflare Agents SDK scheduler are retained.

**This is a source-based fork.** `npx create-talorys@latest` installs the
upstream SQLite edition, not this code. Build and run this checkout instead.
No database, Cloudflare deployment or npm publication is created by cloning it.

## Storage boundary

- **PostgreSQL:** application records and transactional application migrations.
- **Cloudflare Durable Object:** the Agents SDK's internal state and alarms.
  Its SQLite-backed namespace remains required; this is not a Cloudflare-free
  or entirely SQLite-free rewrite.
- **Local development:** direct `DATABASE_URL`.
- **Production:** a `HYPERDRIVE` binding to a separately provisioned PostgreSQL
  database, with Hyperdrive query caching disabled.

Use a dedicated PostgreSQL database for each deployment. This is a single-owner
app with a fixed `personal-agent` instance, not a shared multi-tenant database.
Database hosting and Hyperdrive have their own costs and requirements; the
upstream all-free deployment promise does not apply to this edition.

## Run locally

Requirements: Node.js 22+, npm and Docker Compose (or an existing PostgreSQL 17
server).

```bash
npm ci
npm run setup:local
docker compose up -d --wait
npm run dev
```

Setup generates unique database and app-login passwords in git-ignored `.env`,
plus private Worker secrets in `apps/agent/.dev.vars`. Compose requires the
`POSTGRES_PASSWORD` value; no known password is built in. Keep both files private.
To use your own server, set `DATABASE_URL` before initial setup. Existing Worker
secrets are preserved unless you explicitly run `npm run setup:local -- --force`.

Open http://localhost:5173 and use `TALORYS_DEV_PASSWORD` from your `.env` file
(or the environment value you supplied). Mock AI is enabled locally, and
application migrations run automatically.

PostgreSQL data persists in the Compose volume. SDK scheduling state persists
in `.wrangler/state`. `docker compose down` retains the database volume;
`docker compose down -v` destroys it.

See [development](docs/development.md) for tests and configuration and
[architecture](docs/architecture.md) for implementation details.

## Production setup

1. Provision a dedicated PostgreSQL database and credentials for this deployment.
2. Create a Cloudflare Hyperdrive configuration pointing to it. Disable query
   caching, since authentication, sessions and mutable application records
   require current reads.
3. Build this fork with `npm run build`.
4. Run the built installer from the directory where you want its deployment
   artifacts, using an absolute path to this checkout's CLI:

   ```bash
   node /absolute/path/to/talorys-postgresql/packages/create-talorys/dist/cli.js --hyperdrive-id YOUR_HYPERDRIVE_ID
   ```

   `TALORYS_HYPERDRIVE_ID` is an alternative to the flag. The installer records
   the binding ID in its manifest. It does not provision PostgreSQL or create
   the Hyperdrive configuration for you.

Review [deployment](docs/deployment.md) before deploying. Keep database
credentials out of Git; use the Hyperdrive configuration for production
connection credentials. A dry-run build does not deploy anything.

## Moving from upstream SQLite

There is **no automatic SQLite-to-PostgreSQL conversion**. Do not simply replace
a running upstream installation and assume its records have moved.

1. Export a backup from the old app's **Settings → Privacy → Download backup**.
2. Keep the original deployment and backup intact.
3. Install this fork into a fresh deployment with its own PostgreSQL database.
4. Pause old automations before importing. Import re-arms enabled automations,
   so running both deployments can cause duplicate reminders. For a staged
   migration, pause automations before making the final export.
5. Import the backup in the new app; verify record counts and representative
   conversations, tasks, memories and notes. Review the imported automations
   before re-enabling paused schedules.

The portable backup excludes credentials and sessions. Sign in with the new
installation's password. Back up PostgreSQL independently; a logical app export
is not a complete database/SDK disaster-recovery snapshot.

## Checks

Create a disposable database whose name ends in `_test`. Tests reset application
tables there. Never use a database containing information you want to keep.

```bash
docker compose exec postgres createdb -U talorys talorys_test
docker compose exec postgres createdb -U talorys talorys_e2e
npm run lint
npm run typecheck
npm test
npm run build
npm run test:pack
npx playwright install chromium
npm run test:e2e
```

The E2E stack requires a separate disposable database ending in `_e2e`, set
through `TALORYS_E2E_DATABASE_URL`. It resets application tables before running.
Setup generates local test URLs in `.env`; the test runners load that file without printing its credentials. For an external database, explicitly supply both test URLs. CI generates fresh credentials and provisions separate integration and E2E databases. Neither test URL should
ever point at owner data.

## Provenance and license

Based on [rociiu/talorys](https://github.com/rociiu/talorys), source commit
[`374735b5a2a2385b6506e9e6612a7a37488c15b7`](https://github.com/rociiu/talorys/commit/374735b5a2a2385b6506e9e6612a7a37488c15b7).
The upstream README is archived, with obsolete local credential instructions removed, in
[docs/README.upstream.md](docs/README.upstream.md) for provenance; its storage,
free-tier and published-package instructions describe upstream, not this fork.

[MIT license](LICENSE). Original Talorys contributor notices are retained.

## Verification

See [verification results and remaining limits](docs/verification.md) for local test coverage.
