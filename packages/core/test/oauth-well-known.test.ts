import { describe, expect, it } from "vitest";
import { BASE_URL, get, post } from "./helpers.js";
import {
  codeFor,
  exchange,
  ISSUER,
  OTHER_RESOURCE,
  oauthHandle,
  REDIRECT,
  RESOURCE,
  tokenPost,
} from "./oauth-helpers.js";

const at = (path: string, init: RequestInit = {}) => new Request(`${BASE_URL}${path}`, init);
const SCOPES_SUPPORTED = ["openid", "profile", "email", "offline_access", "mcp:read", "mcp:write"];
const AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post", "private_key_jwt"];
const ALL_ALGS = ["EdDSA", "Ed25519", "ES256", "RS256", "PS256"];
const CLAIMS = [
  "iss",
  "sub",
  "aud",
  "iat",
  "exp",
  "at_hash",
  "sid",
  "nonce",
  "auth_time",
  "email",
  "email_verified",
  "name",
  "picture",
];
const DEVICE_URN = "urn:ietf:params:oauth:grant-type:device_code";
/** The document of `oauthHandle()`: dynamic on, CIMD off, no device grant, no fetch, EdDSA. */
const AS_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  introspection_endpoint: `${ISSUER}/oauth/introspect`,
  end_session_endpoint: `${ISSUER}/oauth/end-session`,
  userinfo_endpoint: `${ISSUER}/oauth/userinfo`,
  jwks_uri: `${ISSUER}/jwks`,
  scopes_supported: SCOPES_SUPPORTED,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
  token_endpoint_auth_methods_supported: AUTH_METHODS,
  token_endpoint_auth_signing_alg_values_supported: ALL_ALGS,
  revocation_endpoint_auth_methods_supported: AUTH_METHODS,
  introspection_endpoint_auth_methods_supported: [
    "client_secret_basic",
    "client_secret_post",
    "private_key_jwt",
  ],
  code_challenge_methods_supported: ["S256"],
  subject_types_supported: ["public", "pairwise"],
  id_token_signing_alg_values_supported: ["EdDSA"],
  dpop_signing_alg_values_supported: ALL_ALGS,
  claims_supported: CLAIMS,
  request_parameter_supported: false,
  request_uri_parameter_supported: false,
  claims_parameter_supported: false,
  backchannel_logout_supported: false,
  backchannel_logout_session_supported: false,
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: false,
};

/** The authorization server document of `h`. */
async function document(h: ReturnType<typeof oauthHandle>): Promise<Record<string, unknown>> {
  const res = await h.auth.wellKnown(at("/.well-known/oauth-authorization-server"));
  return (await res.json()) as Record<string, unknown>;
}

/** The payload of a JWS in compact form. */
const payloadOf = (jws: string): Record<string, unknown> =>
  JSON.parse(atob((jws.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")));

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
      dpop_signing_alg_values_supported: ALL_ALGS,
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

describe("the provider v2 fields of the metadata documents (plan 12e Task 17)", () => {
  const fetch = (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
  /** The device grant on, a fetch, and one DPoP alg: each member that a switch changes, changed. */
  const switched = () =>
    oauthHandle({
      oauth: {
        resources: [RESOURCE, OTHER_RESOURCE],
        scopes: { "mcp:read": "Read your documents", "mcp:write": "Change your documents" },
        registration: { cimd: false, dynamic: false },
        device: {},
        fetch,
        dpop: { algs: ["ES256"] },
      },
    });

  it("names every new field and equals the config both ways", async () => {
    expect(await document(oauthHandle())).toEqual(AS_METADATA);
    const { registration_endpoint: _, ...rest } = AS_METADATA;
    expect(await document(switched())).toEqual({
      ...rest,
      device_authorization_endpoint: `${ISSUER}/oauth/device_authorization`,
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "client_credentials",
        DEVICE_URN,
      ],
      dpop_signing_alg_values_supported: ["ES256"],
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
    });
  });

  it("lists each grant that the token route takes and no other, both ways", async () => {
    for (const h of [oauthHandle(), switched()]) {
      const listed = (await document(h)).grant_types_supported as string[];
      for (const grant of [
        "authorization_code",
        "refresh_token",
        "client_credentials",
        DEVICE_URN,
      ]) {
        const res = await h.auth.handle(tokenPost({ grant_type: grant, client_id: "cl_x" }));
        const { error } = (await res.json()) as { error: string };
        expect({ grant, listed: listed.includes(grant) }).toEqual({
          grant,
          listed: error !== "unsupported_grant_type",
        });
      }
    }
  });

  it("names an endpoint only while its route answers", async () => {
    for (const h of [oauthHandle(), switched()]) {
      const doc = await document(h);
      for (const [member, route, method] of [
        ["registration_endpoint", "/oauth/register", "POST"],
        ["introspection_endpoint", "/oauth/introspect", "POST"],
        ["device_authorization_endpoint", "/oauth/device_authorization", "POST"],
        ["end_session_endpoint", "/oauth/end-session", "GET"],
      ] as const) {
        const path = `${ISSUER}${route}`;
        const res = await h.auth.handle(
          new Request(path, {
            method,
            ...(method === "POST"
              ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" }
              : {}),
          }),
        );
        expect({ member, named: doc[member] === path }).toEqual({
          member,
          named: res.status !== 404,
        });
      }
    }
  });

  it("holds backchannel_logout_supported and backchannel_logout_session_supported to oauth.fetch (ruling 49)", async () => {
    const off = await document(oauthHandle());
    expect([off.backchannel_logout_supported, off.backchannel_logout_session_supported]).toEqual([
      false,
      false,
    ]);
    const on = await document(switched());
    expect([on.backchannel_logout_supported, on.backchannel_logout_session_supported]).toEqual([
      true,
      true,
    ]);
  });

  it("names dpop_signing_alg_values_supported in each protected resource document", async () => {
    for (const [h, algs] of [
      [oauthHandle(), ALL_ALGS],
      [switched(), ["ES256"]],
    ] as const)
      for (const path of ["", "/mcp", "/files"]) {
        const res = await h.auth.wellKnown(at(`/.well-known/oauth-protected-resource${path}`));
        const body = (await res.json()) as Record<string, unknown>;
        expect({ path, algs: body.dpop_signing_alg_values_supported }).toEqual({ path, algs });
      }
  });

  it("lists RS256 only when jwtMint.alg is RS256", async () => {
    for (const alg of ["EdDSA", "ES256", "RS256"] as const) {
      const doc = await document(oauthHandle({ jwtMint: { alg } }));
      expect({ alg, listed: doc.id_token_signing_alg_values_supported }).toEqual({
        alg,
        listed: [alg],
      });
    }
  });

  it("names in claims_supported each claim of a real ID token and userinfo answer", async () => {
    const h = oauthHandle();
    const c = await codeFor(h, "openid email profile", { nonce: "n-1" });
    const res = await h.auth.handle(exchange(c.code, c.clientId, c.verifier));
    const t = (await res.json()) as { access_token: string; id_token: string };
    const info = await h.auth.handle(
      get("/auth/oauth/userinfo", { authorization: `Bearer ${t.access_token}` }),
    );
    const seen = new Set([
      ...Object.keys(payloadOf(t.id_token)),
      ...Object.keys((await info.json()) as Record<string, unknown>),
    ]);
    expect([...seen].sort()).toEqual(
      [...((await document(h)).claims_supported as string[])].sort(),
    );
  });

  it("refuses at registration each auth method and subject type that the document does not name", async () => {
    const h = oauthHandle();
    const doc = await document(h);
    for (const [field, value, named] of [
      ["token_endpoint_auth_method", "client_secret_jwt", "token_endpoint_auth_methods_supported"],
      ["token_endpoint_auth_method", "tls_client_auth", "token_endpoint_auth_methods_supported"],
      ["subject_type", "other", "subject_types_supported"],
    ] as const) {
      expect((doc[named] as string[]).includes(value)).toBe(false);
      const res = await h.auth.handle(
        post("/auth/oauth/register", { redirect_uris: [REDIRECT], [field]: value }),
      );
      expect({ value, status: res.status }).toEqual({ value, status: 400 });
    }
    for (const value of ["public", "pairwise"]) {
      const res = await h.auth.handle(
        post("/auth/oauth/register", { redirect_uris: [REDIRECT], subject_type: value }),
      );
      expect({ value, status: res.status }).toEqual({ value, status: 201 });
    }
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
