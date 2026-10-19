import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { fromBase64Url, randomBase64Url, toBase64Url } from "../src/primitives/crypto.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";
import {
  basicHeader,
  codeFor,
  confidential,
  exchange,
  type Handle,
  ISSUER,
  OTHER_RESOURCE,
  oauthHandle,
  REDIRECT,
  RESOURCE,
  SCOPES,
  tokenPost,
} from "./oauth-helpers.js";

const DAY_MS = 86_400_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function clientsOf(h: Handle) {
  const clients = h.auth.api.oauth?.clients;
  if (!clients) throw new Error("oauth is off");
  return clients;
}

/** A confidential client of `api.oauth.clients` with the grant and `scopes`. */
async function machine(h: Handle, scopes: string[] = ["mcp:read"]) {
  const made = await clientsOf(h).create({
    name: "Billing service",
    authMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    credentialsScopes: scopes,
  });
  if (!made.ok) throw new Error(made.error);
  const secret = made.value.clientSecret;
  if (!secret) throw new Error("create answered no secret");
  return { clientId: made.value.client.id, secret };
}

/** A client_credentials request with Basic auth, from `ip`. */
function credentialsPost(
  c: { clientId: string; secret: string },
  extra: Record<string, string> = { resource: RESOURCE },
  ip = "198.51.100.7",
): Request {
  return tokenPost(
    { grant_type: "client_credentials", ...extra },
    { authorization: basicHeader(c.clientId, c.secret), "cf-connecting-ip": ip },
  );
}

async function answer(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function accessToken(
  h: Handle,
  c: { clientId: string; secret: string },
  extra?: Record<string, string>,
) {
  const r = await answer(await h.auth.handle(credentialsPost(c, extra)));
  if (r.status !== 200) throw new Error(`the grant answered ${r.status} ${String(r.body.error)}`);
  return String(r.body.access_token);
}

/** The header and the claims of a compact JWS, read here without core's decoder. */
function partsOf(jwt: string) {
  const [h, p] = jwt.split(".");
  const read = (s: string | undefined) =>
    JSON.parse(dec.decode(fromBase64Url(s ?? ""))) as Record<string, unknown>;
  return { header: read(h), payload: read(p) };
}

/** A request to the resource with `token` as the bearer. */
const atResource = (token: string, resource = RESOURCE) =>
  new Request(`${resource}/tools`, { headers: { authorization: `Bearer ${token}` } });

describe("the client_credentials grant (plan 12e Task 7)", () => {
  it("issues an access token and no refresh token (RFC 6749 4.4.3)", async () => {
    const h = oauthHandle();
    const c = await machine(h);
    const res = await h.auth.handle(credentialsPost(c, { resource: RESOURCE, scope: "mcp:read" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["access_token", "expires_in", "scope", "token_type"]);
    expect(body).toMatchObject({ token_type: "Bearer", scope: "mcp:read", expires_in: 900 });
    expect(body).not.toHaveProperty("refresh_token");
    expect(body).not.toHaveProperty("id_token");
    // No row of the refresh table holds the client: the grant writes none.
    expect(
      await h.storage.findMany("oauthToken", [{ field: "clientId", op: "eq", value: c.clientId }]),
    ).toEqual([]);
  });

  it("sets sub to client_id and carries no user claim (RFC 9068 2.2)", async () => {
    const h = oauthHandle();
    const c = await machine(h);
    const { header, payload } = partsOf(await accessToken(h, c));
    expect(header.typ).toBe("at+jwt");
    expect(Object.keys(payload).sort()).toEqual([
      "aud",
      "client_id",
      "exp",
      "iat",
      "iss",
      "jti",
      "scope",
      "sub",
    ]);
    expect(payload).toMatchObject({
      iss: ISSUER,
      sub: c.clientId,
      client_id: c.clientId,
      aud: RESOURCE,
      scope: "mcp:read",
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(900);
  });

  it("answers the oauth-client caller kind", async () => {
    const h = oauthHandle();
    const c = await machine(h);
    const token = await accessToken(h, c);
    const { payload } = partsOf(token);
    const caller = await h.auth.caller(atResource(token));
    expect(caller).toEqual({
      kind: "oauth-client",
      clientId: c.clientId,
      scopes: ["mcp:read"],
      resource: RESOURCE,
      tokenId: payload.jti,
      expiresAt: new Date(Number(payload.exp) * 1000),
      dpopJkt: null,
    });
    expect(caller).not.toHaveProperty("user");
  });

  it("never resolves a client token as a user: no session, no userinfo, no other resource", async () => {
    const h = oauthHandle();
    const c = await machine(h);
    const token = await accessToken(h, c);
    expect(await h.auth.caller(atResource(token, OTHER_RESOURCE))).toBeNull();
    expect(await h.auth.session(atResource(token))).toBeNull();
    const info = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/userinfo`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(info.status).toBe(401);
    expect(await info.json()).toEqual({ error: "invalid_token" });
    expect(info.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  });

  it("needs resource and refuses a scope outside credentialsScopes", async () => {
    const h = oauthHandle();
    const one = await machine(h, ["mcp:read"]);
    const both = await machine(h, ["mcp:read", "mcp:write"]);
    const refused = (error: string) => ({ status: 400, body: { error } });
    expect(await answer(await h.auth.handle(credentialsPost(one, {})))).toEqual(
      refused("invalid_target"),
    );
    expect(
      await answer(await h.auth.handle(credentialsPost(one, { resource: `${BASE_URL}/other` }))),
    ).toEqual(refused("invalid_target"));
    for (const scope of ["mcp:write", "mcp:read mcp:write", "openid", "offline_access", " "])
      expect({
        scope,
        r: await answer(await h.auth.handle(credentialsPost(one, { resource: RESOURCE, scope }))),
      }).toEqual({ scope, r: refused("invalid_scope") });
    // An absent scope gives every credentials scope.
    expect(partsOf(await accessToken(h, both)).payload.scope).toBe("mcp:read mcp:write");
    expect(
      partsOf(await accessToken(h, both, { resource: RESOURCE, scope: "mcp:write" })).payload.scope,
    ).toBe("mcp:write");
    // A client with the grant and no credentials scope gets no token.
    const none = await machine(h, []);
    expect(await answer(await h.auth.handle(credentialsPost(none)))).toEqual(
      refused("invalid_scope"),
    );
  });

  it("refuses a public client and a client without the grant", async () => {
    const h = oauthHandle();
    const clients = clientsOf(h);
    const pub = await clients.create({ redirectUris: [REDIRECT] });
    if (!pub.ok) throw new Error(pub.error);
    const refused = { status: 400, body: { error: "unauthorized_client" } };
    const asPublic = tokenPost({
      grant_type: "client_credentials",
      client_id: pub.value.client.id,
      resource: RESOURCE,
    });
    expect(await answer(await h.auth.handle(asPublic))).toEqual(refused);
    // A secret client of the code grant, made in code and through the route.
    const made = await clients.create({
      redirectUris: [REDIRECT],
      authMethod: "client_secret_post",
      credentialsScopes: ["mcp:read"],
    });
    if (!made.ok || !made.value.clientSecret) throw new Error("create failed");
    const codeClient = { clientId: made.value.client.id, secret: made.value.clientSecret };
    const routeClient = await confidential(h, "client_secret_basic");
    for (const c of [codeClient, routeClient])
      expect(await answer(await h.auth.handle(credentialsPost(c)))).toEqual(refused);
    // A wrong secret fails the client auth first (RFC 6749 4.4.2, ruling 19).
    const c = await machine(h);
    const wrong = await h.auth.handle(credentialsPost({ ...c, secret: `${c.secret}x` }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBe(`Basic realm="${ISSUER}"`);
    expect(await wrong.json()).toEqual({ error: "invalid_client" });
  });

  it("answers null for the token of a deleted client", async () => {
    const h = oauthHandle();
    const c = await machine(h);
    const token = await accessToken(h, c);
    expect((await h.auth.caller(atResource(token)))?.kind).toBe("oauth-client");
    expect(await clientsOf(h).delete({ clientId: c.clientId })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await h.auth.caller(atResource(token))).toBeNull();
  });

  it("answers null after the client loses the grant or the scope", async () => {
    const h = oauthHandle();
    const clients = clientsOf(h);
    const lost = await machine(h, ["mcp:read", "mcp:write"]);
    const token = await accessToken(h, lost, { resource: RESOURCE, scope: "mcp:write" });
    const kept = await accessToken(h, lost, { resource: RESOURCE, scope: "mcp:read" });
    const changed = await clients.update({
      clientId: lost.clientId,
      credentialsScopes: ["mcp:read"],
    });
    expect(changed.ok).toBe(true);
    expect(await h.auth.caller(atResource(token))).toBeNull();
    expect((await h.auth.caller(atResource(kept)))?.kind).toBe("oauth-client");
    const dropped = await clients.update({
      clientId: lost.clientId,
      redirectUris: [REDIRECT],
      grantTypes: ["authorization_code"],
    });
    expect(dropped.ok).toBe(true);
    expect(await h.auth.caller(atResource(kept))).toBeNull();
  });

  it("limits one client to 120 per 60 seconds", async () => {
    const h = oauthHandle();
    const c = await machine(h);
    const other = await machine(h);
    // A new IP for each request, so the per-IP limit of the token route does not decide.
    const from = (i: number) => `10.7.${Math.floor(i / 200)}.${i % 200}`;
    for (let i = 0; i < 120; i++)
      expect((await h.auth.handle(credentialsPost(c, undefined, from(i)))).status).toBe(200);
    expect(await answer(await h.auth.handle(credentialsPost(c, undefined, from(120))))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    // The limit is per client: another client still gets a token.
    expect((await h.auth.handle(credentialsPost(other, undefined, from(121)))).status).toBe(200);
    h.clock.advance(60_000);
    expect((await h.auth.handle(credentialsPost(c, undefined, from(122)))).status).toBe(200);
  });

  it("keeps a user token as kind oauth", async () => {
    const h = oauthHandle();
    const s = await codeFor(h);
    const res = await h.auth.handle(exchange(s.code, s.clientId, s.verifier));
    const token = String(((await res.json()) as Record<string, unknown>).access_token);
    const caller = await h.auth.caller(atResource(token));
    expect(caller).toMatchObject({ kind: "oauth", clientId: s.clientId, user: { id: s.user.id } });
    expect(caller).not.toHaveProperty("dpopJkt");
  });

  it("keeps a registered client that uses the grant out of the idle sweep (Task 3 input)", async () => {
    const h = oauthHandle();
    const clients = clientsOf(h);
    const used = await confidential(h, "client_secret_basic");
    const idle = await confidential(h, "client_secret_basic");
    for (const c of [used, idle]) {
      const r = await clients.update({
        clientId: c.clientId,
        grantTypes: ["authorization_code", "client_credentials"],
        credentialsScopes: ["mcp:read"],
      });
      expect(r).toMatchObject({ ok: true, value: { kind: "registered" } });
    }
    h.clock.advance(89 * DAY_MS);
    await accessToken(h, used);
    h.clock.advance(2 * DAY_MS);
    await h.auth.api.sweepExpired();
    const row = (id: string) =>
      h.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: id }]);
    expect(await row(used.clientId)).not.toBeNull();
    expect(await row(idle.clientId)).toBeNull();
    await accessToken(h, used);
  });
});

/** One instance with CIMD on and a fake fetch that answers from a map. */
function cimdInstance(answers: Map<string, unknown>): Handle {
  const base = makeAuth();
  const fetchFn = (async (input: RequestInfo | URL) => {
    const body = answers.get(String(input));
    if (body === undefined) throw new Error(`no fake answer for ${String(input)}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: createMemoryLimiter(base.clock),
    oauth: { resources: [RESOURCE], scopes: SCOPES, fetch: fetchFn },
  };
  return {
    auth: createAuth(input),
    config: resolveConfig(input),
    storage: base.storage,
    clock: base.clock,
  };
}

describe("a client metadata document and the grant (rulings 21 to 26)", () => {
  it("never gives the grant to a document client, also with private_key_jwt", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
    const url = "https://agent.example.org/client.json";
    const h = cimdInstance(
      new Map([
        [
          url,
          {
            client_id: url,
            client_name: "Agent",
            redirect_uris: ["https://agent.example.org/cb"],
            grant_types: ["authorization_code", "client_credentials"],
            token_endpoint_auth_method: "private_key_jwt",
            jwks: { keys: [{ ...jwk, kid: "k1" }] },
          },
        ],
      ]),
    );
    const now = Math.floor(h.clock.now().getTime() / 1000);
    const header = { alg: "EdDSA", kid: "k1" };
    const claims = {
      iss: url,
      sub: url,
      aud: ISSUER,
      exp: now + 60,
      iat: now,
      jti: randomBase64Url(16),
    };
    const input = `${toBase64Url(enc.encode(JSON.stringify(header)))}.${toBase64Url(enc.encode(JSON.stringify(claims)))}`;
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, enc.encode(input));
    const res = await h.auth.handle(
      tokenPost({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: `${input}.${toBase64Url(new Uint8Array(sig))}`,
        resource: RESOURCE,
      }),
    );
    // The assertion passed, so the refusal is of the grant, not of the auth.
    expect(await answer(res)).toEqual({ status: 400, body: { error: "unauthorized_client" } });
    const row = await h.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: url }]);
    expect(row?.grantTypes).toEqual(["authorization_code"]);
  });
});
