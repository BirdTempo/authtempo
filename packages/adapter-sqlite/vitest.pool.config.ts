import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The libSQL entry in workerd (plan 12g Task 4), with the settings of the
// proof Worker (@cloudflare/vitest-plugin 1.4.0). The pool turns Node.js
// modules on for its own runner whatever the flags say. So proof/bundle.mjs
// holds the no-Node rule, and this run holds that the entry loads in workerd.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./proof/worker/wrangler.jsonc" },
      miniflare: {
        // The test makes no request. A fetch that leaves the Worker fails it.
        outboundService: () => {
          throw new Error("the libSQL pool test made an outbound fetch");
        },
      },
    }),
  ],
  test: { include: ["test/pool/**/*.test.ts"] },
});
