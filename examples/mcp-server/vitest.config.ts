import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The same pool as examples/worker-d1 (@cloudflare/vitest-plugin 1.4.0). The
// tests run on workerd, as the Worker does. Plan 11e Task 13 adds the
// wrangler.jsonc of the Worker and points this config at it.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-30",
        // From compatibility date 2026-08-04 Workers turn nodejs_compat on by
        // default. The guarded fetch uses no Node.js API, so these flags turn it off.
        compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
