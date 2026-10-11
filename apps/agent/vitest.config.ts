import { randomBytes, webcrypto } from "node:crypto";
import { loadLocalEnv } from "../../scripts/load-local-env.mjs";
import { builtinModules } from "node:module";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

loadLocalEnv();

export const TEST_PASSWORD = randomBytes(32).toString("base64url");

async function pbkdf2(password: string): Promise<string> {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  return `pbkdf2-sha256$100000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

export default defineConfig(async () => {
  // Never fall back to DATABASE_URL: every test truncates these application tables.
  const databaseUrl = process.env.TALORYS_TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Set TALORYS_TEST_DATABASE_URL to a dedicated disposable PostgreSQL database (run npm run setup:local to generate local connection settings).");
  }
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !decodeURIComponent(url.pathname).endsWith("_test")) {
    throw new Error("TALORYS_TEST_DATABASE_URL must identify a PostgreSQL database whose name ends in '_test'. Tests delete all application data in it.");
  }
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false,
        miniflare: {
          // Override Wrangler's local Hyperdrive target with the disposable database.
          hyperdrives: { HYPERDRIVE: databaseUrl },
          bindings: {
            DATABASE_URL: databaseUrl,
            TALORYS_TEST_DATABASE: "1",
            TALORYS_ENV: "development",
            TALORYS_MOCK_AI: "1",
            TALORYS_DEV_ORIGINS: "",
            OWNER_PASSWORD_HASH: await pbkdf2(TEST_PASSWORD),
            SESSION_SECRET: randomBytes(32).toString("base64url"),
            TEST_PASSWORD,
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      // Bundle pg's CommonJS/ESM dependency graph for the Workers test runtime.
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            include: ["pg"],
            rolldownOptions: { external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`), /^cloudflare:/] },
          },
        },
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
      // PostgreSQL is shared across Workers isolates, unlike SDK SQLite storage.
      fileParallelism: false,
      maxWorkers: 1,
      sequence: { concurrent: false },
    },
  };
});
