import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Option names checked against @cloudflare/vitest-plugin 1.3.7 on 2026-10-09.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/adapter-d1/migrations", import.meta.url)),
  );
  const compatMigrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/compat-better-auth/migrations/d1", import.meta.url)),
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
            COMPAT_MIGRATIONS: compatMigrations,
            GOOGLE_CLIENT_ID: "example-client",
            GOOGLE_CLIENT_SECRET: "example-secret",
            // The Expo Go redirect for the dev-redirect test. A RegExp source with no flags.
            DEV_REDIRECT_PATTERN: "^exp://192\\.168\\.1\\.20:8081/--/auth$",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
