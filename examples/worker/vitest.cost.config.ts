import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * The `cost` project (plan 12e Task 2 Step 7): the RS256 cost measure, by hand only.
 * Run: `pnpm --filter authtempo-example-worker exec vitest run --config vitest.cost.config.ts`.
 * The default config leaves the file out, so `pnpm test` never runs it.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { name: "cost", include: ["test/rs256-cost.test.ts"] },
});
