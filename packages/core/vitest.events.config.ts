import { defineConfig } from "vitest/config";

/**
 * The third run of `pnpm test` (plan 12h Task 12). The first run records
 * every event of the suite in `.events/`; this run reads the records and
 * holds them to `EVENTS`, `ROUTES`, `LIMIT_FAMILIES`, and the deny list. No
 * setup file: it makes no observer.
 */
export default defineConfig({
  test: { include: ["test/events/*.check.ts"] },
});
