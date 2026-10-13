import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createProviderAuth, mcpRoute } from "./oauth-provider.ts";

const API = "https://api.example.com";

describe("be the OAuth and OIDC provider for MCP clients", () => {
  it("serves the metadata at the origin root and registers a public client", async () => {
    const auth = createProviderAuth(harness());
    const server = (await (
      await auth.wellKnown(new Request(`${API}/.well-known/oauth-authorization-server`))
    ).json()) as {
      issuer: string;
      code_challenge_methods_supported: string[];
      token_endpoint_auth_methods_supported: string[];
    };
    expect(server.issuer).toBe(`${API}/auth`);
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
    expect(server.token_endpoint_auth_methods_supported).toEqual(["none"]);
    const resource = (await (
      await auth.wellKnown(new Request(`${API}/.well-known/oauth-protected-resource/mcp`))
    ).json()) as {
      resource: string;
    };
    expect(resource.resource).toBe(`${API}/mcp`);

    const reg = await call(auth, "POST", "/auth/oauth/register", {
      client_name: "Agent",
      redirect_uris: ["http://127.0.0.1:8000/callback"],
    });
    expect(reg.status).toBe(201);
    expect(((await reg.json()) as { client_id: string }).client_id.startsWith("cl_")).toBe(true);
  });

  it("answers 401 with the resource metadata to a request with no access token", async () => {
    const res = await mcpRoute(createProviderAuth(harness()), new Request(`${API}/mcp`));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
  });
});
