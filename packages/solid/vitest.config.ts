import { defineConfig } from "vitest/config";

/**
 * Two projects in one config (plan 11d2).
 *
 * browser: solid-js 1.9.17 answers its server build (no reactivity, no render)
 * under the "node" condition. A DOM test needs the browser build: the "browser"
 * condition, and solid-js inlined so that vite resolves it, not Node. The DOM
 * is happy-dom 20.14.6 (plan 11d), through the environment of packages/react,
 * which keeps the runtime's fetch classes: happy-dom's Response drops
 * Set-Cookie, and core in process sets its session cookie with it. The tests
 * render with solid-js/html, so no JSX compile step is needed.
 *
 * server: no browser condition and no inline, so Node loads the server build
 * of solid-js, as a Solid Start server render does. It holds the rule that a
 * server render never subscribes to the store.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { conditions: ["browser", "development"] },
        test: {
          name: "browser",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.server.test.ts"],
          environment: "../react/test/environment.ts",
          server: { deps: { inline: [/solid-js/] } },
        },
      },
      {
        test: {
          name: "server",
          include: ["test/**/*.server.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
