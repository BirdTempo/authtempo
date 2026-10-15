import { defineConfig } from "vitest/config";

// The browser build of solid-js, as in packages/solid (plan 11d2). The inline
// of @authtempo/solid is for an app that installs it from npm: there it is in
// node_modules, and an external package that imports solid-js loads the server
// build through Node. In this repo the workspace link resolves outside
// node_modules, so vite transforms it with no setting (Task 8 probe 9). The DOM
// is the environment of packages/react, which keeps the runtime's fetch
// classes (plan 11d).
export default defineConfig({
  resolve: { conditions: ["browser", "development"] },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "../../packages/react/test/environment.ts",
    server: { deps: { inline: [/solid-js/, /@authtempo\/solid/] } },
  },
});
