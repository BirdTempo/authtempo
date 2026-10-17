import { createVerifier } from "../src/index.js";
import { requireMcpAuth } from "../src/mcp.js";

// The bundle proof of plan 11d: wrangler bundles this Worker with no_nodejs_compat.
// bundle-no-node.mjs fails on a node: import in the verifier, the client, or the core entries.
// Plan 11e: the /mcp route goes through requireMcpAuth, so the bundle also holds the ./mcp entry.
const MCP = "https://api.example.com/mcp";
const keys = async () => Response.json({ keys: [] });

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/mcp")) {
      const mcp = createVerifier({
        issuer: "https://api.example.com/auth",
        resources: [MCP],
        accept: ["oauth"],
        fetch: keys,
      });
      const route = requireMcpAuth(mcp, (_r, caller) => Response.json({ user: caller.userId }), {
        resource: MCP,
        scopes: ["mcp:tools"],
      });
      return route(request);
    }
    const verifier = createVerifier({
      issuer: "https://api.example.com/auth",
      audience: "https://files.example.com",
      fetch: keys,
    });
    const r = await verifier.verifyRequest(request);
    if (!r.ok) return new Response(null, { status: 503 });
    return r.value === null ? verifier.unauthorized() : Response.json({ kind: r.value.kind });
  },
};
