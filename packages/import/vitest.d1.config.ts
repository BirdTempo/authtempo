import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The importer on core's D1 adapter, and the Worker script's run, in workerd.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../adapter-d1/migrations", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    // The Worker's input module is the git-ignored input/import.local.json in
    // wrangler (worker/wrangler.jsonc). The tests read the tracked sample.
    resolve: {
      alias: {
        "tempo-auth-import-input": fileURLToPath(
          new URL("./worker/input/import.json", import.meta.url),
        ),
      },
    },
    test: { include: ["test/d1/**/*.test.ts"] },
  };
});
