// packages/compat-better-auth/vitest.config.ts
import { defineConfig } from "vitest/config";
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

// The count reporter fails the run when one of these runs is missing or has
// no passed test (ruling 7 of plan 12g). The D1 runs are in vitest.d1.config.ts.
const RUNS = [
  "storage conformance: Better Auth tables on postgres, camelCase (Better Auth's own SQL)",
  "storage conformance: Better Auth tables on postgres, snake_case (consumer-i's tables)",
  "storage conformance: compat sqlite node",
  "storage conformance: compat sqlite better-sqlite3",
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
    exclude: ["test/d1/**"],
    reporters: ["default", conformanceCountReporter({ expected: RUNS })],
  },
});
