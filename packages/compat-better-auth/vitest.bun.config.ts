// packages/compat-better-auth/vitest.bun.config.ts
import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

// The bun:sqlite run (plan 12n), in the form of adapter-sqlite's. The test
// script starts it with `bun --bun vitest run -c vitest.bun.config.ts`, so
// the tests run under the Bun runtime, where `bun:sqlite` exists. The count
// reporter fails the run when the run is missing or has no passed test.
export default defineConfig({
  test: {
    include: ["test/sqlite/bun/**/*.test.ts"],
    reporters: [
      "default",
      conformanceCountReporter({ expected: ["storage conformance: compat sqlite bun:sqlite"] }),
    ],
  },
});
