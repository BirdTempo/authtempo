import { defineConfig } from "vitest/config";

// Two projects in one config, so the config count stays the same.
// "node" runs the binding and the React fit on Node.
// "solid" loads @tanstack/solid-start, which needs all three settings below:
// the browser build of solid-js, a DOM (happy-dom), and an inline transform of
// solid-js and @tanstack. With one of them missing, solid-js refuses a
// client-only API at the import of @tanstack/solid-router (review m1).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.solid.test.ts"],
        },
      },
      {
        resolve: { conditions: ["browser"] },
        test: {
          name: "solid",
          include: ["test/**/*.solid.test.ts"],
          environment: "happy-dom",
          server: { deps: { inline: [/solid-js/, /@tanstack/] } },
        },
      },
    ],
  },
});
