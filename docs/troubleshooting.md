# Troubleshooting

Start with:

```bash
node /absolute/path/to/talorys-postgresql/packages/create-talorys/dist/cli.js doctor
```

## Installation

**The browser login does not open / times out.** Copy the URL Wrangler prints
into a browser. In SSH or containers, set `CLOUDFLARE_API_TOKEN` instead.

**"Multiple Cloudflare accounts are available."** Pass `--account-id <id>` in
non-interactive mode.

**"…lacks a required permission."** You need to be able to edit Workers and
Pages in the chosen account (see [deployment.md](deployment.md#permissions)).

**"The deployment did not pass its health checks yet."** New `pages.dev` sites
can take a few minutes to get DNS and certificates. Re-run the same command;
it resumes without duplicating anything.

**"…already exists and is not a Talorys installation."** Choose another
directory with `--dir`. The installer never overwrites unrelated folders.

**"SQLite-backed Durable Objects are not available."** Check the account's
Workers settings. The Agents SDK still requires a SQLite-backed Durable Object,
even though application records now use PostgreSQL.

## Using Talorys

**"Your Cloudflare account has used its Workers AI allocation for today."**
The daily free Neuron allocation is exhausted. Chat resumes after the reset;
tasks, notes, memories and reminders keep working. Exact usage is in the
Cloudflare dashboard (Workers AI).

**"Talorys reached its daily limit of N AI requests."** That's Talorys' own
guardrail; raise it in Settings → AI.

**"Too many failed attempts."** Wait 15 minutes, or reset the password with
the built fork CLI with `reset-password`.

**Reminders fire at the wrong time.** Check Settings → General → Timezone.
Changing it re-schedules all automations.

**"The configured AI model is not available."** Set a supported Workers AI
model with tool calling in Settings → AI (default `@cf/zai-org/glm-4.7-flash`).

## Development

**`database is locked: SQLITE_BUSY`** — two local runtimes share a state
directory. Stop stray `wrangler` processes; the dev scripts use separate
directories for the Worker and Pages.

**Port already in use** — stop other dev servers on 5173, 8787 or 8788.


## PostgreSQL

**Database connection refused** — start PostgreSQL (`docker compose up -d --wait`)
and check `DATABASE_URL` in `apps/agent/.dev.vars`. An existing `.dev.vars` is
preserved by setup, so changing a shell variable alone may not change it.

**Missing Hyperdrive binding** — use the built fork installer with
`--hyperdrive-id <id>` or `TALORYS_HYPERDRIVE_ID`; confirm the generated Worker has
`HYPERDRIVE`. Do not use the upstream npm installer.

**Stale reads or sessions** — verify Hyperdrive query caching is disabled on the
configuration used by this deployment.

**Migration permissions error** — the database role needs permission to create
and update application tables/indexes. Do not delete migration history to force
startup. Back up the database before attempting schema repairs.

**Existing records appear missing after changing engines** — SQLite records
were not automatically moved. Export from the original app and import into the
fresh PostgreSQL deployment. Preserve the old deployment until verified.

**Tests refuse the database URL** — set `TALORYS_TEST_DATABASE_URL` to a dedicated,
disposable database whose name ends in `_test`. Tests reset application tables;
never rename or point them at owner data just to bypass the guard. E2E similarly
requires `TALORYS_E2E_DATABASE_URL` with a database name ending in `_e2e`.

**PostgreSQL port already in use** — stop the conflicting local database or
change the Compose host port and `DATABASE_URL`/test URLs consistently.
