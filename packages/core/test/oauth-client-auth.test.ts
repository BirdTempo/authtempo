import { describe, expect, it } from "vitest";
import { basicCredentials } from "../src/engine/oauth-client-auth.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { BASE_URL } from "./helpers.js";
import {
  authorized,
  authorizeGet,
  basicHeader,
  confidential,
  type Handle,
  ISSUER,
  oauthHandle,
  pkce,
  REDIRECT,
  RESOURCE,
  registered,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";

const CLIENT_ORIGIN = new URL(REDIRECT).origin;
const CLIENT = { status: 401, body: { error: "invalid_client" } };
const GRANT = { status: 400, body: { error: "invalid_grant" } };
const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

interface Code {
  code: string;
  verifier: string | null;
}

/** A code of `clientId` for the session `cookie`. With `pkce: false`, the request has no challenge. */
async function codeOf(
  h: Handle,
  cookie: string,
  clientId: string,
  o: { scope?: string; nonce?: string; pkce?: boolean } = {},
): Promise<Code> {
  const p = o.pkce === false ? null : await pkce();
  const { code } = await authorized(h, cookie, {
    clientId,
    challenge: p?.challenge ?? null,
    ...(o.scope !== undefined ? { scope: o.scope } : {}),
    ...(o.nonce !== undefined ? { nonce: o.nonce } : {}),
  });
  return { code, verifier: p?.verifier ?? null };
}

/** The form of a code exchange, with no client field. */
const codeBody = (c: Code): Record<string, string> => ({
  grant_type: "authorization_code",
  code: c.code,
  redirect_uri: REDIRECT,
  resource: RESOURCE,
  ...(c.verifier !== null ? { code_verifier: c.verifier } : {}),
});

const withBasic = (body: Record<string, string>, id: string, secret: string) =>
  tokenPost(body, { authorization: basicHeader(id, secret) });

/** The location of the authorize step, which must be a redirect to the client. */
async function authorizeError(
  h: Handle,
  cookie: string,
  query: Parameters<typeof authorizeGet>[0],
) {
  const res = await h.auth.handle(authorizeGet(query, cookie));
  const location = res.headers.get("location");
  if (res.status !== 302 || location === null)
    throw new Error(`authorize answered ${res.status} with no redirect`);
  return new URL(location).searchParams.get("error");
}

const revoke = (body: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${BASE_URL}/auth/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });

describe("client auth at the token endpoint (plan 12e)", () => {
  it("passes each method", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const basic = await confidential(h, "client_secret_basic");
    const form = await confidential(h, "client_secret_post");
    const open = await registered(h);
    const viaBasic = await h.auth.handle(
      withBasic(codeBody(await codeOf(h, s.cookie, basic.clientId)), basic.clientId, basic.secret),
    );
    expect(viaBasic.status).toBe(200);
    const viaForm = await h.auth.handle(
      tokenPost({
        ...codeBody(await codeOf(h, s.cookie, form.clientId)),
        client_id: form.clientId,
        client_secret: form.secret,
      }),
    );
    expect(viaForm.status).toBe(200);
    const viaNone = await h.auth.handle(
      tokenPost({ ...codeBody(await codeOf(h, s.cookie, open)), client_id: open }),
    );
    expect(viaNone.status).toBe(200);
    // The refresh grant takes the same auth.
    const { refresh_token } = (await viaBasic.json()) as { refresh_token: string };
    const refreshed = await h.auth.handle(
      withBasic({ grant_type: "refresh_token", refresh_token }, basic.clientId, basic.secret),
    );
    expect(refreshed.status).toBe(200);
    // RFC 7235 section 2.1: the scheme name has no case.
    const lower = await h.auth.handle(
      tokenPost(codeBody(await codeOf(h, s.cookie, basic.clientId)), {
        authorization: basicHeader(basic.clientId, basic.secret).replace(/^Basic/, "basic"),
      }),
    );
    expect(lower.status).toBe(200);
  });

  it("reads Basic as form-encoded id and secret (RFC 6749 2.3.1)", async () => {
    // A plus is a space and a percent escape is its byte, in the id and in the secret.
    expect(basicCredentials(btoa("a+b%2Bc:s%25+t:u"))).toEqual({ id: "a b+c", secret: "s% t:u" });
    // A bad escape, bad base64, and no colon are each a bad header.
    expect(basicCredentials(btoa("cl_x:%zz"))).toBeNull();
    expect(basicCredentials("!!!")).toBeNull();
    expect(basicCredentials(btoa("cl_x"))).toBeNull();
    // A real secret with each character as its percent escape passes; the escapes undecoded do not.
    const h = oauthHandle();
    const s = await signedIn(h);
    const basic = await confidential(h, "client_secret_basic");
    const escaped = [...basic.secret]
      .map((ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("");
    const asEscapes = await h.auth.handle(
      tokenPost(codeBody(await codeOf(h, s.cookie, basic.clientId)), {
        authorization: `Basic ${btoa(`${basic.clientId}:${escaped}`)}`,
      }),
    );
    expect(asEscapes.status).toBe(200);
    const raw = await h.auth.handle(
      tokenPost(codeBody(await codeOf(h, s.cookie, basic.clientId)), {
        authorization: `Basic ${btoa(`${basic.clientId}:${escaped.replaceAll("%", "%25")}`)}`,
      }),
    );
    expect(await answer(raw)).toEqual(CLIENT);
  });

  it("answers 401 with a Basic challenge after a Basic attempt", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const basic = await confidential(h, "client_secret_basic");
    const form = await confidential(h, "client_secret_post");
    const wrong = `cs_${"A".repeat(43)}`;
    const viaBasic = await h.auth.handle(
      withBasic(codeBody(await codeOf(h, s.cookie, basic.clientId)), basic.clientId, wrong),
    );
    expect(viaBasic.headers.get("www-authenticate")).toBe(`Basic realm="${ISSUER}"`);
    expect(viaBasic.headers.get("pragma")).toBe("no-cache");
    expect(await answer(viaBasic)).toEqual(CLIENT);
    // A Basic header that does not parse is a Basic attempt too: bad base64, no colon, a bad escape.
    const c = await codeOf(h, s.cookie, basic.clientId);
    for (const token of ["!!!", btoa("no-colon"), btoa(`${basic.clientId}:%zz`)]) {
      const bad = await h.auth.handle(tokenPost(codeBody(c), { authorization: `Basic ${token}` }));
      expect({ token, challenge: bad.headers.get("www-authenticate") }).toEqual({
        token,
        challenge: `Basic realm="${ISSUER}"`,
      });
      expect(await answer(bad)).toEqual(CLIENT);
    }
    const viaForm = await h.auth.handle(
      tokenPost({
        ...codeBody(await codeOf(h, s.cookie, form.clientId)),
        client_id: form.clientId,
        client_secret: wrong,
      }),
    );
    expect(viaForm.headers.get("www-authenticate")).toBeNull();
    expect(await answer(viaForm)).toEqual(CLIENT);
  });

  it("refuses two methods in one request", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const basic = await confidential(h, "client_secret_basic");
    const c = await codeOf(h, s.cookie, basic.clientId);
    const twice = await h.auth.handle(
      withBasic({ ...codeBody(c), client_secret: basic.secret }, basic.clientId, basic.secret),
    );
    expect(await answer(twice)).toEqual({ status: 400, body: { error: "invalid_request" } });
    const assertion = await h.auth.handle(
      tokenPost({
        ...codeBody(c),
        client_id: basic.clientId,
        client_secret: basic.secret,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      }),
    );
    expect(await answer(assertion)).toEqual({ status: 400, body: { error: "invalid_request" } });
    // A form client_id that is not the Basic id.
    const other = await h.auth.handle(
      withBasic(
        { ...codeBody(c), client_id: `cl_${"B".repeat(43)}` },
        basic.clientId,
        basic.secret,
      ),
    );
    expect(await answer(other)).toEqual({ status: 400, body: { error: "invalid_request" } });
    // None of them spent the code.
    expect((await h.auth.handle(withBasic(codeBody(c), basic.clientId, basic.secret))).status).toBe(
      200,
    );
  });

  it("refuses a method other than the client's own", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const basic = await confidential(h, "client_secret_basic");
    const form = await confidential(h, "client_secret_post");
    // The right secret, by the other secret method.
    const inForm = await h.auth.handle(
      tokenPost({
        ...codeBody(await codeOf(h, s.cookie, basic.clientId)),
        client_id: basic.clientId,
        client_secret: basic.secret,
      }),
    );
    expect(await answer(inForm)).toEqual(CLIENT);
    const inHeader = await h.auth.handle(
      withBasic(codeBody(await codeOf(h, s.cookie, form.clientId)), form.clientId, form.secret),
    );
    expect(await answer(inHeader)).toEqual(CLIENT);
  });

  it("refuses a confidential client with no auth and a public client with a secret, and spends nothing", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const basic = await confidential(h, "client_secret_basic");
    const c = await codeOf(h, s.cookie, basic.clientId);
    const bare = await h.auth.handle(tokenPost({ ...codeBody(c), client_id: basic.clientId }));
    expect(await answer(bare)).toEqual(CLIENT);
    expect((await h.auth.handle(withBasic(codeBody(c), basic.clientId, basic.secret))).status).toBe(
      200,
    );
    const open = await registered(h);
    const p = await codeOf(h, s.cookie, open);
    const secret = `cs_${"A".repeat(43)}`;
    const inForm = await h.auth.handle(
      tokenPost({ ...codeBody(p), client_id: open, client_secret: secret }),
    );
    expect(await answer(inForm)).toEqual(CLIENT);
    expect(await answer(await h.auth.handle(withBasic(codeBody(p), open, secret)))).toEqual(CLIENT);
    expect((await h.auth.handle(tokenPost({ ...codeBody(p), client_id: open }))).status).toBe(200);
  });

  it("accepts the old secret during the rotation window", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const basic = await confidential(h, "client_secret_basic");
    const rotated = await h.auth.api.oauth?.clients.rotateSecret({
      clientId: basic.clientId,
      keepOldHours: 1,
    });
    if (!rotated?.ok) throw new Error("the rotation failed");
    const fresh = rotated.value.clientSecret;
    expect(fresh).not.toBe(basic.secret);
    const exchangeWith = async (secret: string) =>
      h.auth.handle(
        withBasic(codeBody(await codeOf(h, s.cookie, basic.clientId)), basic.clientId, secret),
      );
    expect((await exchangeWith(basic.secret)).status).toBe(200);
    expect((await exchangeWith(fresh)).status).toBe(200);
    h.clock.advance(3_600_000);
    expect(await answer(await exchangeWith(basic.secret))).toEqual(CLIENT);
    expect((await exchangeWith(fresh)).status).toBe(200);
  });

  it("needs PKCE for a confidential client except openid with nonce (RFC 9700 2.1.1)", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const basic = await confidential(h, "client_secret_basic");
    const c = await codeOf(h, s.cookie, basic.clientId, {
      scope: "openid",
      nonce: "n-1",
      pkce: false,
    });
    const res = await h.auth.handle(withBasic(codeBody(c), basic.clientId, basic.secret));
    const { id_token } = (await res.json()) as { id_token: string };
    expect(decodeJws(id_token)?.payload.nonce).toBe("n-1");
    const noChallenge = { clientId: basic.clientId, challenge: null };
    expect(await authorizeError(h, s.cookie, { ...noChallenge, scope: "openid" })).toBe(
      "invalid_request",
    );
    expect(
      await authorizeError(h, s.cookie, { ...noChallenge, scope: "mcp:read", nonce: "n-1" }),
    ).toBe("invalid_request");
    // A method with no challenge is a broken request too.
    expect(
      await authorizeError(h, s.cookie, {
        ...noChallenge,
        scope: "openid",
        nonce: "n-1",
        method: "S256",
      }),
    ).toBe("invalid_request");
    const open = await registered(h);
    expect(
      await authorizeError(h, s.cookie, {
        clientId: open,
        challenge: null,
        scope: "openid",
        nonce: "n-1",
      }),
    ).toBe("invalid_request");
  });

  it("needs the verifier for a code issued with a challenge", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const basic = await confidential(h, "client_secret_basic");
    const withChallenge = await codeOf(h, s.cookie, basic.clientId, {
      scope: "openid",
      nonce: "n-1",
    });
    const noVerifier = { ...withChallenge, verifier: null };
    expect(
      await answer(
        await h.auth.handle(withBasic(codeBody(noVerifier), basic.clientId, basic.secret)),
      ),
    ).toEqual(GRANT);
    // RFC 7636 section 4.6 gives a verifier no meaning for a code with no challenge.
    const without = await codeOf(h, s.cookie, basic.clientId, {
      scope: "openid",
      nonce: "n-1",
      pkce: false,
    });
    const extra = { ...without, verifier: (await pkce()).verifier };
    expect(
      await answer(await h.auth.handle(withBasic(codeBody(extra), basic.clientId, basic.secret))),
    ).toEqual(GRANT);
  });

  it("authenticates the revoke", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const basic = await confidential(h, "client_secret_basic");
    const c = await codeOf(h, s.cookie, basic.clientId);
    const { refresh_token } = (await (
      await h.auth.handle(withBasic(codeBody(c), basic.clientId, basic.secret))
    ).json()) as { refresh_token: string };
    for (const body of [
      { token: refresh_token },
      { token: refresh_token, client_id: basic.clientId },
    ]) {
      const res = await h.auth.handle(revoke(body));
      expect({ body, answer: await answer(res) }).toEqual({ body, answer: CLIENT });
    }
    const wrong = await h.auth.handle(
      revoke({ token: refresh_token }, { authorization: basicHeader(basic.clientId, "cs_x") }),
    );
    expect(wrong.headers.get("www-authenticate")).toBe(`Basic realm="${ISSUER}"`);
    expect(await answer(wrong)).toEqual(CLIENT);
    expect(await h.storage.findMany("oauthToken", [])).toHaveLength(1);
    const done = await h.auth.handle(
      revoke(
        { token: refresh_token },
        { authorization: basicHeader(basic.clientId, basic.secret) },
      ),
    );
    expect(await answer(done)).toEqual({ status: 200, body: {} });
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
  });

  it("counts a failed revoke auth on the per-IP limit of the token endpoint", async () => {
    const h = oauthHandle();
    const basic = await confidential(h, "client_secret_basic");
    const from = (secret: string) =>
      h.auth.handle(
        revoke(
          { token: "or_x" },
          { authorization: basicHeader(basic.clientId, secret), "cf-connecting-ip": "8.8.8.8" },
        ),
      );
    for (let i = 0; i < 30; i++) expect((await from(`cs_${"A".repeat(43)}`)).status).toBe(401);
    for (let i = 0; i < 30; i++) expect((await from(basic.secret)).status).toBe(200);
    expect(await answer(await from(basic.secret))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
  });

  it("answers no CORS to a confidential client", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const form = await confidential(h, "client_secret_post");
    const c = await codeOf(h, s.cookie, form.clientId);
    const body = { ...codeBody(c), client_id: form.clientId, client_secret: form.secret };
    const fromBrowser = await h.auth.handle(tokenPost(body, { origin: CLIENT_ORIGIN }));
    expect(fromBrowser.headers.get("access-control-allow-origin")).toBeNull();
    expect(await answer(fromBrowser)).toEqual({
      status: 403,
      body: { error: "origin_not_trusted" },
    });
    const preflight = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/token?client_id=${form.clientId}`, {
        method: "OPTIONS",
        headers: { origin: CLIENT_ORIGIN, "access-control-request-method": "POST" },
      }),
    );
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    // The refusal spent nothing; the client's server exchanges the code.
    expect((await h.auth.handle(tokenPost(body))).status).toBe(200);
    const open = await registered(h);
    const p = await codeOf(h, s.cookie, open);
    const res = await h.auth.handle(
      tokenPost({ ...codeBody(p), client_id: open }, { origin: CLIENT_ORIGIN }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
  });
});
