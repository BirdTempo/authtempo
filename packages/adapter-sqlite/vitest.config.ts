import { defineConfig } from "vitest/config";
import { conformanceCountReporter, PREFIXES } from "../../scripts/conformance-count-reporter.mjs";

// The runs of the Node test run (plan 12g Task 4). The count reporter fails
// the run when one of the suites of a run is missing or has no passed test.
const RUNS = ["node:sqlite", "better-sqlite3", "libsql file", "libsql http"];

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // test/bun runs under the Bun runtime (vitest.bun.config.ts); test/pool runs in workerd (vitest.pool.config.ts).
    exclude: ["test/bun/**", "test/pool/**"],
    testTimeout: 15_000,
    reporters: [
      "default",
      conformanceCountReporter({ expected: RUNS.flatMap((r) => PREFIXES.map((p) => `${p}${r}`)) }),
    ],
  },
});
