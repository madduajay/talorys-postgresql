// Starts an isolated local stack for Playwright: agent Worker, Pages Function proxy and Vite,
// with fresh persisted state in .wrangler/e2e-state so tests never touch development data.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.TALORYS_E2E_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_e2e")) {
  throw new Error("Set TALORYS_E2E_DATABASE_URL to a disposable PostgreSQL database whose name ends in _e2e.");
}
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
try {
  const { rows } = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'tal\\_%' ESCAPE '\\' AND tablename <> 'tal_schema'");
  const tables = rows.map(({ tablename }) => {
    if (!/^tal_[a-z_]+$/.test(tablename)) throw new Error("Unexpected test table name");
    return `"public"."${tablename}"`;
  });
  if (tables.length) await db.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
} finally {
  await db.end();
}
const state = join(root, ".wrangler/e2e-state");
rmSync(state, { recursive: true, force: true });
const configDir = join(root, ".wrangler/e2e-config");
mkdirSync(configDir, { recursive: true });
const config = JSON.parse(readFileSync(join(root, "apps/agent/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
config.main = join(root, "apps/agent/src/index.ts");
delete config.$schema;
writeFileSync(join(configDir, "wrangler.json"), JSON.stringify(config));
const vars = readFileSync(join(root, "apps/agent/.dev.vars"), "utf8").replace(/^DATABASE_URL=.*$/gm, "");
writeFileSync(join(configDir, ".dev.vars"), `${vars}\nDATABASE_URL=${databaseUrl}\n`, { mode: 0o600 });
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
const procs = [
  spawn(process.execPath, [wrangler, "dev", "--config", join(configDir, "wrangler.json"), "--local", "--port", "8787", "--persist-to", state], { cwd: join(root, "apps/agent"), env, stdio: "inherit" }),
  spawn(process.execPath, [wrangler, "pages", "dev", "dist", "--port", "8788", "--persist-to", `${state}-pages`], { cwd: join(root, "apps/web"), env, stdio: "inherit" }),
  spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--port", "5173", "--strictPort"], { cwd: join(root, "apps/web"), env, stdio: "inherit" }),
];
const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", () => { stop(); rmSync(configDir, { recursive: true, force: true }); });
