import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { authorizeQuery } from "../src/http/contract/oauth.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { fromBase64Url, sha256Hex } from "../src/primitives/crypto.js";
import { APP_ORIGIN, BASE_URL, makeAuth, post } from "./helpers.js";
import {
  authorized,
  basicHeader,
  confidential,
  consentPost,
  exchange,
  type Handle,
  pkce,
  REDIRECT,
  RESOURCE,
  registered,
  requestIdOf,
  SCOPES,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";
import { type DpopKey, dpopKey } from "./support/dpop-key.js";

/**
 * DPoP in core (plan 12e Task 9, RFC 9449 read 2026-10-20). The tests hold
 * the binding at each grant, the code of `dpop_jkt`, and the refresh token
 * of a public client. They also hold the replay store across instances and
 * the `DPoP` scheme on each path that resolves an access token.
 */

const TOKEN_URL = `${BASE_URL}/auth/oauth/token`;
const USERINFO_URL = `${BASE_URL}/auth/oauth/userinfo`;
const ALGS = 'algs="EdDSA Ed25519 ES256 RS256 PS256"';
const dec = new TextDecoder();

/**
 * One core instance on `shared`'s storage and clock, or on new ones. One
 * resource, so every introspection client sees its tokens.
 */
function instance(shared?: Handle): Handle {
  const base = shared ? { storage: shared.storage, clock: shared.clock } : makeAuth();
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: createMemoryLimiter(base.clock),
    oauth: { resources: [RESOURCE], scopes: SCOPES, registration: { cimd: false, dynamic: true } },
  };
  return {
    auth: createAuth(input),
    config: resolveConfig(input),
    storage: base.storage,
    clock: base.clock,
  };
}

const nowS = (h: Handle) => Math.floor(h.clock.now().getTime() / 1000);

/** A proof for the token endpoint at the clock of `h`. */
const tokenProof = (h: Handle, key: DpopKey) => key.proof({ htu: TOKEN_URL, iat: nowS(h) });

/** A proof for a resource request with `token`. */
const resourceProof = (h: Handle, key: DpopKey, token: string, htu = RESOURCE, htm = "GET") =>
  key.proof({ htu, htm, iat: nowS(h), accessToken: token });

async function answer(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(dec.decode(fromBase64Url(jwt.split(".")[1] ?? ""))) as Record<string, unknown>;
}

let users = 0;

/**
 * A code of a public client for a new signed-in user. `params` go into the
 * authorize query, and the consent form allows the held request.
 */
async function publicCode(h: Handle, params: Record<string, string> = {}, clientId?: string) {
  users += 1;
  const s = await signedIn(h, `user${users}@example.com`);
  const id = clientId ?? (await registered(h));
  const p = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: id,
    redirect_uri: REDIRECT,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    scope: "openid mcp:read offline_access",
    resource: RESOURCE,
    state: "st-1",
    ...params,
  });
  const page = await h.auth.handle(
    new Request(`${BASE_URL}/auth/oauth/authorize?${query}`, { headers: { cookie: s.cookie } }),
  );
  let location = page.headers.get("location");
  if (page.status === 200) {
    const allow = { request_id: requestIdOf(await page.text()), decision: "allow" };
    location = (await h.auth.handle(consentPost(allow, { cookie: s.cookie }))).headers.get(
      "location",
    );
  }
  const url = new URL(location ?? "");
  return { ...s, clientId: id, verifier: p.verifier, code: url.searchParams.get("code"), url };
}

/** A code exchange with `proof` as the DPoP header, or with none, at `url` (default TOKEN_URL). */
async function exchangeWith(
  h: Handle,
  c: { code: string | null; clientId: string; verifier: string },
  proof: string | null,
  headers: Record<string, string> = {},
  url = TOKEN_URL,
) {
  const req = exchange(c.code ?? "", c.clientId, c.verifier);
  const out = new Request(url, {
    method: "POST",
    headers: new Headers(req.headers),
    body: await req.text(),
  });
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  if (proof !== null) out.headers.set("dpop", proof);
  return answer(await h.auth.handle(out));
}

async function refreshWith(
  h: Handle,
  body: Record<string, string>,
  proof: string | null,
  headers: Record<string, string> = {},
) {
  const req = tokenPost(
    { grant_type: "refresh_token", ...body },
    { ...headers, ...(proof !== null ? { dpop: proof } : {}) },
  );
  return answer(await h.auth.handle(req));
}

const resourceRequest = (token: string, scheme: string, proof?: string, url = RESOURCE) =>
  new Request(url, {
    headers: { authorization: `${scheme} ${token}`, ...(proof ? { dpop: proof } : {}) },
  });

const BAD_PROOF = { status: 400, body: { error: "invalid_dpop_proof" } };

describe("DPoP at the token endpoint (RFC 9449 section 5)", () => {
  it("binds an access token to the key of a valid proof", async () => {
    const h = instance();
    const key = await dpopKey();
    const c = await publicCode(h);
    const r = await exchangeWith(h, c, await tokenProof(h, key));
    expect(r).toMatchObject({ status: 200, body: { token_type: "DPoP" } });
    expect(claimsOf(String(r.body.access_token)).cnf).toEqual({ jkt: key.jkt });
  });

  it("answers invalid_dpop_proof to a bad proof at the token endpoint", async () => {
    const h = instance();
    const key = await dpopKey();
    const c = await publicCode(h);
    const wrongUrl = await key.proof({ htu: `${BASE_URL}/auth/oauth/revoke`, iat: nowS(h) });
    expect(await exchangeWith(h, c, wrongUrl)).toEqual(BAD_PROOF);
    expect(await exchangeWith(h, c, "not-a-proof")).toEqual(BAD_PROOF);
    // The proof is checked before the grant, so the code is not spent.
    expect(await exchangeWith(h, c, await tokenProof(h, key))).toMatchObject({ status: 200 });
  });

  it("needs a proof on every grant for a dpopBound client", async () => {
    const h = instance();
    const key = await dpopKey();
    const reg = await answer(
      await h.auth.handle(
        post("/auth/oauth/register", {
          redirect_uris: [REDIRECT],
          dpop_bound_access_tokens: true,
        }),
      ),
    );
    const clientId = String(reg.body.client_id);
    const c = await publicCode(h, {}, clientId);
    expect(await exchangeWith(h, c, null)).toEqual(BAD_PROOF);
    const ok = await exchangeWith(h, c, await tokenProof(h, key));
    expect(ok).toMatchObject({ status: 200, body: { token_type: "DPoP" } });
    const refresh = { refresh_token: String(ok.body.refresh_token), client_id: clientId };
    expect(await refreshWith(h, refresh, null)).toEqual(BAD_PROOF);
    expect(await refreshWith(h, refresh, await tokenProof(h, key))).toMatchObject({
      status: 200,
      body: { token_type: "DPoP" },
    });
    // The client_credentials grant of a bound client of api.oauth.clients.
    const made = await h.auth.api.oauth?.clients.create({
      authMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      credentialsScopes: ["mcp:read"],
      dpopBound: true,
    });
    if (!made?.ok || !made.value.clientSecret) throw new Error("create failed");
    const auth = { authorization: basicHeader(made.value.client.id, made.value.clientSecret) };
    const grant = (proof: string | null) =>
      h.auth.handle(
        tokenPost(
          { grant_type: "client_credentials", resource: RESOURCE },
          { ...auth, ...(proof !== null ? { dpop: proof } : {}) },
        ),
      );
    expect(await answer(await grant(null))).toEqual(BAD_PROOF);
    const bound = await answer(await grant(await tokenProof(h, key)));
    expect(bound).toMatchObject({ status: 200, body: { token_type: "DPoP" } });
    expect(claimsOf(String(bound.body.access_token)).cnf).toEqual({ jkt: key.jkt });
    const caller = await h.auth.caller(
      resourceRequest(
        String(bound.body.access_token),
        "DPoP",
        await resourceProof(h, key, String(bound.body.access_token)),
      ),
    );
    expect(caller).toMatchObject({ kind: "oauth-client", dpopJkt: key.jkt });
    expect(await h.auth.caller(resourceRequest(String(bound.body.access_token), "Bearer"))).toBe(
      null,
    );
  });

  it("binds the code to dpop_jkt of the authorize request", async () => {
    const h = instance();
    const key = await dpopKey();
    const other = await dpopKey();
    const clientId = await registered(h);
    const bound = { dpop_jkt: key.jkt };
    const first = await publicCode(h, bound, clientId);
    expect(await exchangeWith(h, first, await tokenProof(h, other))).toEqual(BAD_PROOF);
    const second = await publicCode(h, bound, clientId);
    expect(await exchangeWith(h, second, null)).toEqual(BAD_PROOF);
    const third = await publicCode(h, bound, clientId);
    expect(await exchangeWith(h, third, await tokenProof(h, key))).toMatchObject({
      status: 200,
      body: { token_type: "DPoP" },
    });
    // The contract reads the same pattern as the engine (ruling 31).
    const query = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT };
    const asked = { ...query, scope: "mcp:read", resource: RESOURCE };
    expect(authorizeQuery.safeParse({ ...asked, dpop_jkt: key.jkt }).success).toBe(true);
    expect(authorizeQuery.safeParse({ ...asked, dpop_jkt: key.jkt.slice(1) }).success).toBe(false);
    // dpop_jkt is a thumbprint: 43 base64url characters.
    for (const dpop_jkt of [key.jkt.slice(1), `${key.jkt}=`, `${key.jkt.slice(1)}+`]) {
      const bad = await publicCode(h, { dpop_jkt }, clientId);
      expect({ dpop_jkt, error: bad.url.searchParams.get("error") }).toEqual({
        dpop_jkt,
        error: "invalid_request",
      });
    }
  });

  it("binds a public client's refresh token to the key and leaves a confidential client's unbound (RFC 9449 5)", async () => {
    const h = instance();
    const key = await dpopKey();
    const other = await dpopKey();
    const pub = await publicCode(h);
    const issued = await exchangeWith(h, pub, await tokenProof(h, key));
    const refresh = { refresh_token: String(issued.body.refresh_token), client_id: pub.clientId };
    const row = await h.storage.findOne("oauthToken", [
      { field: "tokenHash", op: "eq", value: await sha256Hex(refresh.refresh_token) },
    ]);
    expect(row?.dpopJkt).toBe(key.jkt);
    expect(await refreshWith(h, refresh, null)).toEqual(BAD_PROOF);
    expect(await refreshWith(h, refresh, await tokenProof(h, other))).toEqual(BAD_PROOF);
    // Each refusal ran before the spend, so the key holder still refreshes.
    const next = await refreshWith(h, refresh, await tokenProof(h, key));
    expect(next).toMatchObject({ status: 200, body: { token_type: "DPoP" } });
    const child = await h.storage.findOne("oauthToken", [
      { field: "tokenHash", op: "eq", value: await sha256Hex(String(next.body.refresh_token)) },
    ]);
    expect(child?.dpopJkt).toBe(key.jkt);

    // A confidential client authenticates at each refresh, so its refresh row stays unbound.
    const conf = await confidential(h, "client_secret_basic");
    const s = await signedIn(h, "grace@example.com");
    const p = await pkce();
    const { code } = await authorized(h, s.cookie, {
      clientId: conf.clientId,
      challenge: p.challenge,
      scope: "mcp:read offline_access",
    });
    const basic = { authorization: basicHeader(conf.clientId, conf.secret) };
    const confIssued = await exchangeWith(
      h,
      { code, clientId: conf.clientId, verifier: p.verifier },
      await tokenProof(h, key),
      basic,
    );
    expect(confIssued).toMatchObject({ status: 200, body: { token_type: "DPoP" } });
    const confRow = await h.storage.findOne("oauthToken", [
      {
        field: "tokenHash",
        op: "eq",
        value: await sha256Hex(String(confIssued.body.refresh_token)),
      },
    ]);
    expect(confRow?.dpopJkt).toBeNull();
    const confRefresh = { refresh_token: String(confIssued.body.refresh_token) };
    // Ruling 19 stays: a failed client auth answers first, with the Basic challenge, and spends no jti.
    const proof = await tokenProof(h, key);
    const wrong = { authorization: basicHeader(conf.clientId, `${conf.secret}x`) };
    const refused = await h.auth.handle(
      tokenPost({ grant_type: "refresh_token", ...confRefresh }, { ...wrong, dpop: proof }),
    );
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
    // A bad proof after a good client auth is a 400 of RFC 6749 section 5.2, with no challenge.
    const badProof = await h.auth.handle(
      tokenPost({ grant_type: "refresh_token", ...confRefresh }, { ...basic, dpop: "x.y.z" }),
    );
    expect(await answer(badProof.clone())).toEqual(BAD_PROOF);
    expect(badProof.headers.get("www-authenticate")).toBeNull();
    const again = await refreshWith(h, confRefresh, proof, basic);
    expect(again).toMatchObject({ status: 200, body: { token_type: "DPoP" } });
    // The unbound child refreshes with the client auth alone, as a Bearer grant.
    const plain = await refreshWith(
      h,
      { refresh_token: String(again.body.refresh_token) },
      null,
      basic,
    );
    expect(plain).toMatchObject({ status: 200, body: { token_type: "Bearer" } });
  });

  it("refuses a spent bound refresh token with no proof and keeps the family", async () => {
    const h = instance();
    const key = await dpopKey();
    const c = await publicCode(h);
    const issued = await exchangeWith(h, c, await tokenProof(h, key));
    const parent = { refresh_token: String(issued.body.refresh_token), client_id: c.clientId };
    const next = await refreshWith(h, parent, await tokenProof(h, key));
    expect(next.status).toBe(200);
    // A copy of the spent parent without the key fails the binding check before the reuse check.
    expect(await refreshWith(h, parent, null)).toEqual(BAD_PROOF);
    // So the family lives, and the key holder refreshes the child.
    const child = { refresh_token: String(next.body.refresh_token), client_id: c.clientId };
    expect(await refreshWith(h, child, await tokenProof(h, key))).toMatchObject({
      status: 200,
      body: { token_type: "DPoP" },
    });
  });

  it("refuses a replayed proof on a second instance", async () => {
    const first = instance();
    const second = instance(first);
    const key = await dpopKey();
    const clientId = await registered(first);
    const a = await publicCode(first, {}, clientId);
    const b = await publicCode(first, {}, clientId);
    const proof = await tokenProof(first, key);
    expect(await exchangeWith(first, a, proof)).toMatchObject({ status: 200 });
    expect(await exchangeWith(second, b, proof)).toEqual(BAD_PROOF);
    // The replay row lives twice the window of 60 s past iat, so no sweep frees a live jti.
    const rows = await first.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "dpop-proof" },
    ]);
    expect(rows.map((r) => r.expiresAt.getTime())).toEqual([(nowS(first) + 120) * 1000]);
    // The valueHash carries the purpose, so no two purposes can collide (ruling 23).
    const { jti } = claimsOf(proof);
    expect(rows[0]?.valueHash).toBe(await sha256Hex(`dpop-proof:${key.jkt}:${String(jti)}`));
    // A fresh proof of the same key passes on the second instance.
    expect(await exchangeWith(second, b, await tokenProof(second, key))).toMatchObject({
      status: 200,
    });
  });
});

describe("the DPoP scheme (RFC 9449 section 7)", () => {
  async function boundToken(h: Handle, key: DpopKey) {
    const c = await publicCode(h);
    const r = await exchangeWith(h, c, await tokenProof(h, key));
    if (r.status !== 200) throw new Error(`the exchange answered ${r.status}`);
    return { ...c, token: String(r.body.access_token), refresh: String(r.body.refresh_token) };
  }

  it("checks htu at the token route and userinfo against the public URL, not the request URL (ruling 31)", async () => {
    const h = instance();
    const key = await dpopKey();
    const c = await publicCode(h);
    // P1: a forged Host header gives another origin, and the proof names that origin.
    const evil = "https://evil.example/auth/oauth/token";
    const forged = await key.proof({ htu: evil, iat: nowS(h) });
    expect(await exchangeWith(h, c, forged, {}, evil)).toEqual(BAD_PROOF);
    // P2: a TLS proxy gives core an http URL, and the proof names the public https URL.
    const behind = "http://api.example.com/auth/oauth/token";
    const ok = await exchangeWith(h, c, await tokenProof(h, key), {}, behind);
    expect(ok).toMatchObject({ status: 200, body: { token_type: "DPoP" } });
    const token = String(ok.body.access_token);
    const userinfo = async (url: string, htu: string) =>
      (
        await h.auth.handle(
          new Request(url, {
            headers: {
              authorization: `DPoP ${token}`,
              dpop: await resourceProof(h, key, token, htu),
            },
          }),
        )
      ).status;
    const evilInfo = "https://evil.example/auth/oauth/userinfo";
    expect(await userinfo(evilInfo, evilInfo)).toBe(401);
    expect(await userinfo("http://api.example.com/auth/oauth/userinfo", USERINFO_URL)).toBe(200);
  });

  it("answers the caller for Authorization DPoP with a proof, and null for a bound token as a Bearer (RFC 9449 7.2)", async () => {
    const h = instance();
    const key = await dpopKey();
    const other = await dpopKey();
    const { token } = await boundToken(h, key);
    const proof = await resourceProof(h, key, token);
    const caller = await h.auth.caller(resourceRequest(token, "DPoP", proof));
    expect(caller).toMatchObject({ kind: "oauth", clientId: expect.any(String), dpopJkt: key.jkt });
    // The same request object again answers the same caller: auth.caller spends the proof once.
    const req = resourceRequest(token, "DPoP", await resourceProof(h, key, token));
    expect((await h.auth.caller(req))?.kind).toBe("oauth");
    expect((await h.auth.caller(req))?.kind).toBe("oauth");
    // A bound token as a Bearer, with a proof or without one.
    expect(await h.auth.caller(resourceRequest(token, "Bearer"))).toBeNull();
    expect(
      await h.auth.caller(resourceRequest(token, "Bearer", await resourceProof(h, key, token))),
    ).toBeNull();
    // The DPoP scheme with no proof, a proof of another key, a replay, or a proof of another URL.
    expect(await h.auth.caller(resourceRequest(token, "DPoP"))).toBeNull();
    expect(
      await h.auth.caller(resourceRequest(token, "DPoP", await resourceProof(h, other, token))),
    ).toBeNull();
    expect(await h.auth.caller(resourceRequest(token, "DPoP", proof))).toBeNull();
    // A request outside the token's resource, with a proof of that request.
    const files = `${BASE_URL}/files`;
    const elsewhere = await resourceProof(h, key, token, files);
    expect(await h.auth.caller(resourceRequest(token, "DPoP", elsewhere, files))).toBeNull();
    // Two DPoP headers.
    const two = new Request(RESOURCE, { headers: { authorization: `DPoP ${token}` } });
    two.headers.append("dpop", await resourceProof(h, key, token));
    two.headers.append("dpop", await resourceProof(h, key, token));
    expect(await h.auth.caller(two)).toBeNull();
  });

  it("never shares the answer of one request between two core instances (ruling 31)", async () => {
    const a = instance();
    const b = instance();
    const key = await dpopKey();
    const { token } = await boundToken(a, key);
    // B has its own storage and its own key, so it never takes a token of A.
    const first = resourceRequest(token, "DPoP", await resourceProof(a, key, token));
    expect((await a.auth.caller(first))?.kind).toBe("oauth");
    expect(await b.auth.caller(first)).toBeNull();
    // In the other order, B's null does not hide A's caller.
    const second = resourceRequest(token, "DPoP", await resourceProof(a, key, token));
    expect(await b.auth.caller(second)).toBeNull();
    expect((await a.auth.caller(second))?.kind).toBe("oauth");
  });

  it("takes a plain Bearer token with no proof as today", async () => {
    const h = instance();
    const c = await publicCode(h);
    const r = await exchangeWith(h, c, null);
    expect(r).toMatchObject({ status: 200, body: { token_type: "Bearer" } });
    const token = String(r.body.access_token);
    expect(claimsOf(token).cnf).toBeUndefined();
    expect(await h.auth.caller(resourceRequest(token, "Bearer"))).toMatchObject({
      kind: "oauth",
      dpopJkt: null,
    });
    // An unbound token under the DPoP scheme has no key to match a proof.
    const key = await dpopKey();
    expect(
      await h.auth.caller(resourceRequest(token, "DPoP", await resourceProof(h, key, token))),
    ).toBeNull();
    const row = await h.storage.findOne("oauthToken", [
      { field: "tokenHash", op: "eq", value: await sha256Hex(String(r.body.refresh_token)) },
    ]);
    expect(row?.dpopJkt).toBeNull();
  });

  it("answers userinfo for a DPoP token with a proof, with the challenges of RFC 9449 7.1", async () => {
    const h = instance();
    const key = await dpopKey();
    const { token } = await boundToken(h, key);
    const userinfo = async (scheme: string | null, proof?: string) => {
      const res = await h.auth.handle(
        new Request(USERINFO_URL, {
          headers: {
            ...(scheme !== null ? { authorization: `${scheme} ${token}` } : {}),
            ...(proof ? { dpop: proof } : {}),
          },
        }),
      );
      return {
        status: res.status,
        error: ((await res.json()) as { error?: string }).error ?? null,
        challenge: res.headers.get("www-authenticate"),
      };
    };
    const good = await resourceProof(h, key, token, USERINFO_URL);
    expect(await userinfo("DPoP", good)).toEqual({ status: 200, error: null, challenge: null });
    expect(await userinfo("Bearer")).toEqual({
      status: 401,
      error: "invalid_token",
      challenge: `Bearer error="invalid_token", DPoP ${ALGS}`,
    });
    expect(await userinfo("DPoP")).toEqual({
      status: 401,
      error: "invalid_dpop_proof",
      challenge: `DPoP error="invalid_dpop_proof", ${ALGS}`,
    });
    expect(await userinfo("DPoP", good)).toEqual({
      status: 401,
      error: "invalid_dpop_proof",
      challenge: `DPoP error="invalid_dpop_proof", ${ALGS}`,
    });
    expect(await userinfo(null)).toEqual({
      status: 401,
      error: "invalid_token",
      challenge: `Bearer, DPoP ${ALGS}`,
    });
    // A POST takes its own htm.
    const posted = await h.auth.handle(
      new Request(USERINFO_URL, {
        method: "POST",
        headers: {
          authorization: `DPoP ${token}`,
          dpop: await resourceProof(h, key, token, USERINFO_URL, "POST"),
        },
      }),
    );
    expect(posted.status).toBe(200);
    // A POST with a proof of GET is a bad proof there too.
    const wrongMethod = await h.auth.handle(
      new Request(USERINFO_URL, {
        method: "POST",
        headers: {
          authorization: `DPoP ${token}`,
          dpop: await resourceProof(h, key, token, USERINFO_URL, "GET"),
        },
      }),
    );
    expect({ status: wrongMethod.status, body: await wrongMethod.json() }).toEqual({
      status: 401,
      body: { error: "invalid_dpop_proof" },
    });
  });

  it("answers userinfo for an unbound token under DPoP and a token with no openid", async () => {
    const h = instance();
    const key = await dpopKey();
    const plain = await exchangeWith(h, await publicCode(h), null);
    const unbound = String(plain.body.access_token);
    const res = await h.auth.handle(
      new Request(USERINFO_URL, {
        headers: {
          authorization: `DPoP ${unbound}`,
          dpop: await resourceProof(h, key, unbound, USERINFO_URL),
        },
      }),
    );
    expect({ status: res.status, challenge: res.headers.get("www-authenticate") }).toEqual({
      status: 401,
      challenge: `DPoP error="invalid_token", ${ALGS}`,
    });
    const noOpenid = await publicCode(h, { scope: "mcp:read" });
    const narrow = await exchangeWith(h, noOpenid, await tokenProof(h, key));
    const token = String(narrow.body.access_token);
    const scoped = await h.auth.handle(
      new Request(USERINFO_URL, {
        headers: {
          authorization: `DPoP ${token}`,
          dpop: await resourceProof(h, key, token, USERINFO_URL),
        },
      }),
    );
    expect({ status: scoped.status, challenge: scoped.headers.get("www-authenticate") }).toEqual({
      status: 403,
      challenge: `DPoP error="insufficient_scope", scope="openid", ${ALGS}`,
    });
  });

  it("answers the key of a bound token at introspection (RFC 9449 6.2)", async () => {
    const h = instance();
    const key = await dpopKey();
    const { token } = await boundToken(h, key);
    const plain = await exchangeWith(h, await publicCode(h), null);
    const made = await h.auth.api.oauth?.clients.create({
      authMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      credentialsScopes: ["mcp:read"],
      introspect: true,
    });
    if (!made?.ok || !made.value.clientSecret) throw new Error("create failed");
    const asks = basicHeader(made.value.client.id, made.value.clientSecret);
    const ask = async (t: string) =>
      answer(
        await h.auth.handle(
          new Request(`${BASE_URL}/auth/oauth/introspect`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", authorization: asks },
            body: new URLSearchParams({ token: t }).toString(),
          }),
        ),
      );
    expect(await ask(token)).toMatchObject({
      status: 200,
      body: { active: true, token_type: "DPoP", cnf: { jkt: key.jkt } },
    });
    const unbound = await ask(String(plain.body.access_token));
    expect(unbound).toMatchObject({ status: 200, body: { active: true, token_type: "Bearer" } });
    expect(unbound.body.cnf).toBeUndefined();
  });

  it("lets a browser preflight send the DPoP header to the token endpoint", async () => {
    const h = instance();
    const clientId = await registered(h, ["https://spa.example.org/cb"]);
    const res = await h.auth.handle(
      new Request(`${TOKEN_URL}?client_id=${encodeURIComponent(clientId)}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://spa.example.org",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, dpop",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")?.split(", ")).toContain("dpop");
  });
});
