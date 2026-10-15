import { defineConfig } from "vitest/config";

// Two projects in one config (plan 11d2). "browser": the store entry with a
// window, in happy-dom 20.14.6 (plan 11d), through the environment of
// packages/react, which keeps the runtime's fetch classes. happy-dom's
// Response drops Set-Cookie, and core in process sets its session cookie with
// it. "server": Node with no window, for the hook and for a server render,
// where the store entry never subscribes to the client store.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "browser",
          include: ["test/store.test.ts"],
          environment: "../react/test/environment.ts",
        },
      },
      {
        test: {
          name: "server",
          include: ["test/**/*.test.ts"],
          exclude: ["test/store.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
