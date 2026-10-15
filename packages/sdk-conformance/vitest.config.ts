import { defineConfig } from "vitest/config";

// The error-shape file renders the React hook, so the package runs in happy-dom
// (plan 11d); the route test needs no DOM and runs there too. One environment for
// the SDK tests, the same as packages/react: happy-dom with the runtime's fetch
// classes kept, so core in process can set its cookie (one copy of the rule).
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "../react/test/environment.ts",
  },
});
