import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { fromBase64Url } from "../src/primitives/crypto.js";
import { APP_ORIGIN, BASE_URL, get, LONG_TEST_MS, post } from "./helpers.js";
import {
  authorized,
  basicHeader,
  codeFor,
  exchange,
  type Handle,
  ISSUER,
  OTHER_RESOURCE,
  oauthHandle,
  pkce,
  REDIRECT,
  RESOURCE,
  registered,
  SCOPES,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";

const DAY_MS = 86_400_000;
const dec = new TextDecoder();

interface Creds {
  clientId: string;
  secret: string;
}

function clientsOf(h: Handle) {
  const clients = h.auth.api.oauth?.clients;
  if (!clients) throw new Error("oauth is off");
  return clients;
}

/** A client of `api.oauth.clients` with a secret; `introspect` and the other fields as given. */
async function apiClient(
  h: Handle,
  input: Parameters<ReturnType<typeof clientsOf>["create"]>[0] = {},
): Promise<Creds> {
  const made = await clientsOf(h).create({
    name: "Resource server",
    authMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    credentialsScopes: ["mcp:read"],
    introspect: true,
    ...input,
  });
  if (!made.ok) throw new Error(made.error);
  const secret = made.value.clientSecret;
  if (!secret) throw new Error("create answered no secret");
  return { clientId: made.value.client.id, secret };
}

/**
 * A second instance on the storage, clock, and secret of `h`, with its own
 * limiter. `introspection` names the resources of each resource server.
 */
function twin(
  h: Handle,
  introspection?: Record<string, string[]>,
  scopes: Record<string, string> = SCOPES,
): Handle {
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: h.storage,
    mail: { send: async () => {} },
    clock: h.clock,
    limiter: createMemoryLimiter(h.clock),
    oauth: {
      resources: [RESOURCE, OTHER_RESOURCE],
      scopes,
      registration: { cimd: false, dynamic: true },
      ...(introspection ? { introspection } : {}),
    },
  };
  return {
    auth: createAuth(input),
    config: resolveConfig(input),
    storage: h.storage,
    clock: h.clock,
  };
}

/** An introspection request as a resource server sends it: a form, no Origin. */
function introspectPost(body: Record<string, string>, headers: Record<string, string>): Request {
  return new Request(`${BASE_URL}/auth/oauth/introspect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

/** The introspection of `token` by `rs` with Basic auth, from `ip`. */
async function ask(
  h: Handle,
  rs: Creds,
  token: string,
  extra: Record<string, string> = {},
  ip = "198.51.100.9",
) {
  const res = await h.auth.handle(
    introspectPost(
      { token, ...extra },
      { authorization: basicHeader(rs.clientId, rs.secret), "cf-connecting-ip": ip },
    ),
  );
  return { res, status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The claims of a compact JWS, read here without core's decoder. */
function claimsOf(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1] ?? "";
  return JSON.parse(dec.decode(fromBase64Url(part))) as Record<string, unknown>;
}

/** The token answer of a request, or the test stops. */
async function tokens(h: Handle, req: Request) {
  const res = await h.auth.handle(req);
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) throw new Error(`the token route answered ${String(body.error)}`);
  return body as { access_token: string; refresh_token?: string; id_token?: string };
}

/** A user's access token of a public client, through the real authorize and exchange. */
async function userToken(h: Handle, scope = "mcp:read offline_access") {
  const c = await codeFor(h, scope);
  const t = await tokens(h, exchange(c.code, c.clientId, c.verifier));
  return { ...c, ...t };
}

/** The same as `userToken`, for a user of `email` on its own client. */
async function userTokenOf(h: Handle, email: string, scope: string) {
  const s = await signedIn(h, email);
  const clientId = await registered(h);
  const p = await pkce();
  const { code } = await authorized(h, s.cookie, { clientId, challenge: p.challenge, scope });
  const t = await tokens(h, exchange(code, clientId, p.verifier));
  return { ...s, clientId, ...t };
}

const INACTIVE = { active: false };

describe("token introspection (plan 12e Task 8, RFC 7662)", () => {
  it("answers an active access token with its claims", async () => {
    const h = oauthHandle();
    const rs = await apiClient(h);
    const t = await userToken(h);
    const v = twin(h, { [rs.clientId]: [RESOURCE] });
    const r = await ask(v, rs, t.access_token);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.res.headers.get("pragma")).toBe("no-cache");
    expect(Object.keys(r.body).sort()).toEqual([
      "active",
      "aud",
      "client_id",
      "exp",
      "iat",
      "iss",
      "jti",
      "scope",
      "sub",
      "token_type",
    ]);
    const claims = claimsOf(t.access_token);
    expect(r.body).toEqual({
      active: true,
      scope: "mcp:read offline_access",
      client_id: t.clientId,
      sub: t.user.id,
      aud: RESOURCE,
      iss: ISSUER,
      exp: claims.exp,
      iat: claims.iat,
      jti: claims.jti,
      token_type: "Bearer",
    });
    expect(Number(r.body.exp) - Number(r.body.iat)).toBe(900);
    // The hint orders the lookups only: a wrong hint still finds the access token.
    const hinted = await ask(v, rs, t.access_token, { token_type_hint: "refresh_token" });
    expect(hinted.body.active).toBe(true);
  });

  it("answers active false at once after a grant revoke, a user delete, and a client delete, with no other member", async () => {
    const h = oauthHandle();
    const rs = await apiClient(h);
    const other = twin(h, { [rs.clientId]: [RESOURCE] });
    // A grant revoke on the first instance; the second instance answers.
    const a = await userToken(h);
    expect((await ask(other, rs, a.access_token)).body.active).toBe(true);
    h.clock.advance(5_000);
    const revoked = await h.auth.handle(
      post("/auth/oauth/grants/revoke", { clientId: a.clientId }, { cookie: a.cookie }),
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await ask(other, rs, a.access_token);
    expect(afterRevoke.status).toBe(200);
    expect(Object.keys(afterRevoke.body)).toEqual(["active"]);
    expect(afterRevoke.body).toEqual(INACTIVE);
    // A new consent for the same client does not bring back a token of the revoked grant.
    const p = await pkce();
    const again = await authorized(h, a.cookie, { clientId: a.clientId, challenge: p.challenge });
    const fresh = await tokens(h, exchange(again.code, a.clientId, p.verifier));
    expect((await ask(other, rs, fresh.access_token)).body.active).toBe(true);
    expect((await ask(other, rs, a.access_token)).body).toEqual(INACTIVE);

    // A user delete.
    const b = await userTokenOf(twin(h), "bob@example.com", "mcp:read");
    expect((await ask(other, rs, b.access_token)).body.active).toBe(true);
    const deleted = await h.auth.handle(post("/auth/user/delete", {}, { cookie: b.cookie }));
    expect(deleted.status).toBe(200);
    const afterDelete = await ask(other, rs, b.access_token);
    expect(Object.keys(afterDelete.body)).toEqual(["active"]);
    expect(afterDelete.body).toEqual(INACTIVE);

    // A client delete.
    const h2 = oauthHandle();
    const rs2 = await apiClient(h2);
    const other2 = twin(h2, { [rs2.clientId]: [RESOURCE] });
    const c = await userToken(h2, "mcp:read");
    expect((await ask(other2, rs2, c.access_token)).body.active).toBe(true);
    expect(await clientsOf(h2).delete({ clientId: c.clientId })).toEqual({
      ok: true,
      value: { ok: true },
    });
    const afterClient = await ask(other2, rs2, c.access_token);
    expect(Object.keys(afterClient.body)).toEqual(["active"]);
    expect(afterClient.body).toEqual(INACTIVE);
  });

  it("answers an oauth-client token while its client keeps the scope", async () => {
    const h = oauthHandle();
    const rs = await apiClient(h);
    const sees = { [rs.clientId]: [RESOURCE] };
    const other = twin(h, sees);
    const machine = await apiClient(h, { name: "Billing service", introspect: false });
    const grant = (c: Creds, ip: string) =>
      tokens(
        h,
        tokenPost(
          { grant_type: "client_credentials", resource: RESOURCE },
          { authorization: basicHeader(c.clientId, c.secret), "cf-connecting-ip": ip },
        ),
      );
    const t = await grant(machine, "198.51.100.21");
    const live = await ask(other, rs, t.access_token);
    const claims = claimsOf(t.access_token);
    expect(live.body).toEqual({
      active: true,
      scope: "mcp:read",
      client_id: machine.clientId,
      sub: machine.clientId,
      aud: RESOURCE,
      iss: ISSUER,
      exp: claims.exp,
      iat: claims.iat,
      jti: claims.jti,
      token_type: "Bearer",
    });
    // A config that drops the scope ends the token on that instance (ruling 28).
    expect((await ask(twin(h, sees, { "mcp:write": "Change" }), rs, t.access_token)).body).toEqual(
      INACTIVE,
    );
    // The scope leaves credentialsScopes.
    const dropped = await clientsOf(h).update({
      clientId: machine.clientId,
      credentialsScopes: [],
    });
    expect(dropped.ok).toBe(true);
    expect((await ask(other, rs, t.access_token)).body).toEqual(INACTIVE);
    // A client that loses the grant.
    const second = await apiClient(h, { name: "Mail service", introspect: false });
    const t2 = await grant(second, "198.51.100.22");
    expect((await ask(other, rs, t2.access_token)).body.active).toBe(true);
    const lost = await clientsOf(h).update({
      clientId: second.clientId,
      grantTypes: ["authorization_code"],
      redirectUris: [REDIRECT],
    });
    expect(lost.ok).toBe(true);
    expect((await ask(other, rs, t2.access_token)).body).toEqual(INACTIVE);
  });

  it("answers a refresh token only to its own client", async () => {
    const h = oauthHandle();
    const owner = await apiClient(h, {
      name: "Web app",
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [REDIRECT],
      credentialsScopes: [],
    });
    const rs = await apiClient(h);
    const v = twin(h, { [owner.clientId]: [RESOURCE], [rs.clientId]: [RESOURCE] });
    const s = await signedIn(h);
    const p = await pkce();
    const { code } = await authorized(h, s.cookie, {
      clientId: owner.clientId,
      challenge: p.challenge,
    });
    const basic = { authorization: basicHeader(owner.clientId, owner.secret) };
    const t = await tokens(
      h,
      tokenPost(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: p.verifier,
          redirect_uri: REDIRECT,
          resource: RESOURCE,
        },
        basic,
      ),
    );
    const refresh = t.refresh_token ?? "";
    const row = await h.storage.findOne("oauthToken", [
      { field: "clientId", op: "eq", value: owner.clientId },
    ]);
    if (!row) throw new Error("no refresh row");
    const own = await ask(v, owner, refresh, { token_type_hint: "refresh_token" });
    expect(own.body).toEqual({
      active: true,
      scope: "mcp:read offline_access",
      client_id: owner.clientId,
      sub: s.user.id,
      aud: RESOURCE,
      iss: ISSUER,
      exp: Math.floor(row.expiresAt.getTime() / 1000),
      iat: Math.floor(row.createdAt.getTime() / 1000),
      jti: row.id,
      token_type: "Bearer",
    });
    // Another resource server learns nothing of it.
    const theirs = await ask(v, rs, refresh);
    expect(Object.keys(theirs.body)).toEqual(["active"]);
    expect(theirs.body).toEqual(INACTIVE);
    // A spent token is inactive; its child is live until its expiry.
    const next = await tokens(
      h,
      tokenPost({ grant_type: "refresh_token", refresh_token: refresh }, basic),
    );
    expect((await ask(v, owner, refresh)).body).toEqual(INACTIVE);
    const child = next.refresh_token ?? "";
    expect((await ask(v, owner, child)).body.active).toBe(true);
    h.clock.advance(31 * DAY_MS);
    expect((await ask(v, owner, child)).body).toEqual(INACTIVE);
  });

  it("answers a refresh token to its own client with no map entry, with only the served scopes (ruling 30)", async () => {
    const h = oauthHandle();
    const owner = await apiClient(h, {
      name: "Web app",
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [REDIRECT],
      credentialsScopes: [],
    });
    const s = await signedIn(h);
    const basic = { authorization: basicHeader(owner.clientId, owner.secret) };
    const grant = async (scope: string) => {
      const p = await pkce();
      const { code } = await authorized(h, s.cookie, {
        clientId: owner.clientId,
        challenge: p.challenge,
        scope,
      });
      const form = {
        grant_type: "authorization_code",
        code,
        code_verifier: p.verifier,
        redirect_uri: REDIRECT,
        resource: RESOURCE,
      };
      return tokens(h, tokenPost(form, basic));
    };
    const both = await grant("mcp:read mcp:write offline_access");
    // Two resources and no map: the owner still sees its own refresh token.
    expect((await ask(h, owner, both.refresh_token ?? "")).body).toMatchObject({
      active: true,
      scope: "mcp:read mcp:write offline_access",
    });
    // A deploy that drops mcp:write: the second instance answers the served scopes only.
    const rs = await apiClient(h);
    const readOnly = twin(h, { [rs.clientId]: [RESOURCE] }, { "mcp:read": "Read" });
    expect((await ask(readOnly, owner, both.refresh_token ?? "")).body).toMatchObject({
      active: true,
      scope: "mcp:read offline_access",
    });
    // Its access token holds mcp:write, so it is inactive there.
    expect((await ask(readOnly, rs, both.access_token)).body).toEqual(INACTIVE);
    // A grant with no served scope but offline_access is inactive there.
    const writeOnly = await grant("mcp:write offline_access");
    expect((await ask(readOnly, owner, writeOnly.refresh_token ?? "")).body).toEqual(INACTIVE);
    expect((await ask(h, owner, writeOnly.refresh_token ?? "")).body.active).toBe(true);
  });

  it("refuses a caller without introspect: true and a public caller", async () => {
    const h = oauthHandle();
    const t = await userToken(h);
    const plain = await apiClient(h, { introspect: false });
    // With an Authorization header: 401 and the Basic challenge (ruling 19).
    const basic = await ask(h, plain, t.access_token);
    expect(basic.status).toBe(401);
    expect(basic.body).toEqual({ error: "invalid_client" });
    expect(basic.res.headers.get("www-authenticate")).toBe(`Basic realm="${ISSUER}"`);
    // The same client by the form, and a public client: no header, so 400 with no challenge.
    const viaForm = await h.auth.handle(
      introspectPost(
        { token: t.access_token, client_id: plain.clientId, client_secret: plain.secret },
        {},
      ),
    );
    expect(viaForm.status).toBe(400);
    expect(await viaForm.json()).toEqual({ error: "invalid_client" });
    expect(viaForm.headers.get("www-authenticate")).toBeNull();
    const publicId = await registered(h);
    const pub = await h.auth.handle(
      introspectPost({ token: t.access_token, client_id: publicId }, {}),
    );
    expect(pub.status).toBe(400);
    expect(await pub.json()).toEqual({ error: "invalid_client" });
    expect(pub.headers.get("www-authenticate")).toBeNull();
    // A public client with introspect: true still has no credential, so it is refused too.
    const made = await clientsOf(h).create({
      name: "Public resource server",
      authMethod: "none",
      redirectUris: [REDIRECT],
      introspect: true,
    });
    if (!made.ok) throw new Error(made.error);
    expect(made.value.client.introspect).toBe(true);
    const flagged = await h.auth.handle(
      introspectPost({ token: t.access_token, client_id: made.value.client.id }, {}),
    );
    expect(flagged.status).toBe(400);
    expect(await flagged.json()).toEqual({ error: "invalid_client" });
    // A wrong secret of an introspect client.
    const rs = await apiClient(h);
    const wrong = await ask(h, { clientId: rs.clientId, secret: `${rs.secret}x` }, t.access_token);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: "invalid_client" });
  });

  it("answers active false for a session JWT, an ID token, a tk_ token, and garbage", async () => {
    const h = oauthHandle();
    const rs = await apiClient(h);
    const t = await userToken(h, "openid mcp:read");
    const v = twin(h, { [rs.clientId]: [RESOURCE] });
    const session = await h.auth.handle(get("/auth/token", { cookie: t.cookie }));
    const sessionJwt = ((await session.json()) as { token: string }).token;
    const minted = await h.auth.handle(post("/auth/tokens", { name: "ci" }, { cookie: t.cookie }));
    const apiToken = ((await minted.json()) as { token: string }).token;
    expect(apiToken.startsWith("tk_")).toBe(true);
    const idToken = t.id_token ?? "";
    expect(idToken.split(".")).toHaveLength(3);
    // The access token of the same grant is live, so each refusal below is about its form.
    expect((await ask(v, rs, t.access_token)).body.active).toBe(true);
    const garbage = ["garbage", `or_${"A".repeat(43)}`, "a.b.c", ""];
    for (const token of [sessionJwt, idToken, apiToken, ...garbage]) {
      const r = await ask(v, rs, token);
      expect(r.status, token).toBe(200);
      expect(r.body, token).toEqual(INACTIVE);
    }
  });

  it("answers only a token of a resource that oauth.introspection gives the caller (ruling 29)", async () => {
    const h = oauthHandle();
    const mine = await apiClient(h, { name: "MCP server" });
    const files = await apiClient(h, { name: "File server" });
    const absent = await apiClient(h, { name: "Unmapped server" });
    const v = twin(h, { [mine.clientId]: [RESOURCE], [files.clientId]: [OTHER_RESOURCE] });
    const s = await signedIn(h);
    const clientId = await registered(h);
    const issue = async (resource: string) => {
      const p = await pkce();
      const { code } = await authorized(h, s.cookie, {
        clientId,
        challenge: p.challenge,
        scope: "mcp:read",
        resource,
      });
      return (await tokens(h, exchange(code, clientId, p.verifier, { resource }))).access_token;
    };
    const mcp = await issue(RESOURCE);
    const other = await issue(OTHER_RESOURCE);
    expect((await ask(v, mine, mcp)).body).toMatchObject({ active: true, aud: RESOURCE });
    expect((await ask(v, mine, other)).body).toEqual(INACTIVE);
    expect((await ask(v, files, other)).body).toMatchObject({ active: true, aud: OTHER_RESOURCE });
    expect((await ask(v, files, mcp)).body).toEqual(INACTIVE);
    // A client that the map does not name sees no token.
    expect((await ask(v, absent, mcp)).body).toEqual(INACTIVE);
    // No map and two resources: core cannot tell the caller's resource, so no caller sees a token.
    expect((await ask(h, mine, mcp)).body).toEqual(INACTIVE);
    // No map and one resource: every introspection client sees it.
    const one = oauthHandle({
      storage: h.storage,
      clock: h.clock,
      oauth: { resources: [RESOURCE], scopes: SCOPES, registration: { cimd: false } },
    });
    expect((await ask(one, absent, mcp)).body).toMatchObject({ active: true, aud: RESOURCE });
  });

  it("limits one caller to 600 per 60 seconds", async () => {
    const h = oauthHandle();
    const rs = await apiClient(h);
    const rs2 = await apiClient(h, { name: "Second resource server" });
    // Three IPs, so the per-IP count stays under its own limit.
    const ipOf = (i: number) => `198.51.100.${30 + (i % 3)}`;
    for (let i = 0; i < 600; i += 1) {
      const r = await ask(h, rs, "garbage", {}, ipOf(i));
      if (r.status !== 200) throw new Error(`request ${i + 1} answered ${r.status}`);
    }
    const over = await ask(h, rs, "garbage", {}, "198.51.100.40");
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: "rate_limited" });
    expect((await ask(h, rs2, "garbage", {}, "198.51.100.40")).status).toBe(200);
    h.clock.advance(60_000);
    expect((await ask(h, rs, "garbage", {}, "198.51.100.40")).status).toBe(200);
  });

  // It sends 600 requests from one IP. Its lowest time in the logs is 0.43 s. In the 20
  // evidence runs of 2026-10-30 to 2026-11-03 it passed in up to 1.76 s, at sampled peak load
  // 36 to 56. It timed out at the default 5 s once, at 5.01 s, in a core run beside another
  // lane at load 39.7 (2026-10-31).
  it("limits one IP to 600 per 60 seconds before the client auth", {
    timeout: LONG_TEST_MS,
  }, async () => {
    const h = oauthHandle();
    const rs = await apiClient(h);
    const wrong = { clientId: rs.clientId, secret: `${rs.secret}x` };
    for (let i = 0; i < 600; i += 1) {
      const r = await ask(h, wrong, "garbage", {}, "198.51.100.50");
      if (r.status !== 401) throw new Error(`request ${i + 1} answered ${r.status}`);
    }
    // The right secret from the same IP: the count ran before the auth.
    const over = await ask(h, rs, "garbage", {}, "198.51.100.50");
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: "rate_limited" });
    expect((await ask(h, rs, "garbage", {}, "198.51.100.51")).status).toBe(200);
  });
});
