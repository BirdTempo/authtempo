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
  consentPost,
  type Handle,
  ISSUER,
  OTHER_RESOURCE,
  oauthHandle,
  pkce,
  REDIRECT,
  RESOURCE,
  registered,
  signedIn,
} from "./oauth-helpers.js";

const codes = (h: Handle) =>
  h.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "oauth-code" }]);
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
  it("sends a browser with no session to the sign-in page with next back to the authorize URL; the page lands there", async () => {
    const h = oauthHandle();
    const clientId = await registered(h);
    const { challenge } = await pkce();
    const res = await h.auth.handle(authorizeGet({ clientId, challenge }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${BASE_URL}/auth/oauth/sign-in`);
    const next = location.searchParams.get("next") ?? "";
    expect(next.startsWith("/auth/oauth/authorize?")).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(next.slice(next.indexOf("?") + 1)))).toEqual(
      authorizeParams({ clientId, challenge }),
    );
    const page = await h.auth.handle(get(`/auth/oauth/sign-in?next=${encodeURIComponent(next)}`));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(await page.text()).toContain(`data-continue="${escapeHtml(next)}"`);
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

  it("shows the consent page with the client name, the scopes, and the request as hidden fields; the policy admits the redirect origin", async () => {
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
    expect(html).toContain(`<input type="hidden" name="code_challenge" value="${s.challenge}">`);
    expect(html).toContain('<input type="hidden" name="state" value="st-1">');
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

  it("deny redirects with access_denied, the state, and iss, and writes no consent and no code", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const res = await h.auth.handle(
      consentPost(
        { ...authorizeParams({ clientId: s.clientId, challenge: s.challenge }), decision: "deny" },
        { cookie: s.cookie },
      ),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(Object.fromEntries(loc.searchParams)).toEqual({
      error: "access_denied",
      state: "st-1",
      iss: ISSUER,
    });
    expect(await h.storage.findMany("oauthConsent", [])).toEqual([]);
    expect(await codes(h)).toEqual([]);
  });

  it("refuses the consent post from another origin and with no origin (403), and with no session (401)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    const body = {
      ...authorizeParams({ clientId: s.clientId, challenge: s.challenge }),
      decision: "allow",
    };
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

  it("prompt=login answers login_required to a session; with no session the sign-in page lands back with login dropped (OIDC Core 3.1.2.1)", async () => {
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
      const next = new URL(res.headers.get("location") ?? "").searchParams.get("next") ?? "";
      return new URLSearchParams(next.slice(next.indexOf("?") + 1)).get("prompt");
    };
    expect(await nextOf("login")).toBeNull();
    expect(await nextOf("login consent")).toBe("consent");
    // After the sign-in the way back passes: the consent page, not login_required.
    const res = await h.auth.handle(
      authorizeGet({ clientId: s.clientId, challenge: s.challenge, prompt: "login" }),
    );
    const next = new URL(res.headers.get("location") ?? "").searchParams.get("next") ?? "";
    const back = await h.auth.handle(get(next, { cookie: s.cookie }));
    expect(back.status).toBe(200);
  });

  it("redirects invalid_request to the client when the authorize URL is too long to ride through the sign-in page (Task 5 review)", async () => {
    const h = oauthHandle();
    const s = await setup(h);
    // 400 characters is within the 512 limit of state; each one is 6 characters in the URL, so next is longer than 2048.
    const state = "\u00e9".repeat(400);
    const res = await h.auth.handle(
      authorizeGet({ clientId: s.clientId, challenge: s.challenge, state }),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe(state);
    // A shorter request still goes to the sign-in page.
    const short = await h.auth.handle(
      authorizeGet({ clientId: s.clientId, challenge: s.challenge }),
    );
    expect(new URL(short.headers.get("location") ?? "").pathname).toBe("/auth/oauth/sign-in");
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
    for (let i = 0; i < 30; i++)
      expect(
        (
          await h.auth.handle(
            new Request(authorizeGet(input, s.cookie), { headers: { ...ip, cookie: s.cookie } }),
          )
        ).status,
      ).toBe(200);
    for (let i = 0; i < 30; i++)
      expect(
        (
          await h.auth.handle(
            consentPost(
              { ...authorizeParams(input), decision: "deny" },
              { ...ip, cookie: s.cookie },
            ),
          )
        ).status,
      ).toBe(302);
    const limited = await h.auth.handle(
      consentPost({ ...authorizeParams(input), decision: "allow" }, { ...ip, cookie: s.cookie }),
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

  it("answers access_denied to an unverified user, on the GET and on the POST", async () => {
    const h = oauthHandle();
    const s = await setup(h, false);
    const input = { clientId: s.clientId, challenge: s.challenge };
    expect(errorOf(await h.auth.handle(authorizeGet(input, s.cookie)))).toBe("access_denied");
    const post = await h.auth.handle(
      consentPost({ ...authorizeParams(input), decision: "allow" }, { cookie: s.cookie }),
    );
    expect(errorOf(post)).toBe("access_denied");
    expect(await h.storage.findMany("oauthConsent", [])).toEqual([]);
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
});
