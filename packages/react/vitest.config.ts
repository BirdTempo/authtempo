import { defineConfig } from "vitest/config";

// The hooks need a DOM: happy-dom 20.14.6 (plan 11d), through an environment
// that keeps the runtime's fetch classes, because happy-dom's Response drops
// Set-Cookie and core in process sets its session cookie with it. The JSX of
// the tests is the automatic runtime, as compat-better-auth sets it for vite
// 8.3.3's Oxc.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: { include: ["test/**/*.test.tsx"], environment: "./test/environment.ts" },
});
