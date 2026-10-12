import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The importer on core's D1 adapter and on the Better Auth tables, and the
// Worker script's run, in workerd.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../adapter-d1/migrations", import.meta.url)),
  );
  const compatMigrations = await readD1Migrations(
    fileURLToPath(new URL("../compat-better-auth/migrations/d1", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, COMPAT_MIGRATIONS: compatMigrations },
        },
      }),
    ],
    // The Worker's input module is the git-ignored input/import.local.json in
    // wrangler (worker/wrangler.jsonc). The tests read the tracked sample.
    resolve: {
      alias: {
        // The Worker imports the package by its own name; the D1 tests run the source.
        "@tempo-auth/import": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        "tempo-auth-import-input": fileURLToPath(
          new URL("./worker/input/import.json", import.meta.url),
        ),
      },
    },
    test: { include: ["test/d1/**/*.test.ts"] },
  };
});
