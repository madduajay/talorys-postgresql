# Deploying the PostgreSQL edition

Use the CLI built from this checkout. The public `create-talorys@latest` npm
package is upstream and does not install this PostgreSQL fork.

## Prerequisites

- A Cloudflare account able to run the Worker, Pages, Workers AI, Hyperdrive and
  the SQLite-backed Agents SDK Durable Object.
- A dedicated PostgreSQL database for this installation, reachable by
  Hyperdrive, with credentials allowed to apply Talorys schema migrations.
- A Hyperdrive configuration pointing to that database, **with query caching
  disabled**. Create and check this configuration before running the installer.
  See [Cloudflare's Hyperdrive documentation](https://developers.cloudflare.com/hyperdrive/).
- Node.js 22+ and a built checkout (`npm ci && npm run build`).

Database hosting, networking, backups and Hyperdrive configuration are the
operator's responsibility. The installer neither creates a PostgreSQL database
nor disables Hyperdrive caching for you. Check provider quotas and pricing;
upstream's all-free claim is not a guarantee for this edition.

## Install from this checkout

From the directory where you want deployment artifacts:

```bash
node /absolute/path/to/talorys-postgresql/packages/create-talorys/dist/cli.js --hyperdrive-id YOUR_HYPERDRIVE_ID
```

Alternatively set `TALORYS_HYPERDRIVE_ID`. The CLI uses its bundled Wrangler,
asks for Cloudflare account and owner settings, and creates the private Worker
and Pages frontend. The manifest records the Hyperdrive ID, not PostgreSQL
credentials. Keep the generated installation directory for later management.

The generated Worker configuration binds Hyperdrive as `HYPERDRIVE`, retains
`nodejs_compat`, and keeps the `TalorysAgent` Durable Object binding and
`new_sqlite_classes` migration. SQLite is still needed for Agents SDK internals
and alarms. Application tables are created in PostgreSQL on initialization.

The Worker has `workers_dev: false` and `preview_urls: false`; Pages connects
through the `AGENT` service binding. Authentication remains enforced in the
Worker. Never expose PostgreSQL directly to the browser.

## Secrets and database isolation

Store production database credentials in the Hyperdrive configuration, not
source-controlled Wrangler variables. Use TLS and the database provider's
recommended network controls. Use a separate database for every production,
staging and developer installation. The single-owner schema does not provide
multi-tenant isolation within one database.

`OWNER_PASSWORD_HASH` and `SESSION_SECRET` remain Worker secrets. Local
`DATABASE_URL` belongs in the ignored `.dev.vars` file; local Compose credentials
are unsuitable for production. Disable Hyperdrive query caching so auth/session
revocation, settings and recently changed records are read consistently.

## Existing SQLite installations

Do not update an upstream SQLite installation in place. Export the original
app's backup, keep that installation intact, create a fresh PostgreSQL deployment
and import there. Pause old automations before importing: import re-arms enabled
automations, and running both deployments can cause duplicate reminders. For a
staged migration, pause automations before making the final export, then review
and re-enable them in the new app after validating the imported records. Sessions and credentials are intentionally not portable in the backup.
The fork installer guards against reusing an upstream manifest.

## Updates and recovery

Use the same built fork CLI and existing PostgreSQL installation directory for
`update`, `status`, `doctor` and `reset-password`. For example:

```bash
node /absolute/path/to/talorys-postgresql/packages/create-talorys/dist/cli.js doctor
```

Review changes and take a PostgreSQL backup before updates. Application schema
migrations are versioned and transactional. Durable Object identity must also
remain stable because it owns SDK scheduling state. A database outage prevents
application reads and writes; SDK persistence does not act as an application
database fallback.

## Permissions

The upstream installer uses Wrangler login or a scoped Cloudflare API token.
Workers Scripts:Edit, Cloudflare Pages:Edit, Workers AI:Read and Account
Settings:Read are needed for the deployment workflow. Hyperdrive provisioning
and access may require additional permissions; consult the current Cloudflare
settings for your chosen workflow. A Global API Key is not necessary.

## Scope of build and verification

`npm run build` bundles artifacts and runs a Worker dry run; it does not publish
npm packages or deploy a live app. Local tests use real PostgreSQL plus local
Cloudflare emulation. A successful local build does not establish that your
production database credentials, Hyperdrive caching or live deployment work.
Verify the live health/auth flows and a write/read cycle after an authorized
deployment, then check reminder scheduling.


## Optional manual real-account smoke test

CI does not run this test because it creates a live Cloudflare deployment.
Run it only when you intend to create resources and have prepared a dedicated
smoke-test PostgreSQL database and Hyperdrive configuration with caching off:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… TALORYS_HYPERDRIVE_ID=… npm run test:smoke
```

The script uses the locally built fork CLI and leaves deployed resources in
place for inspection. Review its output and remove resources yourself when done.
`TALORYS_SMOKE_AI=1` additionally uses Workers AI for one chat turn. Keep these
credentials out of command history and use your shell's secret environment
configuration in actual use.
