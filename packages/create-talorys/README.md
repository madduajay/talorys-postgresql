# Talorys PostgreSQL installer

This private workspace package is the installer for the PostgreSQL source fork of
[rociiu/talorys](https://github.com/rociiu/talorys). It is not published to npm.
The upstream `npx create-talorys@latest` package does not include this migration.

Build from the repository root:

```sh
npm ci
npm run build
node packages/create-talorys/dist/cli.js --dir ./my-talorys --hyperdrive-id YOUR_HYPERDRIVE_ID
```

Provision your dedicated PostgreSQL database and Cloudflare Hyperdrive configuration
first. Hyperdrive query caching must be disabled. The installer does not create a
paid database or Hyperdrive resource. See [deployment instructions](../../docs/deployment.md)
for configuration, costs, secrets, and importing an upstream backup.

The installer deploys a private Agent Worker and Pages frontend. Application records
live in PostgreSQL; Agents SDK runtime and alarm state still use a SQLite-backed
Durable Object. An upstream SQLite installation must be migrated through a fresh
installation and export/import, not an in-place update.

Commands after building (use an absolute path to the CLI if your working directory changes):

- `node packages/create-talorys/dist/cli.js [directory]`: install or resume
- `node packages/create-talorys/dist/cli.js update --dir ./my-talorys`: update this fork
- `node packages/create-talorys/dist/cli.js status --dir ./my-talorys`: deployment health
- `node packages/create-talorys/dist/cli.js doctor --dir ./my-talorys`: diagnostics
- `node packages/create-talorys/dist/cli.js reset-password --dir ./my-talorys`: reset owner password

Options include `--dir`, `--account-id`, `--name`, `--hyperdrive-id`, and `--yes`.
`TALORYS_HYPERDRIVE_ID` is an alternative to the Hyperdrive flag.
`TALORYS_OWNER_PASSWORD` supplies a non-interactive password; never commit it.
The manifest stores the Hyperdrive ID and storage backend, but no database credentials.

Original MIT license and attribution are preserved.
