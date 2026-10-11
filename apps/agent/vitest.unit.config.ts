import { defineConfig } from "vitest/config";

/** Fast Node unit tests; the separate Workers config exercises real PostgreSQL. */
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
