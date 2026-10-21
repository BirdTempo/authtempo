import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

// The count reporter fails the run when one of these runs is missing or
// has no passed test (ruling 7 of plan 12g).
const RUNS = [
  "storage conformance: postgres",
  "limiter conformance: postgres",
  "secret rotation: postgres",
  "refresh reuse race: postgres",
  "refresh revoke race: postgres",
  "shape conformance: postgres",
];

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    reporters: ["default", conformanceCountReporter({ expected: RUNS })],
  },
});
