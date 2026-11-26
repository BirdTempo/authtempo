import { defineConfig } from "vitest/config";

// The Node tests: the importer on the memory adapter, on Postgres (core's
// tables and the Better Auth mapping), the readers, and the CLI. The D1 runs
// are in vitest.d1.config.ts.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/d1/**"],
    // The Postgres tests of this run share one server with the four Postgres
    // runs of the adapter and of the Better Auth shim. Measured on 2026-11-25
    // and 2026-11-26 in 6 full runs of the repo, at a load of 2 to 29: the
    // test "writes each record kind as its tables store it" took 0.4 to 4.4 s,
    // and it passed the default limit of 5 s in 1 run. 15 s is the limit of
    // those four runs.
    testTimeout: 15_000,
  },
});
