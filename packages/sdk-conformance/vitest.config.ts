import { defineConfig } from "vitest/config";

// The error-shape file renders the React hook, the Vue composable, and the
// Solid primitive, and subscribes to the Svelte store, so the package runs in
// happy-dom (plans 11d and 11d2); the route test needs no DOM and runs there
// too. One environment for the SDK tests, the same as packages/react: happy-dom
// with the runtime's fetch classes kept, so core in process can set its cookie
// (one copy of the rule).
// solid-js answers its server build (no reactivity, no render) under the
// "node" condition. The Solid primitive needs its browser build: the "browser"
// condition, and solid-js and @authtempo/solid inlined so that vite resolves
// them, not Node, as in packages/solid.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { conditions: ["browser", "development"] },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "../react/test/environment.ts",
    server: { deps: { inline: [/solid-js/, /@authtempo\/solid/] } },
  },
});
