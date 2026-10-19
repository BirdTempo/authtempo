import { defineConfig } from "vitest/config";

/**
 * The second run of `pnpm test` (plan 11g Task 5). The first run records
 * every answer of the router in `.answers/`; this run reads the records and
 * holds them to `ROUTES` and the contract. No setup file: it mounts no router.
 */
export default defineConfig({
  test: { include: ["test/answers/*.check.ts"] },
});
