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
        "@authtempo/import": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        "authtempo-import-input": fileURLToPath(
          new URL("./worker/input/import.json", import.meta.url),
        ),
      },
    },
    // The test "logs the verify of a verify bundle" took 0.41 to 4.88 s in the logs of
    // 2026-10-30 to 2026-11-03. In the 20 evidence runs of that time, at sampled peak load 36
    // to 56, it passed in up to 2.95 s. It timed out at the default 5 s once, at 5.53 s. That
    // release rehearsal of 2026-10-31 ran at load 11.8 to 25.6 while other lanes ran tests.
    test: { include: ["test/d1/**/*.test.ts"], testTimeout: 20_000 },
  };
});
