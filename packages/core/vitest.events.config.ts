import { defineConfig } from "vitest/config";

/**
 * The third run of `pnpm test` (plan 12h Task 12). The first run records
 * every event of the suite in `.events/`; this run reads the records and
 * holds them to `EVENTS`, `ROUTES`, `LIMIT_FAMILIES`, and the deny list. No
 * setup file: it makes no observer.
 */
export default defineConfig({
  test: {
    include: ["test/events/*.check.ts"],
    // The finder reads each of the 36000 records against the deny list. Alone a
    // test takes under 1 s. At a load of 17 to 20 one took 7.4 s and failed on
    // the 5 s default (review of plan 12h Task 12, m3). 60 s holds at that load.
    testTimeout: 60_000,
  },
});
