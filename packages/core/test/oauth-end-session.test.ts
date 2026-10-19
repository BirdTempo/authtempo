import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createSession } from "../src/engine/sessions.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { APP_ORIGIN, BASE_URL } from "./helpers.js";
import {
  authorized,
  exchange,
  type Handle,
  oauthHandle,
  pkce,
  REDIRECT,
  signedIn,
} from "./oauth-helpers.js";

/** The post-logout redirect URI that each test client registers. */
const BYE = "https://client.example.com/bye";
/** The origin of the relying party: a form post from its page carries it. */
const RP_ORIGIN = "https://client.example.com";
const PATH = `${BASE_URL}/auth/oauth/end-session`;
const FORM = "application/x-www-form-urlencoded";

/** A client of `api.oauth.clients` with one post-logout redirect URI. */
async function client(h: Handle, extra: { subjectType?: "pairwise" } = {}): Promise<string> {
  const clients = h.auth.api.oauth?.clients;
  if (!clients) throw new Error("no client API");
  const r = await clients.create({
    redirectUris: [REDIRECT],
    postLogoutRedirectUris: [BYE],
    ...extra,
  });
  if (!r.ok) throw new Error(`create answered ${r.error}`);
  return r.value.client.id;
}

/** An ID token of the session `cookie` for `clientId`, through the authorize step and the code exchange. */
async function idTokenOf(h: Handle, cookie: string, clientId: string): Promise<string> {
  const p = await pkce();
  const { code } = await authorized(h, cookie, {
    clientId,
    challenge: p.challenge,
    scope: "openid mcp:read",
  });
  const res = await h.auth.handle(exchange(code, clientId, p.verifier));
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error(`the exchange answered ${res.status} with no id_token`);
  return body.id_token;
}

function endGet(params: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${PATH}?${new URLSearchParams(params)}`, { headers });
}

function endPost(params: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(PATH, {
    method: "POST",
    headers: { "content-type": FORM, ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

/** A second session of `userId`, as a second sign-in makes it, and its cookie. */
async function secondSession(h: Handle, userId: string) {
  const { token, session } = await createSession(h.config, { userId, ip: null, userAgent: null });
  return { session, cookie: `__Host-tempo_session=${token}` };
}

async function live(h: Handle, sessionId: string): Promise<boolean> {
  return (
    (await h.storage.findOne("session", [{ field: "id", op: "eq", value: sessionId }])) !== null
  );
}

/** The confirmation page: a form that posts `confirm=yes` to the same path, with no script. */
async function expectConfirmPage(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  const html = await res.text();
  expect(html).toContain('<form method="post" action="/auth/oauth/end-session">');
  expect(html).toContain('<input type="hidden" name="confirm" value="yes">');
  expect(html).not.toContain("<script");
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).not.toContain("script-src");
  expect(csp).toContain("frame-ancestors 'none'");
  return html;
}

/** The signed-out page: no redirect, no form, no script. */
async function expectSignedOutPage(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  const html = await res.text();
  expect(html).toContain("You are signed out");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("<script");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  return html;
}

describe("RP-initiated logout (plan 12e Task 15, OIDC RP-Initiated Logout 1.0)", () => {
  it("ends the current session at once for a valid hint of it, also when the hint is expired (RP-Initiated Logout 2)", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const clientId = await client(h);
    const hint = await idTokenOf(h, s.cookie, clientId);
    // Move the clock past the hint's exp. The session lives on.
    const exp = decodeJws(hint)?.payload.exp;
    if (typeof exp !== "number") throw new Error("the hint has no exp");
    h.clock.advance(exp * 1000 - h.clock.now().getTime() + 60_000);
    expect(h.clock.now().getTime()).toBeGreaterThan(exp * 1000);
    expect(await live(h, s.session.id)).toBe(true);
    const res = await h.auth.handle(endGet({ id_token_hint: hint }, { cookie: s.cookie }));
    await expectSignedOutPage(res);
    expect(await live(h, s.session.id)).toBe(false);
    expect(res.headers.get("set-cookie")).toContain("__Host-tempo_session=;");
    // A form post from the relying party's page ends a second session of a second client the same way.
    const s2 = await signedIn(h, "grace@example.com");
    const hint2 = await idTokenOf(h, s2.cookie, await client(h));
    const res2 = await h.auth.handle(
      endPost({ id_token_hint: hint2 }, { cookie: s2.cookie, origin: RP_ORIGIN }),
    );
    await expectSignedOutPage(res2);
    expect(await live(h, s2.session.id)).toBe(false);
    // A pairwise sub maps through the client's stored subject to the session's user.
    const s3 = await signedIn(h, "hedy@example.com");
    const pairwiseId = await client(h, { subjectType: "pairwise" });
    const hint3 = await idTokenOf(h, s3.cookie, pairwiseId);
    expect(decodeJws(hint3)?.payload.sub).toMatch(/^ps_/);
    await expectSignedOutPage(
      await h.auth.handle(endGet({ id_token_hint: hint3 }, { cookie: s3.cookie })),
    );
    expect(await live(h, s3.session.id)).toBe(false);
  });

  it("shows a confirmation page with no valid hint, and ends the session on yes with the Origin of baseURL", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    // No hint: the page asks, and nothing ends.
    await expectConfirmPage(await h.auth.handle(endGet({}, { cookie: s.cookie })));
    expect(await live(h, s.session.id)).toBe(true);
    // A GET never ends a session, also with confirm=yes in its query and the Origin of baseURL.
    await expectConfirmPage(
      await h.auth.handle(endGet({ confirm: "yes" }, { cookie: s.cookie, origin: BASE_URL })),
    );
    expect(await live(h, s.session.id)).toBe(true);
    // A yes from any Origin but baseURL ends nothing: the relying party, a trusted app origin, or none.
    for (const origin of [RP_ORIGIN, APP_ORIGIN, null]) {
      const headers: Record<string, string> = { cookie: s.cookie };
      if (origin !== null) headers.origin = origin;
      await expectConfirmPage(await h.auth.handle(endPost({ confirm: "yes" }, headers)));
      expect(await live(h, s.session.id), `origin ${origin}`).toBe(true);
    }
    // A post from the page's origin with no yes ends nothing.
    await expectConfirmPage(
      await h.auth.handle(endPost({}, { cookie: s.cookie, origin: BASE_URL })),
    );
    expect(await live(h, s.session.id)).toBe(true);
    // A hint of another session of the same user is no hint of this one: the page asks.
    const other = await secondSession(h, s.user.id);
    const clientId = await client(h);
    const otherHint = await idTokenOf(h, other.cookie, clientId);
    await expectConfirmPage(
      await h.auth.handle(endGet({ id_token_hint: otherHint }, { cookie: s.cookie })),
    );
    expect(await live(h, s.session.id)).toBe(true);
    expect(await live(h, other.session.id)).toBe(true);
    // The yes from the page's own origin ends the session.
    const res = await h.auth.handle(
      endPost({ confirm: "yes" }, { cookie: s.cookie, origin: BASE_URL }),
    );
    await expectSignedOutPage(res);
    expect(await live(h, s.session.id)).toBe(false);
    expect(res.headers.get("set-cookie")).toContain("__Host-tempo_session=;");
    // With no session, nothing ends and nothing asks.
    await expectSignedOutPage(await h.auth.handle(endGet({})));
    expect(await live(h, other.session.id)).toBe(true);
  });

  it("redirects only with a valid hint to an exact post_logout_redirect_uri, with state", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const clientId = await client(h);
    const hint = await idTokenOf(h, s.cookie, clientId);
    const res = await h.auth.handle(
      endGet(
        { id_token_hint: hint, post_logout_redirect_uri: BYE, state: "st-9", client_id: clientId },
        { cookie: s.cookie },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BYE}?state=st-9`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await live(h, s.session.id)).toBe(false);
    // With no session the redirect still comes, and with no state it carries none.
    const again = await h.auth.handle(
      endGet({ id_token_hint: hint, post_logout_redirect_uri: BYE }),
    );
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe(BYE);
    // A hint of another session: the page asks, its form carries the request, and the yes redirects.
    const s2 = await secondSession(h, s.user.id);
    const page = await h.auth.handle(
      endGet(
        { id_token_hint: hint, post_logout_redirect_uri: BYE, state: "st-10" },
        { cookie: s2.cookie },
      ),
    );
    const html = await expectConfirmPage(page);
    // The form posts to this origin, and Chromium applies form-action to the redirect that follows.
    expect(page.headers.get("content-security-policy")).toContain(`form-action 'self'`);
    expect(page.headers.get("content-security-policy")).toContain(RP_ORIGIN);
    expect(html).toContain('<input type="hidden" name="post_logout_redirect_uri"');
    const fields = Object.fromEntries(
      [...html.matchAll(/<input type="hidden" name="([a-z_]+)" value="([^"]*)">/g)].map((m) => [
        m[1] ?? "",
        m[2] ?? "",
      ]),
    );
    expect(fields).toEqual({
      id_token_hint: hint,
      post_logout_redirect_uri: BYE,
      state: "st-10",
      confirm: "yes",
    });
    const done = await h.auth.handle(endPost(fields, { cookie: s2.cookie, origin: BASE_URL }));
    // A 303 answers the form post, so the browser follows with a GET.
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`${BYE}?state=st-10`);
    expect(await live(h, s2.session.id)).toBe(false);
  });

  it("never redirects without a hint or to a foreign URI", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const clientId = await client(h);
    const hint = await idTokenOf(h, s.cookie, clientId);
    // No hint: the client_id and an exact URI are not enough (RP-Initiated Logout 3).
    const html = await expectSignedOutPage(
      await h.auth.handle(
        endGet({ client_id: clientId, post_logout_redirect_uri: BYE, state: "st-secret" }),
      ),
    );
    // state goes back only on a valid redirect.
    expect(html).not.toContain("st-secret");
    // A valid hint, but no exact entry of the client's post-logout list. The cases: the redirect
    // URI of the code flow, a longer path, a trailing slash, a query, another case, another host,
    // a fragment.
    for (const uri of [
      REDIRECT,
      `${BYE}/x`,
      `${BYE}/`,
      `${BYE}?next=1`,
      "https://CLIENT.example.com/bye",
      "https://evil.example.com/bye",
      `${BYE}#f`,
    ]) {
      const page = await expectSignedOutPage(
        await h.auth.handle(
          endGet({ id_token_hint: hint, post_logout_redirect_uri: uri, state: "st-secret" }),
        ),
      );
      expect(page, uri).not.toContain("st-secret");
    }
    // A repeated parameter is a bad request, with no redirect (RFC 6749 section 3.1).
    const twice = await h.auth.handle(
      new Request(
        `${PATH}?${new URLSearchParams([
          ["id_token_hint", hint],
          ["post_logout_redirect_uri", BYE],
          ["post_logout_redirect_uri", BYE],
        ])}`,
      ),
    );
    expect(twice.status).toBe(400);
    expect(twice.headers.get("location")).toBeNull();
    expect(await twice.json()).toEqual({ error: "invalid_request" });
    // A broken hint is no hint.
    await expectSignedOutPage(
      await h.auth.handle(
        endGet({ id_token_hint: `${hint.slice(0, -4)}AAAA`, post_logout_redirect_uri: BYE }),
      ),
    );
    expect(await live(h, s.session.id)).toBe(true);
  });

  it("refuses a hint whose aud is no client or is a jwtMint audience, and a client_id other than its aud", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const clientId = await client(h);
    const clients = h.auth.api.oauth?.clients;
    if (!clients) throw new Error("no client API");
    // A session JWT is not an ID token, also when an operator names a client id as its audience.
    // It carries the sid and the sub of the session, so only the audience rule refuses it.
    const sameStore: Partial<AuthConfig> = {
      storage: h.storage,
      clock: h.clock,
      jwtMint: { audience: [clientId] },
    };
    const w = oauthHandle(sameStore);
    const minted = await w.auth.handle(
      new Request(`${BASE_URL}/auth/token`, { headers: { cookie: s.cookie } }),
    );
    const sessionJwt = ((await minted.json()) as { token: string }).token;
    expect(decodeJws(sessionJwt)?.payload).toMatchObject({ aud: clientId, sid: s.session.id });
    await expectConfirmPage(
      await w.auth.handle(
        endGet({ id_token_hint: sessionJwt, post_logout_redirect_uri: BYE }, { cookie: s.cookie }),
      ),
    );
    expect(await live(h, s.session.id)).toBe(true);
    // A client_id other than the hint's aud: the hint is refused (RP-Initiated Logout 2).
    const hint = await idTokenOf(h, s.cookie, clientId);
    const second = await client(h);
    await expectConfirmPage(
      await h.auth.handle(
        endGet(
          { id_token_hint: hint, client_id: second, post_logout_redirect_uri: BYE },
          { cookie: s.cookie },
        ),
      ),
    );
    expect(await live(h, s.session.id)).toBe(true);
    // A pairwise hint whose client turned public names no user of this session.
    const pairwiseId = await client(h, { subjectType: "pairwise" });
    const pairwiseHint = await idTokenOf(h, s.cookie, pairwiseId);
    expect(await clients.update({ clientId: pairwiseId, subjectType: "public" })).toMatchObject({
      ok: true,
    });
    await expectConfirmPage(
      await h.auth.handle(
        endGet(
          { id_token_hint: pairwiseHint, post_logout_redirect_uri: BYE },
          { cookie: s.cookie },
        ),
      ),
    );
    expect(await live(h, s.session.id)).toBe(true);
    // The aud names no client after a delete.
    expect(await clients.delete({ clientId })).toMatchObject({ ok: true });
    await expectConfirmPage(
      await h.auth.handle(
        endGet({ id_token_hint: hint, post_logout_redirect_uri: BYE }, { cookie: s.cookie }),
      ),
    );
    expect(await live(h, s.session.id)).toBe(true);
  });

  it("answers a POST that sees no session with a 303 to the GET of the same request (SameSite=Lax)", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const clientId = await client(h);
    const hint = await idTokenOf(h, s.cookie, clientId);
    // The relying party's form post: a browser sends no SameSite=Lax cookie on a cross-site POST.
    const res = await h.auth.handle(
      endPost(
        { id_token_hint: hint, post_logout_redirect_uri: BYE, state: "st-7" },
        { origin: RP_ORIGIN },
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(PATH);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      id_token_hint: hint,
      post_logout_redirect_uri: BYE,
      state: "st-7",
    });
    // No redirect to the client yet: the session lives.
    expect(await live(h, s.session.id)).toBe(true);
    // The browser follows with a top-level GET, which carries the Lax cookie.
    const done = await h.auth.handle(new Request(location, { headers: { cookie: s.cookie } }));
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${BYE}?state=st-7`);
    expect(await live(h, s.session.id)).toBe(false);
    // A cross-site yes with no cookie: the 303 drops the yes, and no page says signed out.
    const s2 = await signedIn(h, "grace@example.com");
    const yes = await h.auth.handle(
      endPost({ confirm: "yes", state: "st-8" }, { origin: RP_ORIGIN }),
    );
    expect(yes.status).toBe(303);
    expect(yes.headers.get("location")).toBe(`${PATH}?state=st-8`);
    expect(await yes.text()).toBe("");
    // The GET with the cookie asks first, and nothing ends.
    await expectConfirmPage(
      await h.auth.handle(
        new Request(yes.headers.get("location") ?? "", { headers: { cookie: s2.cookie } }),
      ),
    );
    expect(await live(h, s2.session.id)).toBe(true);
    // An empty form goes on to the bare path.
    const bare = await h.auth.handle(endPost({}, { origin: RP_ORIGIN }));
    expect(bare.status).toBe(303);
    expect(bare.headers.get("location")).toBe(PATH);
  });

  it("escapes each reflected field on the confirmation page", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const bad = '"><b>x</b>';
    const html = await expectConfirmPage(
      await h.auth.handle(
        endGet(
          { id_token_hint: bad, client_id: bad, post_logout_redirect_uri: bad, state: bad },
          { cookie: s.cookie },
        ),
      ),
    );
    expect(html).not.toContain("<b>");
    for (const name of ["id_token_hint", "client_id", "post_logout_redirect_uri", "state"])
      expect(html, name).toContain(
        `<input type="hidden" name="${name}" value="&quot;&gt;&lt;b&gt;x&lt;/b&gt;">`,
      );
  });

  it("refuses a hint of another issuer on the same storage", async () => {
    const h = oauthHandle();
    // A second instance with another baseURL shares the storage, so it shares the signing key.
    const other = oauthHandle({
      baseURL: "https://other.example.com",
      storage: h.storage,
      clock: h.clock,
    });
    const s = await signedIn(h);
    const hint = await idTokenOf(h, s.cookie, await client(h));
    // The hint verifies under the shared key, and its sid and sub name this session.
    // Only its iss refuses it: the page asks, nothing ends, and nothing redirects.
    await expectConfirmPage(
      await other.auth.handle(
        new Request(
          `https://other.example.com/auth/oauth/end-session?${new URLSearchParams({
            id_token_hint: hint,
            post_logout_redirect_uri: BYE,
          })}`,
          { headers: { cookie: s.cookie } },
        ),
      ),
    );
    expect(await live(h, s.session.id)).toBe(true);
    // The same request at the issuer of the hint ends the session.
    const done = await h.auth.handle(
      endGet({ id_token_hint: hint, post_logout_redirect_uri: BYE }, { cookie: s.cookie }),
    );
    expect(done.headers.get("location")).toBe(BYE);
    expect(await live(h, s.session.id)).toBe(false);
  });

  it("fires afterEnd with oidc_logout", async () => {
    const ended: string[] = [];
    const h = oauthHandle({
      hooks: {
        session: {
          afterEnd: (e) => {
            ended.push(`${e.session.id}:${e.reason}`);
          },
        },
      },
    });
    const s = await signedIn(h);
    const hint = await idTokenOf(h, s.cookie, await client(h));
    await h.auth.handle(endGet({ id_token_hint: hint }, { cookie: s.cookie }));
    const s2 = await signedIn(h, "grace@example.com");
    await h.auth.handle(endPost({ confirm: "yes" }, { cookie: s2.cookie, origin: BASE_URL }));
    expect(ended).toEqual([`${s.session.id}:oidc_logout`, `${s2.session.id}:oidc_logout`]);
    // A second request for an ended session ends nothing and fires nothing.
    await h.auth.handle(endGet({ id_token_hint: hint }, { cookie: s.cookie }));
    expect(ended).toHaveLength(2);
  });

  it("limits end-session to 60 per IP per 15 minutes", async () => {
    const h = oauthHandle();
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 60; i++) {
      // A POST with no session goes on to the GET as a 303.
      const res = await h.auth.handle(i % 2 === 0 ? endGet({}, ip) : endPost({}, ip));
      expect(res.status, `request ${i + 1}`).toBe(i % 2 === 0 ? 200 : 303);
    }
    const refused = await h.auth.handle(endGet({}, ip));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect((await h.auth.handle(endPost({}, ip))).status).toBe(429);
    // Another IP has its own count.
    expect((await h.auth.handle(endGet({}, { "cf-connecting-ip": "203.0.113.10" }))).status).toBe(
      200,
    );
    h.clock.advance(15 * 60_000);
    expect((await h.auth.handle(endGet({}, ip))).status).toBe(200);
  });
});
