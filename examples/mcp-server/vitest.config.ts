import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** The address of each name that the DNS over HTTPS answers hold. */
const ADDRESSES: Readonly<Record<string, string>> = {
  "public.example.com": "93.184.215.14",
  "private.example.com": "10.0.0.5",
  // The host of the MCP client's metadata document in test/mcp.test.ts.
  "agent.example.com": "93.184.215.14",
};

/** The client metadata document of the MCP client in test/mcp.test.ts. */
const CLIENT_ID = "https://agent.example.com/client.json";
const CLIENT = {
  client_id: CLIENT_ID,
  client_name: "Agent",
  redirect_uris: ["http://127.0.0.1:33418/callback"],
  token_endpoint_auth_method: "none",
};

/**
 * Every outbound fetch of the tests comes here, so the real global fetch of workerd runs
 * and no test reaches the network. The DNS over HTTPS answers hold the names above with
 * an A record. The client metadata URL answers its document. Any other host answers a
 * small JSON document.
 */
function outbound(request: Request): Response {
  const url = new URL(request.url);
  if (url.hostname === "cloudflare-dns.com") {
    const name = url.searchParams.get("name") ?? "";
    const address = ADDRESSES[name];
    if (url.searchParams.get("type") !== "A" || address === undefined)
      return Response.json({ Status: 0, Answer: [] });
    return Response.json({ Status: 0, Answer: [{ name, type: 1, data: address }] });
  }
  if (url.href === CLIENT_ID) return Response.json(CLIENT);
  return Response.json({ host: url.hostname });
}

// The same pool as examples/worker-d1 (@cloudflare/vitest-plugin 1.4.0). The
// tests run on workerd, as the Worker does, with the settings of wrangler.jsonc.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./node_modules/@authtempo/adapter-d1/migrations", import.meta.url)),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            AUTH_SECRET: "0123456789abcdef0123456789abcdef",
            TEST_MIGRATIONS: migrations,
          },
          outboundService: outbound,
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"] },
  };
});
