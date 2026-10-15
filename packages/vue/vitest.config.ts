import { defineConfig } from "vitest/config";

// The composables mount in a DOM: happy-dom 20.14.6 (plan 11d), through the
// environment of packages/react, which keeps the runtime's fetch classes.
// happy-dom's Response drops Set-Cookie, and core in process sets its session
// cookie with it. The tests use render functions, so no .vue compile step is needed.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "../react/test/environment.ts" },
});
