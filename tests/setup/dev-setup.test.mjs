import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { setupDevelopment } from "../../scripts/dev-setup.mjs";

const fixture = () => mkdtempSync(join(tmpdir(), "talorys-setup-"));
test("fresh setup generates distinct credentials, private files, and matching local URLs without logging secrets", async () => {
  const root = fixture();
  const logs = [];
  await setupDevelopment({ root, env: {}, log: (line) => logs.push(line) });
  const settings = parseEnv(readFileSync(join(root, ".env"), "utf8"));
  const vars = parseEnv(readFileSync(join(root, "apps/agent/.dev.vars"), "utf8"));
  assert.ok(settings.POSTGRES_PASSWORD.length >= 40);
  assert.ok(settings.TALORYS_DEV_PASSWORD.length >= 40);
  assert.notEqual(settings.POSTGRES_PASSWORD, settings.TALORYS_DEV_PASSWORD);
  assert.equal(new URL(settings.DATABASE_URL).password, settings.POSTGRES_PASSWORD);
  assert.equal(vars.DATABASE_URL, settings.DATABASE_URL);
  assert.equal(new URL(settings.TALORYS_TEST_DATABASE_URL).pathname, "/talorys_test");
  assert.equal(new URL(settings.TALORYS_E2E_DATABASE_URL).pathname, "/talorys_e2e");
  assert.equal(statSync(join(root, ".env")).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "apps/agent/.dev.vars")).mode & 0o777, 0o600);
  for (const value of [settings.POSTGRES_PASSWORD, settings.TALORYS_DEV_PASSWORD, vars.SESSION_SECRET]) assert.ok(!logs.join("\n").includes(value));
});
test("repeated setup preserves credentials and existing Worker secrets", async () => {
  const root = fixture();
  await setupDevelopment({ root, env: {}, log: () => {} });
  const paths = [join(root, ".env"), join(root, "apps/agent/.dev.vars")];
  const before = paths.map((p) => readFileSync(p, "utf8"));
  await setupDevelopment({ root, env: {}, log: () => {} });
  assert.deepEqual(paths.map((p) => readFileSync(p, "utf8")), before);
});
test("explicit external database URL is retained and never used to infer destructive test targets", async () => {
  const root = fixture();
  const url = `postgresql://owner:${randomBytes(24).toString("hex")}@localhost:5432/custom`;
  await setupDevelopment({ root, env: { DATABASE_URL: url }, log: () => {} });
  const settings = parseEnv(readFileSync(join(root, ".env"), "utf8"));
  const vars = parseEnv(readFileSync(join(root, "apps/agent/.dev.vars"), "utf8"));
  assert.equal(vars.DATABASE_URL, url);
  assert.equal(settings.TALORYS_TEST_DATABASE_URL, undefined);
  assert.equal(settings.TALORYS_E2E_DATABASE_URL, undefined);
});
test("setup respects user-provided local credentials and URL-encodes punctuation", async () => {
  const root = fixture();
  const password = `${randomBytes(20).toString("hex")}:@/#%`;
  writeFileSync(join(root, ".env"), `POSTGRES_PASSWORD=${JSON.stringify(password)}\n`);
  await setupDevelopment({ root, env: {}, log: () => {} });
  const vars = parseEnv(readFileSync(join(root, "apps/agent/.dev.vars"), "utf8"));
  assert.equal(decodeURIComponent(new URL(vars.DATABASE_URL).password), password);
});
