import { defineConfig } from "vitest/config";

// The Node tests of @authtempo/cli (plan 11c): the commands as functions with
// a fake io, and as child processes of dist/bin/authtempo.js. The limits
// cover a cold wrangler or Postgres start on a loaded machine.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/pool/**"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
