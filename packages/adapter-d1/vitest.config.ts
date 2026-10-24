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
      reporters: ["default", conformanceCountReporter({ expected: RUNS })],
    },
  };
});
