import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The D1 storage tests run in workerd. Option names as in packages/adapter-d1/vitest.config.ts.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("migrations/d1", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: { bindings: { COMPAT_MIGRATIONS: migrations } },
      }),
    ],
    test: { include: ["test/d1/**/*.test.ts"], setupFiles: ["./test/d1/setup.ts"] },
  };
});
