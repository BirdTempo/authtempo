import { defineConfig } from "vitest/config";

// Two projects in one config. "dom": the composables mount in a DOM, happy-dom
// 20.14.6 (plan 11d), through the environment of packages/react, which keeps
// the runtime's fetch classes. happy-dom's Response drops Set-Cookie, and core
// in process sets its session cookie with it. "server": Node with no window,
// for a server render (renderToString). The tests use render functions, so no
// .vue compile step is needed.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "dom",
          include: ["test/**/*.test.ts"],
          exclude: ["test/server.test.ts"],
          environment: "../react/test/environment.ts",
        },
      },
      { test: { name: "server", include: ["test/server.test.ts"], environment: "node" } },
    ],
  },
});
