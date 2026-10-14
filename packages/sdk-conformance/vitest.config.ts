import { defineConfig } from "vitest/config";

// The error-shape file renders the React hook, so the package runs in happy-dom
// (plan 11d); the route test needs no DOM and runs there too. The environment
// of packages/react keeps the runtime's fetch classes, so each SDK meets the
// Request and Response that it meets in production (one copy of the rule).
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "../react/test/environment.ts",
  },
});
