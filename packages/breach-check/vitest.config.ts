import { defineConfig } from "vitest/config";

// Node runs the unit tests with a fetch stub: no test calls the network. The
// no-Node proof is the wrangler bundle of proof/index.ts, not a pool test:
// @cloudflare/vitest-plugin 1.4.0 removes no_nodejs_compat_v2 and adds
// Node.js modules to its runner (dist/pool/index.mjs, read 2026-10-11), so a
// pool test cannot show that this package runs without them.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
