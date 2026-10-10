import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The D1 storage tests run in workerd. Option names as in packages/adapter-d1/vitest.config.ts.
export default defineConfig(async () => {
  const read = (dir: string) => readD1Migrations(fileURLToPath(new URL(dir, import.meta.url)));
  const migrations = await read("migrations/d1");
  const before17 = await read("migrations/d1-before-1.7");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: { COMPAT_MIGRATIONS: migrations, COMPAT_MIGRATIONS_BEFORE_17: before17 },
        },
      }),
    ],
    // No setup file: each test file builds its own tables (the pool gives each
    // file its own storage), keyless, keyed, or with other names.
    test: { include: ["test/d1/**/*.test.ts"] },
  };
});
