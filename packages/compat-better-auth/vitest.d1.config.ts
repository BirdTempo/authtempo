import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

// The count reporter fails the run when one of these D1 runs is missing or
// has no passed test (ruling 7 of plan 12g; the 12g fix wave added D1).
const RUNS = [
  "storage conformance: Better Auth tables on D1, Better Auth's own SQLite SQL, with the foreign keys",
  "storage conformance: Better Auth tables on D1, snake_case and plural names (consumer-i's casing)",
  "storage conformance: Better Auth tables on D1, tables from before 1.7, through the shipped d1-before-1.7 files",
];

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
    test: {
      include: ["test/d1/**/*.test.ts"],
      reporters: ["default", conformanceCountReporter({ expected: RUNS })],
    },
  };
});
