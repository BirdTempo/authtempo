import { configDefaults, defineConfig } from "vitest/config";

// The Node tests of @authtempo/mcp (plan 11e). They run the server in process
// through the SDK client, and the built binary as a child process on raw JSON-RPC.
// The limits cover a cold start of the binary on a loaded machine.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // test/pool runs on workerd through vitest.pool.config.ts: it imports
    // cloudflare:test, which Node cannot load (plan 11e Task 16, ruling 26).
    exclude: ["test/pool/**", ...configDefaults.exclude],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
