import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/http/confirm-page.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { OAuthConsentRow } from "../src/schema.js";
import { StorageError } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, get } from "./helpers.js";
import {
  authorized,
  authorizeGet,
  authorizeParams,
  consentPage,
  consentPost,
  type Handle,
  ISSUER,
  OTHER_RESOURCE,
  oauthHandle,
  pkce,
  REDIRECT,
  RESOURCE,
  registered,
  requestIdOf,
  signedIn,
} from "./oauth-helpers.js";

const codes = (h: Handle) =>
  h.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "oauth-code" }]);
const held = (h: Handle) =>
  h.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "oauth-request" }]);
/** The short id at the end of a sign-in `next`. */
const idOfNext = (next: string) => next.slice(next.indexOf("request_id=") + "request_id=".length);
/** The query that a held request holds, by its short id. */
async function heldParams(h: Handle, id: string): Promise<URLSearchParams> {
  const row = await h.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(id) },
    { field: "purpose", op: "eq", value: "oauth-request" },
  ]);
  return new URLSearchParams(String(row?.data?.params ?? ""));
}
const errorOf = (res: Response) =>
  new URL(res.headers.get("location") ?? "about:blank").searchParams.get("error");

/** A signed-in user, a registered client, and a PKCE pair. */
async function setup(h: Handle, verified = true) {
  const s = await signedIn(h, "ada@example.com", verified);
  const clientId = await registered(h);
  const { challenge, verifier } = await pkce();
  return { ...s, clientId, challenge, verifier };
}

describe("the authorize step (plan 9g)", () => {
  it("sends a browser with no session to the sign-in page with next back to a held request; after the sign-in it shows the consent page (plan 9h)", async () => {
    const h = oauthHandle();
    const s = await signedIn(h);
    const clientId = await registered(h);
    const { challenge } = await pkce();
    const res = await h.auth.handle(authorizeGet({ clientId, challenge }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${BASE_URL}/auth/oauth/sign-in`);
    const next = location.searchParams.get("next") ?? "";
    expect(next).toMatch(/^\/auth\/oauth\/authorize\?request_id=oq_[A-Za-z0-9_-]{43}$/);
    const id = idOfNext(next);
    const rows = await held(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      identifier: clientId,
      valueHash: await sha256Hex(id),
      consumedAt: null,
      expiresAt: new Date(h.clock.now().getTime() + 600_000),
      data: { userId: null },
    });
    expect(Object.fromEntries(await heldParams(h, id))).toEqual(
      authorizeParams({ clientId, challenge }),
    );
    const page = await h.auth.handle(get(`/auth/oauth/sign-in?next=${encodeURIComponent(next)}`));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(await page.text()).toContain(`data-continue="${escapeHtml(next)}"`);
    // After the sign-in, the way back shows the consent page of the same held request, now bound to the user.
    const back = await h.auth.handle(get(next, { cookie: s.cookie }));
    expect(back.status).toBe(200);
    expect(requestIdOf(await back.text())).toBe(id);
    expect((await held(h)).map((r) => r.data?.userId)).toEqual([s.user.id]);
  });

  it("refuses the sign-in page for a next that is not an authorize URL", async () => {
    const h = oauthHandle();
    for (const next of ["/inbox", "//evil.example.com/auth/oauth/authorize?x=1", ""]) {
      const res = await h.auth.handle(get(`/auth/oauth/sign-in?next=${encodeURIComponent(next)}`));
      expect({ next, location: res.headers.get("location") }).toEqual({
        next,
        location: `${BASE_URL}/?auth_error=invalid_request`,
      });
    }
  });

  it("shows the consent page with the client name, the scopes, and the held request's short id as the one hidden field; the policy admits the redirect origin (plan 9h)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const res = await h.auth.handle(
      authorizeGet(
        { clientId: s.clientId, challenge: s.challenge, scope: "openid mcp:read" },
        s.cookie,
      ),
    );
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self' https://app.example.com https://client.example.com;");
    expect(csp).not.toContain("script-src");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Allow Test MCP client to use your api.example.com account?");
    expect(html).toContain("Read your documents");
    expect(html).toContain("Confirm who you are");
    // The request stays on the server (plan 9h): no hidden field repeats it.
    const id = requestIdOf(html);
    expect(html.match(/type="hidden"/g)).toHaveLength(1);
    expect(html).not.toContain(s.challenge);
    expect(Object.fromEntries(await heldParams(h, id))).toEqual(
      authorizeParams({ clientId: s.clientId, challenge: s.challenge, scope: "openid mcp:read" }),
    );
    expect((await held(h))[0]?.data?.userId).toBe(s.user.id);
    expect(html).not.toContain("<script");
    // The resource of the request, and the other one that the consent covers too (review M-3).
    expect(html).toContain(
      `For <code>${RESOURCE}</code>. If you allow, it may also use these scopes at <code>${OTHER_RESOURCE}</code> with no new question.`,
    );
    expect(await codes(h)).toEqual([]);
  });

  it("allow writes the consent and redirects with code, state, and iss; the same scopes later skip the page; prompt=consent asks again", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const r = await authorized(h, s.cookie, { clientId: s.clientId, challenge: s.challenge });
    expect(`${r.url.origin}${r.url.pathname}`).toBe(REDIRECT);
    expect(r.url.searchParams.get("state")).toBe("st-1");
    expect(r.url.searchParams.get("iss")).toBe(ISSUER);
    expect(r.code).toMatch(/^oc_[A-Za-z0-9_-]{43}$/);
    expect(await h.storage.findMany("oauthConsent", [])).toMatchObject([
      { userId: s.user.id, clientId: s.clientId, scopes: ["mcp:read", "offline_access"] },
    ]);
    const again = await h.auth.handle(
      authorizeGet({ clientId: s.clientId, challenge: s.challenge, state: "st-2" }, s.cookie),
    );
    expect(again.status).toBe(302);
    const loc = new URL(again.headers.get("location") ?? "");
    expect(loc.searchParams.get("code")).toMatch(/^oc_/);
    expect(loc.searchParams.get("state")).toBe("st-2");
    const forced = await h.auth.handle(
      authorizeGet({ clientId: s.clientId, challenge: s.challenge, prompt: "consent" }, s.cookie),
    );
    expect(forced.status).toBe(200);
  });

  it("a consent for a b does not cover a b c: the page shows again, and allow then covers all three (Review Focus 5)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const ask = (scope: string) => ({ clientId: s.clientId, challenge: s.challenge, scope });
    await authorized(h, s.cookie, ask("mcp:read openid"));
    const wider = await h.auth.handle(authorizeGet(ask("mcp:read openid mcp:write"), s.cookie));
    expect(wider.status).toBe(200);
    expect(await wider.text()).toContain("Change your documents");
    await authorized(h, s.cookie, ask("mcp:read openid mcp:write"));
    const consents = await h.storage.findMany("oauthConsent", []);
    expect(consents).toHaveLength(1);
    expect([...(consents[0]?.scopes ?? [])].sort()).toEqual(["mcp:read", "mcp:write", "openid"]);
    expect((await h.auth.handle(authorizeGet(ask("mcp:write"), s.cookie))).status).toBe(302);
  });

  it("deny redirects with access_denied, the state, and iss, spends the held request, and writes no consent and no code", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const { requestId } = await consentPage(h, s.cookie, {
      clientId: s.clientId,
      challenge: s.challenge,
    });
    const res = await h.auth.handle(
      consentPost({ request_id: requestId, decision: "deny" }, { cookie: s.cookie }),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(Object.fromEntries(loc.searchParams)).toEqual({
      error: "access_denied",
      state: "st-1",
      iss: ISSUER,
    });
    expect((await held(h))[0]?.consumedAt).not.toBeNull();
    expect(await h.storage.findMany("oauthConsent", [])).toEqual([]);
    expect(await codes(h)).toEqual([]);
  });

  it("refuses the consent post from another origin and with no origin (403), and with no session (401)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const { requestId } = await consentPage(h, s.cookie, {
      clientId: s.clientId,
      challenge: s.challenge,
    });
    const body = { request_id: requestId, decision: "allow" };
    expect(
      (await h.auth.handle(consentPost(body, { cookie: s.cookie, origin: APP_ORIGIN }))).status,
    ).toBe(403);
    const bare = new Request(`${BASE_URL}/auth/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: s.cookie },
      body: new URLSearchParams(body).toString(),
    });
    expect((await h.auth.handle(bare)).status).toBe(403);
    expect((await h.auth.handle(consentPost(body, {}))).status).toBe(401);
    expect(await h.storage.findMany("oauthConsent", [])).toEqual([]);
    expect(await codes(h)).toEqual([]);
  });

  it("answers with no redirect for an unknown client and a redirect URI that is not registered exactly", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const unknown = await h.auth.handle(
      authorizeGet({ clientId: `cl_${"A".repeat(43)}`, challenge: s.challenge }, s.cookie),
    );
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("location")).toBeNull();
    expect(await unknown.json()).toEqual({ error: "invalid_client" });
    for (const redirectUri of [
      "https://evil.example.com/cb",
      `${REDIRECT}/more`,
      `${REDIRECT}?x=1`,
    ]) {
      const res = await h.auth.handle(
        authorizeGet({ clientId: s.clientId, challenge: s.challenge, redirectUri }, s.cookie),
      );
      expect({ redirectUri, status: res.status, location: res.headers.get("location") }).toEqual({
        redirectUri,
        status: 400,
        location: null,
      });
    }
  });

  it("redirects with the error for a missing or plain challenge, a resource not configured, an unknown scope, another response type, and a repeated parameter", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const ask = async (over: Record<string, string | null>, twice?: string) => {
      const p = new URLSearchParams(
        authorizeParams({ clientId: s.clientId, challenge: s.challenge }),
      );
      for (const [k, v] of Object.entries(over)) {
        if (v === null) p.delete(k);
        else p.set(k, v);
      }
      if (twice) p.append(twice, p.get(twice) ?? "");
      return errorOf(
        await h.auth.handle(
          new Request(`${BASE_URL}/auth/oauth/authorize?${p}`, { headers: { cookie: s.cookie } }),
        ),
      );
    };
    expect(await ask({ code_challenge: null })).toBe("invalid_request");
    expect(await ask({ code_challenge: "short" })).toBe("invalid_request");
    expect(await ask({ code_challenge_method: "plain" })).toBe("invalid_request");
    expect(await ask({ resource: null })).toBe("invalid_target");
    expect(await ask({ resource: `${BASE_URL}/other` })).toBe("invalid_target");
    expect(await ask({ scope: "mcp:read admin" })).toBe("invalid_scope");
    expect(await ask({ scope: "" })).toBe("invalid_scope");
    expect(await ask({ response_type: "token" })).toBe("unsupported_response_type");
    expect(await ask({}, "response_type")).toBe("invalid_request");
    expect(await ask({}, "state")).toBe("invalid_request");
    // RFC 8707 section 2 admits a repeated resource; this server refuses it as invalid_target.
    expect(await ask({}, "resource")).toBe("invalid_target");
    expect(await ask({ prompt: "none login" })).toBe("invalid_request");
    expect(await codes(h)).toEqual([]);
  });

  it("prompt=none answers login_required with no session and consent_required with no consent", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const input = { clientId: s.clientId, challenge: s.challenge, prompt: "none" };
    expect(errorOf(await h.auth.handle(authorizeGet(input)))).toBe("login_required");
    expect(errorOf(await h.auth.handle(authorizeGet(input, s.cookie)))).toBe("consent_required");
  });

  it("prompt=login answers login_required to a session; with no session the held request drops login, and the way back shows the page (OIDC Core 3.1.2.1)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    for (const prompt of ["login", "login consent", "consent login"])
      expect({
        prompt,
        error: errorOf(
          await h.auth.handle(
            authorizeGet({ clientId: s.clientId, challenge: s.challenge, prompt }, s.cookie),
          ),
        ),
      }).toEqual({ prompt, error: "login_required" });
    expect(await codes(h)).toEqual([]);
    const nextOf = async (prompt: string) => {
      const res = await h.auth.handle(
        authorizeGet({ clientId: s.clientId, challenge: s.challenge, prompt }),
      );
      return new URL(res.headers.get("location") ?? "").searchParams.get("next") ?? "";
    };
    expect((await heldParams(h, idOfNext(await nextOf("login")))).get("prompt")).toBeNull();
    expect((await heldParams(h, idOfNext(await nextOf("login consent")))).get("prompt")).toBe(
      "consent",
    );
    // After the sign-in the way back passes: the consent page, not login_required.
    const back = await h.auth.handle(get(await nextOf("login"), { cookie: s.cookie }));
    expect(back.status).toBe(200);
  });

  it("holds a request too long for next: the sign-in page lands back on it, and the code carries the state (plan 9h, Review Focus 2)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    // 400 characters is within the 512 limit of state; each one is 6 characters in the URL.
    const state = "é".repeat(400);
    const input = { clientId: s.clientId, challenge: s.challenge, state };
    // Longer than the 2048 of safeNext, which refused this request before plan 9h.
    expect(authorizeGet(input).url.length).toBeGreaterThan(2048);
    const res = await h.auth.handle(authorizeGet(input));
    const next = new URL(res.headers.get("location") ?? "").searchParams.get("next") ?? "";
    expect(next).toMatch(/^\/auth\/oauth\/authorize\?request_id=oq_/);
    expect(
      (await h.auth.handle(get(`/auth/oauth/sign-in?next=${encodeURIComponent(next)}`))).status,
    ).toBe(200);
    const page = await h.auth.handle(get(next, { cookie: s.cookie }));
    expect(page.status).toBe(200);
    const done = await h.auth.handle(
      consentPost(
        { request_id: requestIdOf(await page.text()), decision: "allow" },
        { cookie: s.cookie },
      ),
    );
    const back = new URL(done.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe(state);
    expect(back.searchParams.get("code")).toMatch(/^oc_/);
  });

  it("refuses a state or a nonce over 512 characters or with a control character (Task 5 review)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const base = { clientId: s.clientId, challenge: s.challenge };
    expect(
      errorOf(await h.auth.handle(authorizeGet({ ...base, state: "s".repeat(512) }, s.cookie))),
    ).toBeNull();
    for (const state of ["s".repeat(513), "a\u0000b", "a\nb"]) {
      const res = await h.auth.handle(authorizeGet({ ...base, state }, s.cookie));
      const loc = new URL(res.headers.get("location") ?? "");
      // A bad state is not echoed back.
      expect({
        state,
        error: loc.searchParams.get("error"),
        echoed: loc.searchParams.has("state"),
      }).toEqual({
        state,
        error: "invalid_request",
        echoed: false,
      });
    }
    for (const nonce of ["n".repeat(513), "a\u0007b"])
      expect({
        nonce,
        error: errorOf(await h.auth.handle(authorizeGet({ ...base, nonce }, s.cookie))),
      }).toEqual({ nonce, error: "invalid_request" });
    expect(await codes(h)).toEqual([]);
  });

  it("the consent POST counts against the same per-IP limit as the GET (Task 5 review)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const input = { clientId: s.clientId, challenge: s.challenge };
    const ip = { "cf-connecting-ip": "8.8.8.8" };
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await h.auth.handle(
        new Request(authorizeGet(input, s.cookie), { headers: { ...ip, cookie: s.cookie } }),
      );
      expect(res.status).toBe(200);
      ids.push(requestIdOf(await res.text()));
    }
    for (const id of ids)
      expect(
        (
          await h.auth.handle(
            consentPost({ request_id: id, decision: "deny" }, { ...ip, cookie: s.cookie }),
          )
        ).status,
      ).toBe(302);
    // The 61st count. The limit runs before the read of the held request.
    const limited = await h.auth.handle(
      consentPost({ request_id: ids[0] ?? "", decision: "allow" }, { ...ip, cookie: s.cookie }),
    );
    expect(limited.status).toBe(429);
    expect(await h.storage.findMany("oauthConsent", [])).toEqual([]);
  });

  it("an allow that loses the consent unique key adds its scopes to the winner's row (Task 5 review)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const create = h.storage.create.bind(h.storage);
    let lost = 0;
    // A parallel allow writes the row between this allow's read and its create.
    h.storage.create = (async (model: string, data: Record<string, unknown>) => {
      if (model === "oauthConsent" && lost === 0) {
        lost++;
        await create("oauthConsent", {
          ...(data as unknown as OAuthConsentRow),
          id: "winner",
          scopes: ["openid"],
        });
        throw new StorageError("unique_violation", "oauthConsent", ["clientId", "userId"]);
      }
      return create(model as "oauthConsent", data as unknown as OAuthConsentRow);
    }) as typeof h.storage.create;
    await authorized(h, s.cookie, { clientId: s.clientId, challenge: s.challenge });
    expect(lost).toBe(1);
    const rows = await h.storage.findMany("oauthConsent", []);
    expect(rows.map((r) => [r.id, [...r.scopes].sort()])).toEqual([
      ["winner", ["mcp:read", "offline_access", "openid"]],
    ]);
  });

  it("answers access_denied to an unverified user on the GET; a post of a request held before the sign-in decides nothing (plan 9h)", async () => {
    const h = oauthHandle();
    const s = await setup(h, false);
    const input = { clientId: s.clientId, challenge: s.challenge };
    expect(errorOf(await h.auth.handle(authorizeGet(input, s.cookie)))).toBe("access_denied");
    // A request held at the sign-in step names no user; the person posts its id by hand.
    const res = await h.auth.handle(authorizeGet(input));
    const next = new URL(res.headers.get("location") ?? "").searchParams.get("next") ?? "";
    const post = await h.auth.handle(
      consentPost({ request_id: idOfNext(next), decision: "allow" }, { cookie: s.cookie }),
    );
    expect({ status: post.status, body: await post.json() }).toEqual({
      status: 400,
      body: { error: "invalid_request" },
    });
    expect(await h.storage.findMany("oauthConsent", [])).toEqual([]);
    expect(await codes(h)).toEqual([]);
  });

  it("limits the authorize step to 60 per IP per 15 minutes", async () => {
    const h = oauthHandle();
    const clientId = await registered(h);
    const { challenge } = await pkce();
    const url = authorizeGet({ clientId, challenge }).url;
    const call = () =>
      h.auth.handle(new Request(url, { headers: { "cf-connecting-ip": "7.7.7.7" } }));
    for (let i = 0; i < 60; i++) expect((await call()).status).toBe(302);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });

  it("writes the code as an oauth-code verification row that holds the request and lives 5 minutes", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const before = h.clock.now();
    const { code } = await authorized(h, s.cookie, {
      clientId: s.clientId,
      challenge: s.challenge,
      nonce: "n-1",
      scope: "openid mcp:read",
    });
    const rows = await codes(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // The user: a reset or a password change deletes the user's codes by it.
      identifier: s.user.id,
      valueHash: await sha256Hex(code),
      consumedAt: null,
      expiresAt: new Date(before.getTime() + 300_000),
      data: {
        clientId: s.clientId,
        redirectUri: REDIRECT,
        codeChallenge: s.challenge,
        scopes: ["openid", "mcp:read"],
        resource: RESOURCE,
        userId: s.user.id,
        nonce: "n-1",
        sessionId: s.session.id,
      },
    });
  });

  it("the consent POST binds to the held request: a changed hidden field changes nothing, and a second post and another user's post answer invalid_request (plan 9h, Review Focus 1)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const bob = await signedIn(h, "bob@example.com");
    const { requestId } = await consentPage(h, s.cookie, {
      clientId: s.clientId,
      challenge: s.challenge,
      scope: "mcp:read",
    });
    const invalid = { status: 400, body: { error: "invalid_request" } };
    const answer = async (res: Response) => ({ status: res.status, body: await res.json() });
    // Another user's post decides nothing, and the request stays for its own user.
    expect(
      await answer(
        await h.auth.handle(
          consentPost({ request_id: requestId, decision: "allow" }, { cookie: bob.cookie }),
        ),
      ),
    ).toEqual(invalid);
    // Fields beside the id are not read: the scope and the redirect URI are the held ones.
    const done = await h.auth.handle(
      consentPost(
        {
          request_id: requestId,
          decision: "allow",
          scope: "mcp:read mcp:write",
          redirect_uri: "https://evil.example.com/cb",
        },
        { cookie: s.cookie },
      ),
    );
    const back = new URL(done.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect((await h.storage.findMany("oauthConsent", [])).map((r) => r.scopes)).toEqual([
      ["mcp:read"],
    ]);
    expect(
      await answer(
        await h.auth.handle(
          consentPost({ request_id: requestId, decision: "allow" }, { cookie: s.cookie }),
        ),
      ),
    ).toEqual(invalid);
    expect(await codes(h)).toHaveLength(1);
  });

  it("a held request lives 10 minutes: the way back after that answers invalid_request with no redirect (plan 9h)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const res = await h.auth.handle(authorizeGet({ clientId: s.clientId, challenge: s.challenge }));
    const next = new URL(res.headers.get("location") ?? "").searchParams.get("next") ?? "";
    h.clock.advance(10 * 60_000);
    const late = await h.auth.handle(get(next, { cookie: s.cookie }));
    expect({
      status: late.status,
      location: late.headers.get("location"),
      body: await late.json(),
    }).toEqual({ status: 400, location: null, body: { error: "invalid_request" } });
  });

  it("refuses a request_id with another parameter beside it, a repeated one, and an unknown one (plan 9h)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const { requestId } = await consentPage(h, s.cookie, {
      clientId: s.clientId,
      challenge: s.challenge,
    });
    for (const query of [
      `request_id=${requestId}&scope=mcp:write`,
      `request_id=${requestId}&request_id=${requestId}`,
      `request_id=oq_${"A".repeat(43)}`,
      "request_id=x",
    ]) {
      const res = await h.auth.handle(get(`/auth/oauth/authorize?${query}`, { cookie: s.cookie }));
      expect({ query, status: res.status, body: await res.json() }).toEqual({
        query,
        status: 400,
        body: { error: "invalid_request" },
      });
    }
    // The id alone still shows the page.
    expect(
      (
        await h.auth.handle(
          get(`/auth/oauth/authorize?request_id=${requestId}`, { cookie: s.cookie }),
        )
      ).status,
    ).toBe(200);
  });

  it("a held request bound to a user stays bound: another user's GET of its id answers invalid_request, and the first user's POST still gives a code (plan 9h fix round 1)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const bob = await signedIn(h, "bob@example.com");
    const { requestId } = await consentPage(h, s.cookie, {
      clientId: s.clientId,
      challenge: s.challenge,
    });
    const taken = await h.auth.handle(
      get(`/auth/oauth/authorize?request_id=${requestId}`, { cookie: bob.cookie }),
    );
    expect({
      status: taken.status,
      location: taken.headers.get("location"),
      body: await taken.json(),
    }).toEqual({ status: 400, location: null, body: { error: "invalid_request" } });
    expect((await held(h)).map((r) => r.data?.userId)).toEqual([s.user.id]);
    const done = await h.auth.handle(
      consentPost({ request_id: requestId, decision: "allow" }, { cookie: s.cookie }),
    );
    expect(done.status).toBe(302);
    expect(new URL(done.headers.get("location") ?? "").searchParams.get("code")).toMatch(/^oc_/);
  });

  it("two parallel GETs of a held request from before the sign-in bind it once (plan 9h fix round 1)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const bob = await signedIn(h, "bob@example.com");
    const res = await h.auth.handle(authorizeGet({ clientId: s.clientId, challenge: s.challenge }));
    const next = new URL(res.headers.get("location") ?? "").searchParams.get("next") ?? "";
    // Each read of the held row waits for the other one, so both GETs read
    // the row with no user before either binds. The clock does not move.
    const findOne = h.storage.findOne.bind(h.storage);
    const waiting: (() => void)[] = [];
    h.storage.findOne = (async (model: "verification", where: Parameters<typeof findOne>[1]) => {
      const row = await findOne(model, where);
      if (model === "verification" && waiting.length < 2)
        await new Promise<void>((done) => {
          waiting.push(done);
          if (waiting.length === 2) for (const w of waiting) w();
        });
      return row;
    }) as typeof h.storage.findOne;
    const [ada, other] = await Promise.all([
      h.auth.handle(get(next, { cookie: s.cookie })),
      h.auth.handle(get(next, { cookie: bob.cookie })),
    ]);
    expect(waiting).toHaveLength(2);
    expect([ada.status, other.status].sort()).toEqual([200, 400]);
    const winner = ada.status === 200 ? s.user.id : bob.user.id;
    expect((await held(h)).map((r) => r.data?.userId)).toEqual([winner]);
  });

  it("a post after the app cleared the user's verified address answers access_denied and spends the held request (plan 9h fix round 1)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const { requestId } = await consentPage(h, s.cookie, {
      clientId: s.clientId,
      challenge: s.challenge,
    });
    // Core never clears the flag, but the app owns its user table and may: an admin who takes back a verified address.
    await h.storage.update("user", [{ field: "id", op: "eq", value: s.user.id }], {
      emailVerified: false,
    });
    const res = await h.auth.handle(
      consentPost({ request_id: requestId, decision: "allow" }, { cookie: s.cookie }),
    );
    expect(res.status).toBe(302);
    expect(errorOf(res)).toBe("access_denied");
    expect((await held(h))[0]?.consumedAt).not.toBeNull();
    expect(await h.storage.findMany("oauthConsent", [])).toEqual([]);
    expect(await codes(h)).toEqual([]);
  });

  it("the consent POST refuses a repeated request_id, as the GET does, and spends nothing (plan 9h fix round 1)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const { requestId } = await consentPage(h, s.cookie, {
      clientId: s.clientId,
      challenge: s.challenge,
    });
    const twice = new Request(`${BASE_URL}/auth/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE_URL,
        cookie: s.cookie,
      },
      body: `request_id=${requestId}&request_id=${requestId}&decision=allow`,
    });
    const res = await h.auth.handle(twice);
    expect({
      status: res.status,
      location: res.headers.get("location"),
      body: await res.json(),
    }).toEqual({ status: 400, location: null, body: { error: "invalid_request" } });
    expect((await held(h))[0]?.consumedAt).toBeNull();
    expect(await codes(h)).toEqual([]);
  });

  it("a held request is live 1 ms before its 10 minutes end: the way back shows the consent page (plan 9h fix round 1)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const res = await h.auth.handle(authorizeGet({ clientId: s.clientId, challenge: s.challenge }));
    const next = new URL(res.headers.get("location") ?? "").searchParams.get("next") ?? "";
    h.clock.advance(10 * 60_000 - 1);
    const page = await h.auth.handle(get(next, { cookie: s.cookie }));
    expect(page.status).toBe(200);
    expect(requestIdOf(await page.text())).toBe(idOfNext(next));
  });
});
