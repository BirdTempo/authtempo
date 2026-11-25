import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

// The driver major of this run: `pnpm test` runs the suite on 3.4.9, then on
// 4.1.1 with TEMPO_AUTH_PG_DRIVER=4 (test/db.ts). The run of driver.test.ts
// carries the major in its name, so a run on the wrong major is a missing run.
const DRIVER = process.env.TEMPO_AUTH_PG_DRIVER === "4" ? "4" : "3";

// The count reporter fails the run when one of these runs is missing or
// has no passed test (ruling 7 of plan 12g).
const RUNS = [
  `postgres driver: ${DRIVER}`,
  "storage conformance: postgres",
  "limiter conformance: postgres",
  "secret rotation: postgres",
  "refresh reuse race: postgres",
  "refresh revoke race: postgres",
  "shape conformance: postgres",
  "phone cap: postgres",
];

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    reporters: ["default", conformanceCountReporter({ expected: RUNS })],
  },
});
