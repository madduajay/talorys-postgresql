import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** Explicit environment values win over the ignored local-development file. */
export function loadLocalEnv() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../.env");
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
