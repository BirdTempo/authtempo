import { defineConfig } from "vitest/config";

// Node runs the test of the handler: the key rule, the count rule, and one
// small derive. Node proves the rules only. The cost of a derive is the
// question, and only a deployed Worker answers it (the README runbook). The
// no-Node proof is the wrangler bundle (bundle-no-node.mjs in `test`).
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
