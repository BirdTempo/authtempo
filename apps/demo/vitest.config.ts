import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The Workers pool of the demo Worker (plan 11b Task 8), on @cloudflare/vitest-plugin
// 1.4.0. The tests run on workerd with the settings of wrangler.jsonc: the two
// Durable Object classes, the migration, the var, and the assets. One source
// holds the date and the flags.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/**/*.test.ts"] },
});
