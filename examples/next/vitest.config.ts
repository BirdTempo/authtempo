import { defineConfig } from "vitest/config";

// The browser test renders the providers and the sign-in page, so the tests run
// in happy-dom through the environment of packages/react, which keeps the
// runtime's fetch classes (happy-dom's Response drops Set-Cookie, and core in
// process sets its session cookie with it). The JSX is the automatic runtime.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "../../packages/react/test/environment.ts",
  },
});
