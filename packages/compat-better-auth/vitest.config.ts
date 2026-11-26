// packages/compat-better-auth/vitest.config.ts
import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

// The count reporter fails the run when one of these runs is missing or has
// no passed test (ruling 7 of plan 12g). The D1 runs are in vitest.d1.config.ts.
// The bun:sqlite run is in vitest.bun.config.ts (plan 12n).
const RUNS = [
  // This run is on postgres 3.4.9. The run on 4.1.1 is in vitest.pg4.config.ts.
  "postgres driver: 3",
  "storage conformance: Better Auth tables on postgres, camelCase (Better Auth's own SQL)",
  "storage conformance: Better Auth tables on postgres, snake_case (consumer-i's tables)",
  "storage conformance: compat sqlite node",
  "storage conformance: compat sqlite better-sqlite3",
  "storage conformance: compat sqlite libsql file",
];

// The Node tests: unit tests and the Postgres storage. The D1 storage runs in
// the Workers pool through vitest.d1.config.ts (Task 6).
export default defineConfig({
  // The React test (Task 9) uses JSX with no React import, as tsconfig's
  // "react-jsx" does. vite 8.3.3 transforms with Oxc: its `esbuild` key is
  // deprecated and converted to `oxc` (vite dist/node/index.d.ts and
  // convertEsbuildConfigToOxcConfig, read 2026-10-10). Oxc's JSX runtime
  // default is "automatic" (rolldown 1.2.13 JsxOptions); it is set here so a
  // change of that default cannot break the React test.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // test/sqlite/bun runs under the Bun runtime (vitest.bun.config.ts).
    exclude: ["test/d1/**", "test/sqlite/bun/**"],
    // The Postgres tests of this run share one server with the two runs of the
    // adapter-postgres suite and with vitest.pg4.config.ts. Measured on 2026-11-25
    // and 2026-11-26 in 8 full runs of the repo, at a load of 2 to 22: the test
    // "migrates a database with the table and one with no table > on Postgres"
    // took 0.2 s alone and 0.4 to 3.8 s in a full run, and it passed the
    // default limit of 5 s in 2 of the 8 runs. 15 s is the limit of the
    // adapter-postgres suite and of vitest.pg4.config.ts.
    testTimeout: 15_000,
    reporters: ["default", conformanceCountReporter({ expected: RUNS })],
  },
});
