import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The named measures of the D1 adapter (fix wave of plan 12i, item 3). A
// measure is a test whose time grows with the load of the machine. It is out
// of the default test gate. `pnpm measure` in this package runs them, and turbo task
// `measure` builds core first. The setup is that of vitest.config.ts.
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
      include: ["test/measure/**/*.measure.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
