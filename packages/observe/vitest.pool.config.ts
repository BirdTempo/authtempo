import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The two sinks in workerd (plan 12h Task 10), through @cloudflare/vitest-plugin
// 1.4.0. The date and the flags are those of examples/worker/wrangler.jsonc.
// The pool turns Node.js modules on for its own runner whatever the flags say,
// so proof/bundle-no-node.mjs, not this run, proves that no node: import is left.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-30",
        compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
        // A sink makes no outbound fetch. A fetch that leaves the Worker fails the test.
        outboundService: () => {
          throw new Error("a sink made an outbound fetch");
        },
      },
    }),
  ],
  test: { include: ["test/pool/**/*.test.ts"] },
});
