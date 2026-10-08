import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Option names checked against @cloudflare/vitest-plugin 1.3.7 on 2026-10-09.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MODE: "1",
          AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
