import { createVerifier } from "../src/index.js";

// The bundle proof of plan 11d: wrangler bundles this Worker with no_nodejs_compat.
// bundle-no-node.mjs fails on a node: import in the verifier, the client, or the core entries.
export default {
  async fetch(request: Request): Promise<Response> {
    const verifier = createVerifier({
      issuer: "https://api.example.com/auth",
      audience: "https://files.example.com",
      fetch: async () => Response.json({ keys: [] }),
    });
    const r = await verifier.verifyRequest(request);
    if (!r.ok) return new Response(null, { status: 503 });
    return r.value === null ? verifier.unauthorized() : Response.json({ kind: r.value.kind });
  },
};
