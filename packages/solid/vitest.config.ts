import { defineConfig } from "vitest/config";

/**
 * solid-js 1.9.17 answers its server build (no reactivity, no render) under
 * the "node" condition. A DOM test needs the browser build: the "browser"
 * condition, and solid-js inlined so that vite resolves it, not Node (plan 11d2).
 * The DOM is happy-dom 20.14.6 (plan 11d), through the environment of
 * packages/react, which keeps the runtime's fetch classes: happy-dom's
 * Response drops Set-Cookie, and core in process sets its session cookie with it.
 * The tests render with solid-js/html, so no JSX compile step is needed.
 */
export default defineConfig({
  resolve: { conditions: ["browser", "development"] },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "../react/test/environment.ts",
    server: { deps: { inline: [/solid-js/] } },
  },
});
