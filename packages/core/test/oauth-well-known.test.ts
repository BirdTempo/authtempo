import { describe, expect, it } from "vitest";
import { BASE_URL, get, post } from "./helpers.js";
import {
  codeFor,
  exchange,
  ISSUER,
  OTHER_RESOURCE,
  oauthHandle,
  RESOURCE,
} from "./oauth-helpers.js";

const at = (path: string, init: RequestInit = {}) => new Request(`${BASE_URL}${path}`, init);
const SCOPES_SUPPORTED = ["openid", "profile", "email", "offline_access", "mcp:read", "mcp:write"];
const AS_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  userinfo_endpoint: `${ISSUER}/oauth/userinfo`,
  jwks_uri: `${ISSUER}/jwks`,
  scopes_supported: SCOPES_SUPPORTED,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["EdDSA"],
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: false,
};

/** An access token for `scope` from the token endpoint. */
async function accessToken(h: ReturnType<typeof oauthHandle>, scope = "mcp:read offline_access") {
  const c = await codeFor(h, scope);
  const res = await h.auth.handle(exchange(c.code, c.clientId, c.verifier));
  const t = (await res.json()) as { access_token: string; id_token?: string };
  return { ...c, access: t.access_token, idToken: t.id_token ?? "" };
}

describe("the well-known documents (plan 9g)", () => {
  it("serves the authorization server metadata at both root forms and under basePath, with this issuer, as consumerb pins", async () => {
    const h = oauthHandle();
    for (const res of [
      await h.auth.wellKnown(at("/.well-known/oauth-authorization-server")),
      await h.auth.wellKnown(at("/.well-known/oauth-authorization-server/auth")),
      await h.auth.handle(get("/auth/.well-known/oauth-authorization-server")),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(await res.json()).toEqual(AS_METADATA);
    }
  });

  it("serves the OpenID configuration at the root, at the root with the issuer path, and under basePath", async () => {
    const h = oauthHandle();
    for (const res of [
      await h.auth.wellKnown(at("/.well-known/openid-configuration")),
      await h.auth.wellKnown(at("/.well-known/openid-configuration/auth")),
      await h.auth.handle(get("/auth/.well-known/openid-configuration")),
    ]) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(AS_METADATA);
    }
  });

  it("serves the protected resource metadata at the root and under each resource path; 404 for another path and under basePath, as consumerb pins", async () => {
    const h = oauthHandle();
    const prm = (resource: string) => ({
      resource,
      authorization_servers: [ISSUER],
      scopes_supported: SCOPES_SUPPORTED,
      bearer_methods_supported: ["header"],
    });
    const root = await h.auth.wellKnown(at("/.well-known/oauth-protected-resource"));
    expect(root.status).toBe(200);
    expect(root.headers.get("access-control-allow-origin")).toBe("*");
    expect(await root.json()).toEqual(prm(RESOURCE));
    expect(
      await (await h.auth.wellKnown(at("/.well-known/oauth-protected-resource/mcp"))).json(),
    ).toEqual(prm(RESOURCE));
    expect(
      await (await h.auth.wellKnown(at("/.well-known/oauth-protected-resource/files"))).json(),
    ).toEqual(prm(OTHER_RESOURCE));
    expect((await h.auth.wellKnown(at("/.well-known/oauth-protected-resource/other"))).status).toBe(
      404,
    );
    expect((await h.auth.handle(get("/auth/.well-known/oauth-protected-resource"))).status).toBe(
      404,
    );
  });

  it("answers 404 for the root protected-resource form on an origin with no resource (Task 7 review)", async () => {
    const h = oauthHandle();
    for (const origin of [
      "https://other.example.com",
      "http://api.example.com",
      "https://api.example.com:8443",
    ])
      expect({
        origin,
        status: (
          await h.auth.wellKnown(new Request(`${origin}/.well-known/oauth-protected-resource`))
        ).status,
      }).toEqual({ origin, status: 404 });
  });

  it("answers 405 with allow GET to another method, 204 to OPTIONS, and 404 to another path", async () => {
    const h = oauthHandle();
    const posted = await h.auth.wellKnown(
      at("/.well-known/oauth-protected-resource", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
    const options = await h.auth.wellKnown(
      at("/.well-known/oauth-authorization-server", { method: "OPTIONS" }),
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");
    expect((await h.auth.wellKnown(at("/.well-known/security.txt"))).status).toBe(404);
  });

  it("answers 404 on every document while oauth is off, and names the alg and drops the registration endpoint by the config", async () => {
    const off = oauthHandle({ oauth: false });
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-protected-resource",
    ])
      expect({ path, status: (await off.auth.wellKnown(at(path))).status }).toEqual({
        path,
        status: 404,
      });
    expect((await off.auth.handle(get("/auth/.well-known/openid-configuration"))).status).toBe(404);
    const fetch = (async () => new Response()) as typeof globalThis.fetch;
    const es = oauthHandle({
      jwtMint: { alg: "ES256" },
      oauth: { resources: [RESOURCE], registration: { dynamic: false }, fetch },
    });
    const body = (await (
      await es.auth.wellKnown(at("/.well-known/oauth-authorization-server"))
    ).json()) as Record<string, unknown>;
    expect(body.id_token_signing_alg_values_supported).toEqual(["ES256"]);
    expect(body.registration_endpoint).toBeUndefined();
    expect(body.client_id_metadata_document_supported).toBe(true);
  });
});

describe("auth.caller with an access token (plan 9g)", () => {
  it("answers kind oauth for an access token under its resource", async () => {
    const h = oauthHandle();
    const c = await accessToken(h);
    const bearer = { authorization: `Bearer ${c.access}` };
    expect(await h.auth.caller(get("/mcp/tools/list", bearer))).toMatchObject({
      kind: "oauth",
      user: { id: c.user.id },
      clientId: c.clientId,
      scopes: ["mcp:read", "offline_access"],
      resource: RESOURCE,
      tokenId: expect.any(String),
    });
    expect((await h.auth.caller(get("/mcp", bearer)))?.kind).toBe("oauth");
  });

  it("answers null for a token of another resource, and under no resource (Review Focus 3)", async () => {
    const h = oauthHandle();
    const c = await accessToken(h);
    const bearer = { authorization: `Bearer ${c.access}` };
    for (const path of ["/files", "/files/a", "/me", "/mcpx"])
      expect({ path, caller: await h.auth.caller(get(path, bearer)) }).toEqual({
        path,
        caller: null,
      });
  });

  it("the reverse: a token of the other resource answers kind oauth under it and null under /mcp (Task 7 review)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h, "mcp:read", { resource: OTHER_RESOURCE });
    const res = await h.auth.handle(
      exchange(c.code, c.clientId, c.verifier, { resource: OTHER_RESOURCE }),
    );
    const { access_token } = (await res.json()) as { access_token: string };
    const bearer = { authorization: `Bearer ${access_token}` };
    expect(await h.auth.caller(get("/files/a", bearer))).toMatchObject({
      kind: "oauth",
      resource: OTHER_RESOURCE,
    });
    for (const path of ["/mcp", "/mcp/tools/list"])
      expect({ path, caller: await h.auth.caller(get(path, bearer)) }).toEqual({
        path,
        caller: null,
      });
  });

  it("lets the cookie win, and answers null for an expired token, a session JWT, an ID token, and a token of another instance", async () => {
    const h = oauthHandle();
    const c = await accessToken(h, "openid mcp:read");
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    expect(
      (await h.auth.caller(get("/mcp", { ...bearer(c.access), cookie: c.cookie })))?.kind,
    ).toBe("session");
    const jwt = await h.auth.api.jwt?.mint({ userId: c.user.id, sessionId: c.session.id });
    if (!jwt?.ok) throw new Error("no mint");
    expect(await h.auth.caller(get("/mcp", bearer(jwt.value.token)))).toBeNull();
    expect(await h.auth.caller(get("/mcp", bearer(c.idToken)))).toBeNull();
    expect(await oauthHandle().auth.caller(get("/mcp", bearer(c.access)))).toBeNull();
    // Off the boundary on each side: one second before the lifetime ends, then one minute past it.
    h.clock.advance(15 * 60_000 - 1000);
    expect((await h.auth.caller(get("/mcp", bearer(c.access))))?.kind).toBe("oauth");
    h.clock.advance(61_000);
    expect(await h.auth.caller(get("/mcp", bearer(c.access)))).toBeNull();
  });

  it("keeps every session-only route session-only: a JWT bearer answers 401 on POST /tokens and GET /token, and auth.session answers null", async () => {
    const h = oauthHandle();
    const c = await accessToken(h);
    const bearer = { authorization: `Bearer ${c.access}` };
    expect((await h.auth.handle(post("/auth/tokens", { name: "x" }, bearer))).status).toBe(401);
    expect((await h.auth.handle(get("/auth/token", bearer))).status).toBe(401);
    expect((await h.auth.handle(get("/auth/session", bearer))).status).toBe(401);
    expect(await h.auth.session(get("/mcp", bearer))).toBeNull();
  });

  it("still answers kind oauth after a rotation, for the life of the token", async () => {
    const h = oauthHandle();
    const c = await accessToken(h);
    await h.auth.api.jwt?.rotate();
    expect((await h.auth.caller(get("/mcp", { authorization: `Bearer ${c.access}` })))?.kind).toBe(
      "oauth",
    );
  });
});
