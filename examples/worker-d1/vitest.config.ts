import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The same pool and options as examples/worker (checked against
// @cloudflare/vitest-plugin 1.3.7 on 2026-10-09, pinned 1.4.0).
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./node_modules/@authtempo/adapter-d1/migrations", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            AUTH_SECRET: "0123456789abcdef0123456789abcdef",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
