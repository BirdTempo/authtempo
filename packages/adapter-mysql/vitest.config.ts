import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

// The count reporter fails the run when one of these runs is missing or
// has no passed test (ruling 7 of plan 12g).
const RUNS = ["8.4", "9.7"].flatMap((v) => [
  `storage conformance: mysql ${v}`,
  `limiter conformance: mysql ${v}`,
  `secret rotation: mysql ${v}`,
  `refresh reuse race: mysql ${v}`,
  `refresh revoke race: mysql ${v}`,
  `shape conformance: mysql ${v}`,
]);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A fresh database is thirty DDL statements, and many test files make
    // one in the test body. With every file at once under the load of other
    // lanes, one took more than 15 s (2026-10-21). So four files run at once,
    // and a test or a hook has 60 s.
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ["default", conformanceCountReporter({ expected: RUNS })],
  },
});
