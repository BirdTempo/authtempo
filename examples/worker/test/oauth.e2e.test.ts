import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { BASE, lastLink } from "./helpers.js";

const PW = "correct horse battery";
// An IP of its own, so the limits that other e2e files use do not count here.
const IP = { "cf-connecting-ip": "203.0.113.90" };
const REDIRECT = "http://127.0.0.1:33418/callback";
const RESOURCE = `${BASE}/mcp`;
// A second resource of the TEST_MODE config, with no route.
const OTHER_RESOURCE = `${BASE}/files`;
const ISSUER = `${BASE}/auth`;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64 = (s: string) =>
  Uint8Array.from(
    atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)),
    (c) => c.charCodeAt(0),
  );
const json = (body: unknown, cookie = "") => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: BASE,
    ...IP,
    ...(cookie ? { cookie } : {}),
  },
  body: JSON.stringify(body),
});
const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  redirect: "manual" as const,
  headers: { "content-type": "application/x-www-form-urlencoded", ...IP, ...headers },
  body: new URLSearchParams(body).toString(),
});
const named = (res: Response, name: string) =>
  (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0] ?? "";

/** A verified user: the sign-up, then the mailed verify link. Answers the session cookie. */
async function verifiedUser(email: string): Promise<string> {
  await SELF.fetch(`${BASE}/auth/password/sign-up`, json({ email, password: PW }));
  const token = (await lastLink()).searchParams.get("token") ?? "";
  const verified = await SELF.fetch(
    `${BASE}/auth/password/verify`,
    form({ token }, { origin: BASE }),
  );
  return named(verified, "__Host-tempo_session");
}

/** The payload of an EdDSA JWT whose signature verifies against /auth/jwks, plus its typ. */
async function verifiedPayload(token: string): Promise<Record<string, unknown>> {
  const [h = "", p = "", s = ""] = token.split(".");
  const header = JSON.parse(dec.decode(fromB64(h))) as { kid: string; alg: string; typ: string };
  const { keys } = (await (await SELF.fetch(`${BASE}/auth/jwks`)).json()) as {
    keys: { kid: string; kty: string; crv: string; x: string }[];
  };
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "EdDSA") throw new Error("no key for the token");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64(s), enc.encode(`${h}.${p}`))))
    throw new Error("the signature does not verify");
  return { ...(JSON.parse(dec.decode(fromB64(p))) as Record<string, unknown>), typ: header.typ };
}

async function pkce() {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))),
  );
  return { verifier, challenge };
}

/**
 * A fake MCP client: register, authorize with the user's session, allow, and exchange.
 * `client` gives another redirect URI and more registration fields, such as `subject_type`.
 */
async function connect(
  email: string,
  scope: string,
  resource = RESOURCE,
  client: { redirect?: string; metadata?: Record<string, unknown> } = {},
) {
  const redirect = client.redirect ?? REDIRECT;
  const cookie = await verifiedUser(email);
  const reg = await SELF.fetch(`${ISSUER}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...IP },
    body: JSON.stringify({
      redirect_uris: [redirect],
      client_name: "Fake MCP client",
      ...client.metadata,
    }),
  });
  expect(reg.status).toBe(201);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = await pkce();
  // A random nonce, so the ID token proves the round trip of this request.
  const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    resource,
    state: "s-1",
    nonce,
  };
  const page = await SELF.fetch(`${ISSUER}/oauth/authorize?${new URLSearchParams(params)}`, {
    redirect: "manual",
    headers: { cookie, ...IP },
  });
  // The form posts the held request's short id (plan 9h). A clone: the test reads the page again.
  const requestId =
    /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(await page.clone().text())?.[1] ?? "";
  const allowed = await SELF.fetch(
    `${ISSUER}/oauth/authorize`,
    form({ request_id: requestId, decision: "allow" }, { origin: BASE, cookie }),
  );
  const back = new URL(allowed.headers.get("location") ?? "about:blank");
  const exchanged = await SELF.fetch(
    `${ISSUER}/oauth/token`,
    form({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirect,
      resource,
    }),
  );
  expect(exchanged.status).toBe(200);
  const tokens = (await exchanged.json()) as {
    access_token: string;
    refresh_token: string;
    id_token: string;
  };
  return { cookie, clientId, params, nonce, page, back, tokens };
}

it("serves a fake MCP client end to end on D1: discovery, register, authorize, exchange, the resource, refresh, and reuse detection", async () => {
  const prm = (await (
    await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)
  ).json()) as {
    resource: string;
    authorization_servers: string[];
  };
  expect(prm).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER] });
  const as = (await (
    await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server/auth`)
  ).json()) as { issuer: string; registration_endpoint: string };
  expect(as).toMatchObject({ issuer: ISSUER, registration_endpoint: `${ISSUER}/oauth/register` });

  const c = await connect("mcp-a@example.com", "openid email mcp:tools offline_access");
  expect(c.page.status).toBe(200);
  expect(await c.page.text()).toContain("Fake MCP client");
  expect(c.back.searchParams.get("state")).toBe("s-1");
  expect(c.back.searchParams.get("iss")).toBe(ISSUER);
  expect(await verifiedPayload(c.tokens.access_token)).toMatchObject({
    typ: "at+jwt",
    iss: ISSUER,
    aud: RESOURCE,
    client_id: c.clientId,
    scope: "openid email mcp:tools offline_access",
  });
  expect(await verifiedPayload(c.tokens.id_token)).toMatchObject({
    typ: "JWT",
    aud: c.clientId,
    nonce: c.nonce,
    email: "mcp-a@example.com",
  });

  const bearer = { authorization: `Bearer ${c.tokens.access_token}` };
  const called = await SELF.fetch(`${BASE}/mcp/tools`, { headers: bearer });
  expect(called.status).toBe(200);
  expect(await called.json()).toMatchObject({ clientId: c.clientId });
  // The userinfo endpoint answers the claims of the scopes for the same access token.
  const info = await SELF.fetch(`${ISSUER}/oauth/userinfo`, { headers: bearer });
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({ email: "mcp-a@example.com" });
  // The session-only route refuses the access token, and the resource refuses a request with no token.
  expect((await SELF.fetch(`${BASE}/me`, { headers: bearer })).status).toBe(401);
  const anonymous = await SELF.fetch(`${BASE}/mcp`);
  expect(anonymous.status).toBe(401);
  // MCP 2026-07-28: the 401 names the scope that the route needs.
  expect(anonymous.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`,
  );

  // The rotation and the reuse detection run as D1 conditional updates.
  const refresh = (token: string) =>
    SELF.fetch(
      `${ISSUER}/oauth/token`,
      form({ grant_type: "refresh_token", refresh_token: token, client_id: c.clientId }),
    );
  const rotated = (await (await refresh(c.tokens.refresh_token)).json()) as {
    refresh_token: string;
  };
  expect(rotated.refresh_token).toMatch(/^or_/);
  expect(await (await refresh(c.tokens.refresh_token)).json()).toEqual({ error: "invalid_grant" });
  expect(await (await refresh(rotated.refresh_token)).json()).toEqual({ error: "invalid_grant" });
  const left = await env.DB.prepare("SELECT count(*) AS n FROM ta_oauth_token WHERE client_id = ?")
    .bind(c.clientId)
    .first<number>("n");
  expect(left).toBe(0);
});

it("answers the token subject at /mcp: the pairwise subject for a pairwise client (ruling 39 of plan 12e)", async () => {
  // A redirect URI on a host, so the client has a sector. A loopback URI is no sector.
  const c = await connect("mcp-p@example.com", "mcp:tools", RESOURCE, {
    redirect: "https://rp.example.org/callback",
    metadata: { subject_type: "pairwise" },
  });
  const sub = String((await verifiedPayload(c.tokens.access_token)).sub);
  expect(sub).toMatch(/^ps_/);
  const session = await SELF.fetch(`${ISSUER}/session`, { headers: { cookie: c.cookie, ...IP } });
  const { user } = (await session.json()) as { user: { id: string } };
  expect(sub).not.toBe(user.id);
  // The route answers what the client may see, never the user id behind it.
  const called = await SELF.fetch(`${BASE}/mcp/tools`, {
    headers: { authorization: `Bearer ${c.tokens.access_token}` },
  });
  expect(called.status).toBe(200);
  expect(await called.json()).toMatchObject({ sub, clientId: c.clientId });
  // A public client's token names the user id, and the route answers it.
  const pub = await connect("mcp-q@example.com", "mcp:tools");
  const pubSub = String((await verifiedPayload(pub.tokens.access_token)).sub);
  const pubCalled = await SELF.fetch(`${BASE}/mcp/tools`, {
    headers: { authorization: `Bearer ${pub.tokens.access_token}` },
  });
  const pubSession = await SELF.fetch(`${ISSUER}/session`, {
    headers: { cookie: pub.cookie, ...IP },
  });
  const { user: pubUser } = (await pubSession.json()) as { user: { id: string } };
  expect(pubSub).toBe(pubUser.id);
  expect(await pubCalled.json()).toMatchObject({ sub: pubSub });
});

it("answers 401 at /mcp to a session cookie, a tk_ token, and a token of another resource, and 403 to a token without mcp:tools", async () => {
  const c = await connect("mcp-c@example.com", "openid", RESOURCE);
  const created = await SELF.fetch(`${BASE}/auth/tokens`, json({ name: "cli" }, c.cookie));
  expect(created.status).toBe(200);
  const { token: apiToken } = (await created.json()) as { token: string };
  const other = await connect("mcp-d@example.com", "mcp:tools", OTHER_RESOURCE);
  const metadata = `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`;
  // A cookie is no bearer: no error code. A bearer that the route refuses: invalid_token.
  // A Basic header is no bearer. With a session cookie core reads the cookie and never
  // the bearer, so a cookie plus a valid bearer gets no error code either.
  for (const [headers, error] of [
    [{ cookie: c.cookie }, ""],
    [{ authorization: "Basic dXNlcjpwYXNz" }, ""],
    [{ cookie: c.cookie, authorization: `Bearer ${c.tokens.access_token}` }, ""],
    [{ authorization: `Bearer ${apiToken}` }, 'error="invalid_token", '],
    [{ authorization: `Bearer ${other.tokens.access_token}` }, 'error="invalid_token", '],
  ] as const) {
    const res = await SELF.fetch(`${BASE}/mcp/tools`, { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer ${error}${metadata}, scope="mcp:tools"`,
    );
  }
  // The token is for this resource, but its scope is openid alone.
  const narrow = await SELF.fetch(`${BASE}/mcp/tools`, {
    headers: { authorization: `Bearer ${c.tokens.access_token}` },
  });
  expect(narrow.status).toBe(403);
  expect(await narrow.json()).toEqual({ error: "insufficient_scope" });
  expect(narrow.headers.get("www-authenticate")).toBe(
    `Bearer error="insufficient_scope", scope="mcp:tools", ${metadata}`,
  );
});

it("lists and ends a grant on D1: the session routes delete the consent and the refresh tokens", async () => {
  const c = await connect("mcp-e@example.com", "mcp:tools offline_access");
  const listed = await SELF.fetch(`${ISSUER}/oauth/grants`, {
    headers: { cookie: c.cookie, ...IP },
  });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({
    grants: [
      {
        clientId: c.clientId,
        clientName: "Fake MCP client",
        scopes: ["mcp:tools", "offline_access"],
        refreshTokens: 1,
      },
    ],
  });
  const revoked = await SELF.fetch(
    `${ISSUER}/oauth/grants/revoke`,
    json({ clientId: c.clientId }, c.cookie),
  );
  expect(await revoked.json()).toEqual({ ok: true });
  const count = (table: string) =>
    env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE client_id = ?`)
      .bind(c.clientId)
      .first<number>("n");
  expect(await count("ta_oauth_token")).toBe(0);
  expect(await count("ta_oauth_consent")).toBe(0);
  const refreshed = await SELF.fetch(
    `${ISSUER}/oauth/token`,
    form({
      grant_type: "refresh_token",
      refresh_token: c.tokens.refresh_token,
      client_id: c.clientId,
    }),
  );
  expect(await refreshed.json()).toEqual({ error: "invalid_grant" });
});

it("stores hashes and a sealed key only, revokes a family of two rows, and answers the well-known paths on D1 that consumerb's clients read", async () => {
  const c = await connect("mcp-b@example.com", "mcp:tools offline_access");
  const row = await env.DB.prepare("SELECT token_hash FROM ta_oauth_token WHERE client_id = ?")
    .bind(c.clientId)
    .first<{ token_hash: string }>();
  expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  const key = await env.DB.prepare(
    "SELECT public_jwk, private_key FROM ta_jwk WHERE slot = 'signing'",
  ).first<{
    public_jwk: string;
    private_key: string;
  }>();
  expect(JSON.parse(key?.public_jwk ?? "{}")).not.toHaveProperty("d");
  // A clear Ed25519 PKCS#8 key is 48 bytes, 64 characters. The sealed form adds the IV and the tag: 102.
  expect(key?.private_key).toMatch(/^[A-Za-z0-9_-]{100,}$/);

  // One rotation first, so the family holds two rows: the spent one and the live one.
  const rotated = await SELF.fetch(
    `${ISSUER}/oauth/token`,
    form({
      grant_type: "refresh_token",
      refresh_token: c.tokens.refresh_token,
      client_id: c.clientId,
    }),
  );
  const { refresh_token: live } = (await rotated.json()) as { refresh_token: string };
  const before = await env.DB.prepare(
    "SELECT count(*) AS n FROM ta_oauth_token WHERE client_id = ?",
  )
    .bind(c.clientId)
    .first<number>("n");
  expect(before).toBe(2);
  const revoked = await SELF.fetch(
    `${ISSUER}/oauth/revoke`,
    form({ token: live, client_id: c.clientId }),
  );
  expect(revoked.status).toBe(200);
  const left = await env.DB.prepare("SELECT count(*) AS n FROM ta_oauth_token WHERE client_id = ?")
    .bind(c.clientId)
    .first<number>("n");
  expect(left).toBe(0);

  expect((await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`)).status).toBe(200);
  expect((await SELF.fetch(`${ISSUER}/.well-known/oauth-authorization-server`)).status).toBe(200);
  expect((await SELF.fetch(`${ISSUER}/.well-known/oauth-protected-resource`)).status).toBe(404);
  const posted = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(posted.status).toBe(405);
  const jwks = await SELF.fetch(`${ISSUER}/jwks`);
  expect(jwks.headers.get("cache-control")).toBe("public, max-age=300");
});
