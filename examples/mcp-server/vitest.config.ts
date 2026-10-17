import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Every outbound fetch of the tests comes here, so the real global fetch of workerd runs
 * and no test reaches the network. The DNS over HTTPS answers hold one public name and one
 * private name. Any other host answers a small JSON document.
 */
function outbound(request: Request): Response {
  const url = new URL(request.url);
  if (url.hostname === "cloudflare-dns.com") {
    const name = url.searchParams.get("name");
    const type = url.searchParams.get("type");
    const address = name === "public.example.com" ? "93.184.215.14" : "10.0.0.5";
    if (type !== "A" || (name !== "public.example.com" && name !== "private.example.com"))
      return Response.json({ Status: 0, Answer: [] });
    return Response.json({ Status: 0, Answer: [{ name, type: 1, data: address }] });
  }
  return Response.json({ host: url.hostname });
}

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
        outboundService: outbound,
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
