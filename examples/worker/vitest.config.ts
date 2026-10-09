import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Option names checked against @cloudflare/vitest-plugin 1.3.7 on 2026-10-09.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/adapter-d1/migrations", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MODE: "1",
            AUTH_SECRET: "0123456789abcdef0123456789abcdef",
            TEST_MIGRATIONS: migrations,
            GOOGLE_CLIENT_ID: "example-client",
            GOOGLE_CLIENT_SECRET: "example-secret",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
