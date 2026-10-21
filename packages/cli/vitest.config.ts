import { defineConfig } from "vitest/config";

// The Node tests of @authtempo/cli (plan 11c): the commands as functions with
// a fake io, and as child processes of dist/bin/authtempo.js. The limits
// cover a cold wrangler or Postgres start on a loaded machine.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // An afterAll drops each Postgres test database that a timed-out test left.
    setupFiles: ["./test/support/pg-setup.ts"],
  },
});
