// packages/compat-better-auth/vitest.pg4.config.ts
import { readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

// The Postgres tests on postgres 4.1.1. The peer range is `^3.4.9 || ^4.1.1`,
// and vitest.config.ts runs every test on 3.4.9. The test script starts this
// config with TEMPO_AUTH_PG_DRIVER=4, so test/pg.ts gives each test the 4.1.1
// driver. A test file is a Postgres test when it imports test/pg.ts: the
// import decides, so a new Postgres test needs no entry in a list here.
const dir = new URL("./test/", import.meta.url);
const include = readdirSync(dir)
  .filter((name) => /\.test\.tsx?$/.test(name))
  .filter((name) => /from "\.\/pg\.js"/.test(readFileSync(new URL(name, dir), "utf8")))
  .map((name) => `test/${name}`);
// No file means that the rule above reads nothing, and vitest would then pass with no test.
if (include.length === 0)
  throw new Error("vitest.pg4.config.ts found no test file that imports ./pg.js");

export default defineConfig({
  test: {
    include,
    // Each file of this run uses Postgres, so the files load one server at the
    // same time. Measured on 2026-11-25 at a load of 5 to 7: alone, the run
    // passed 388 tests in 55 s. With the adapter-postgres suite beside it, 3
    // tests passed the default limit of 5 s. 15 s is the limit of that suite.
    testTimeout: 15_000,
    reporters: [
      "default",
      conformanceCountReporter({
        expected: [
          "postgres driver: 4",
          "storage conformance: Better Auth tables on postgres, camelCase (Better Auth's own SQL)",
          "storage conformance: Better Auth tables on postgres, snake_case (consumer-i's tables)",
        ],
      }),
    ],
  },
});
