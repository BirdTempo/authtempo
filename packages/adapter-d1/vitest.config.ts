import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

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
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
