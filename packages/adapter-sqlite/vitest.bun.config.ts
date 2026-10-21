import { defineConfig } from "vitest/config";
import { conformanceCountReporter, PREFIXES } from "../../scripts/conformance-count-reporter.mjs";

// The bun:sqlite run (plan 12g Task 4). The package's test script starts it
// with `bun --bun vitest run -c vitest.bun.config.ts`, so the tests run under
// the Bun runtime, where `bun:sqlite` exists.
export default defineConfig({
  test: {
    include: ["test/bun/**/*.test.ts"],
    testTimeout: 15_000,
    reporters: [
      "default",
      conformanceCountReporter({ expected: PREFIXES.map((p) => `${p}bun:sqlite`) }),
    ],
  },
});
