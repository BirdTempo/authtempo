import { defineConfig } from "vitest/config";

// The named measures of core (fix wave of plan 12i, ruling 48). A measure is
// a test whose time grows with the load of the machine. It is out of the
// default test gate: vitest.config.ts includes only test/**/*.test.ts.
// `pnpm measure` in this package runs them, through the turbo task `measure`.
// No answer or event recorder runs here: a measure adds no row to those checks.
export default defineConfig({
  test: {
    include: ["test/measure/**/*.measure.ts"],
  },
});
