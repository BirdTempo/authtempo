import type { Auth } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { call, type Harness, harness, signIn } from "../support/harness.ts";
import { createProviderAuth, mcpRoute } from "./oauth-provider.ts";

const API = "https://api.example.com";
const REDIRECT = "http://127.0.0.1:8000/callback";

/** The code flow of a public client: register, authorize, allow, and exchange the code with PKCE. */
async function accessToken(auth: Auth, h: Harness, scope: string): Promise<string> {
  const cookie = await signIn(auth, h, "ada@example.com");
  const reg = await call(auth, "POST", "/auth/oauth/register", {
    client_name: "Agent",
    redirect_uris: [REDIRECT],
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: Buffer.from(digest).toString("base64url"),
    code_challenge_method: "S256",
    scope,
    resource: `${API}/mcp`,
    state: "st-1",
  });
  const consent = await call(auth, "GET", `/auth/oauth/authorize?${query}`, undefined, { cookie });
  const requestId =
    /name="request_id" value="(oq_[A-Za-z0-9_-]+)"/.exec(await consent.text())?.[1] ?? "";
  const allow = await auth.handle(
    new Request(`${API}/auth/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: API, cookie },
      body: new URLSearchParams({ request_id: requestId, decision: "allow" }).toString(),
    }),
  );
  const code = new URL(allow.headers.get("location") ?? `${API}/`).searchParams.get("code") ?? "";
  const token = await auth.handle(
    new Request(`${API}/auth/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: `${API}/mcp`,
      }).toString(),
    }),
  );
  return ((await token.json()) as { access_token: string }).access_token;
}

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

  it("lets a token with the tools scope call the route, and answers 403 to a token without it", async () => {
    const h = harness();
    const auth = createProviderAuth(h);
    const tools = await accessToken(auth, h, "mcp:tools");
    const ok = await mcpRoute(
      auth,
      new Request(`${API}/mcp`, { headers: { authorization: `Bearer ${tools}` } }),
    );
    expect(ok.status).toBe(200);

    const openid = await accessToken(auth, h, "openid");
    const refused = await mcpRoute(
      auth,
      new Request(`${API}/mcp`, { headers: { authorization: `Bearer ${openid}` } }),
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("lists the grants of the signed-in person for a connected apps page", async () => {
    const h = harness();
    const auth = createProviderAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const none = await call(auth, "GET", "/auth/oauth/grants", undefined, { cookie: ada });
    expect(await none.json()).toEqual({ grants: [] });

    await accessToken(auth, h, "mcp:tools");
    const one = await call(auth, "GET", "/auth/oauth/grants", undefined, { cookie: ada });
    const { grants } = (await one.json()) as {
      grants: Array<{ clientName: string; scopes: string[] }>;
    };
    expect(grants.map((g) => [g.clientName, g.scopes])).toEqual([["Agent", ["mcp:tools"]]]);
  });
});
