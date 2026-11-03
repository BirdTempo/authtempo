import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

// The count reporter fails the run when one of these runs is missing or
// has no passed test (ruling 7 of plan 12g).
const RUNS = [
  "storage conformance: d1",
  "limiter conformance: d1",
  "secret rotation: d1",
  "refresh reuse race: d1",
  "refresh revoke race: d1",
  "shape conformance: d1",
  "phone cap: d1",
];

// `readD1Migrations` and `applyD1Migrations` checked against the installed
// @cloudflare/vitest-plugin 1.3.7 typings on 2026-10-09.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("migrations", import.meta.url)));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      // On 2026-11-03 five D1 budget tests timed out together at the default 5 s, at 5.47 to
      // 6.06 s. Their files are multi-session-budget, anonymous-upgrade-budget,
      // operator-sessions-budget, operator-access-end-budget, and operator-loss-budget. That run
      // of the Task 5 review of plan 12n started at load 18.2, beside seven other agents. In the
      // other logs of 2026-10-30 to 2026-11-03 these five did not time out, and their highest
      // pass is 2.65 s. So one limit covers the pool, as in the compat and import D1 pools. A
      // test with a longer limit of its own keeps it.
      testTimeout: 20_000,
      reporters: ["default", conformanceCountReporter({ expected: RUNS })],
    },
  };
});
