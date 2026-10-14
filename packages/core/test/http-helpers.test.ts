import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveConfig } from "../src/config.js";
import { ERRORS } from "../src/errors.js";
import { isJsonRequest, readBody } from "../src/http/body.js";
import { defaultConfirmPage, escapeHtml } from "../src/http/confirm-page.js";
import {
  clearOauthCookie,
  clearSessionCookie,
  clearTrustCookie,
  oauthCookie,
  readCookie,
  sessionCookie,
  trustCookie,
} from "../src/http/cookies.js";
import { confirmPagePolicy, formAction, noScriptPagePolicy, pageHeaders } from "../src/http/csp.js";
import { defaultHandoffConfirmPage } from "../src/http/handoff-confirm-page.js";
import { json, readJson, respond } from "../src/http/json.js";
import { authErrorUrl, redirect, resolveNext } from "../src/http/redirect.js";
import { safeNext } from "../src/http/safe-next.js";
import { defaultSignInPage } from "../src/http/sign-in-page.js";
import { defaultTotpPage } from "../src/http/totp-page.js";
import { fail, ok } from "../src/result.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

describe("cookies", () => {
  it("sets an HttpOnly Secure SameSite=Lax cookie on /", () => {
    const c = sessionCookie("__Host-tempo_session", "ts_abc", 60, "Lax");
    expect(sessionCookie("__Host-tempo_session", "ts_abc", 60, "None")).toBe(
      "__Host-tempo_session=ts_abc; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=None",
    );
    expect(c).toBe(
      "__Host-tempo_session=ts_abc; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax",
    );
  });
  it("clears with Max-Age=0", () => {
    expect(clearSessionCookie("__Host-tempo_session", "Lax")).toBe(
      "__Host-tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
  });
  it("reads one cookie among several", () => {
    const req = new Request("https://x/", {
      headers: { cookie: "a=1; __Host-tempo_session=ts_abc; b=2" },
    });
    expect(readCookie(req, "__Host-tempo_session")).toBe("ts_abc");
    expect(readCookie(req, "nope")).toBeNull();
    expect(readCookie(new Request("https://x/"), "__Host-tempo_session")).toBeNull();
  });
  it("sets the trust cookie on the auth path, and clears it there (plan 9f)", () => {
    expect(trustCookie("tempo_totp_trust", "td_abc", "/auth/", 2_592_000, "Lax")).toBe(
      "tempo_totp_trust=td_abc; Path=/auth/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax",
    );
    expect(clearTrustCookie("tempo_totp_trust", "/auth/", "None")).toBe(
      "tempo_totp_trust=; Path=/auth/; Max-Age=0; HttpOnly; Secure; SameSite=None",
    );
  });
});

describe("json", () => {
  const schema = z.object({ email: z.string() });
  it("parses a valid body", async () => {
    const req = new Request("https://x/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    });
    expect(await readJson(req, schema)).toEqual(ok({ email: "a@example.com" }));
  });
  it("fails invalid_body on bad json and on a schema miss", async () => {
    const bad = new Request("https://x/", { method: "POST", body: "{" });
    expect(await readJson(bad, schema)).toEqual(fail("invalid_body"));
    const miss = new Request("https://x/", { method: "POST", body: JSON.stringify({ x: 1 }) });
    expect(await readJson(miss, schema)).toEqual(fail("invalid_body"));
  });
  it("respond maps ok to 200 and fail to its status", async () => {
    const good = respond(ok({ a: 1 }));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ a: 1 });
    const bad = respond(fail("rate_limited"));
    expect(bad.status).toBe(429);
    expect(await bad.json()).toEqual({ error: "rate_limited" });
    expect(json({}).headers.get("cache-control")).toBe("no-store");
  });
});

describe("safeNext", () => {
  it("keeps a relative path and rejects everything else", () => {
    expect(safeNext("/home?x=1")).toBe("/home?x=1");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("/\t/evil.example")).toBe("/");
    expect(safeNext("/\n/x")).toBe("/");
    expect(safeNext("/a\\b")).toBe("/");
    expect(safeNext("")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("/".padEnd(2049, "a"))).toBe("/");
  });
});

describe("readBody", () => {
  const schema = z.object({ token: z.string().min(1) });
  it("reads a form-urlencoded body", async () => {
    const req = new Request("https://x/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "ml_abc" }).toString(),
    });
    expect(await readBody(req, schema)).toEqual(ok({ token: "ml_abc" }));
  });
  it("reads a form body whose content type carries a charset", async () => {
    const req = new Request("https://x/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "token=ml_abc",
    });
    expect(await readBody(req, schema)).toEqual(ok({ token: "ml_abc" }));
  });
  it("reads a json body", async () => {
    const req = new Request("https://x/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "ml_abc" }),
    });
    expect(await readBody(req, schema)).toEqual(ok({ token: "ml_abc" }));
  });
  it("keeps a field named like an Object prototype key", async () => {
    const req = new Request("https://x/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "constructor=x&token=ml_abc",
    });
    expect(await readBody(req, schema)).toEqual(ok({ token: "ml_abc" }));
  });
  it("fails invalid_body for another content type, a schema miss, and a repeated field", async () => {
    const text = new Request("https://x/", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "token=ml_abc",
    });
    expect(await readBody(text, schema)).toEqual(fail("invalid_body"));
    const empty = new Request("https://x/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=",
    });
    expect(await readBody(empty, schema)).toEqual(fail("invalid_body"));
    const none = new Request("https://x/", { method: "POST" });
    expect(await readBody(none, schema)).toEqual(fail("invalid_body"));
    const twice = new Request("https://x/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=a&token=b",
    });
    expect(await readBody(twice, schema)).toEqual(fail("invalid_body"));
  });
});

describe("confirm page", () => {
  it("escapes the five HTML characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
  it("renders a form that posts the escaped token to the action (Review Focus 2)", () => {
    const html = defaultConfirmPage({
      action: "/auth/magic-link/verify",
      token: `<script>`,
      appName: "App",
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<form method="post" action="/auth/magic-link/verify">`);
    expect(html).toContain(`<input type="hidden" name="token" value="&lt;script&gt;">`);
    expect(html).not.toContain("<script>");
    expect(html).toContain(`<button type="submit">Continue</button>`);
    expect(html).toContain(`<meta name="referrer" content="strict-origin">`);
    expect(html).toContain(`<meta name="robots" content="noindex">`);
  });
  it("escapes the action too", () => {
    const html = defaultConfirmPage({ action: `/a"b`, token: "ml_x", appName: "App" });
    expect(html).toContain(`action="/a&quot;b"`);
  });
});

describe("oauth binding cookie", () => {
  it("is HttpOnly, Secure, SameSite=None on the social path", () => {
    expect(oauthCookie("__Secure-tempo_session_oauth", "abc", "/auth/social", 600)).toBe(
      "__Secure-tempo_session_oauth=abc; Path=/auth/social; Max-Age=600; HttpOnly; Secure; SameSite=None",
    );
    expect(clearOauthCookie("__Secure-tempo_session_oauth", "/auth/social")).toBe(
      "__Secure-tempo_session_oauth=; Path=/auth/social; Max-Age=0; HttpOnly; Secure; SameSite=None",
    );
  });
});

describe("redirect", () => {
  it("answers 302 with no-store", () => {
    const res = redirect("https://api.example.com/x");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://api.example.com/x");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("csp", () => {
  const cfg = (over = {}) =>
    resolveConfig({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: ["https://app.example.com", "consumera://", "http://localhost:5173"],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      ...over,
    });
  it("lists self, the http(s) trusted origins, and the handoff schemes", () => {
    expect(formAction(cfg())).toBe("'self' https://app.example.com http://localhost:5173");
    expect(formAction(cfg({ handoff: { schemes: ["consumera://", "com.example.app://"] } }))).toBe(
      "'self' https://app.example.com http://localhost:5173 consumera: com.example.app:",
    );
  });
  describe("confirmPagePolicy", () => {
    const dev = cfg({
      handoff: {
        schemes: ["consumera://"],
        devRedirectPattern:
          /^(exp:\/\/[\d.]+:\d+\/--\/auth|http:\/\/127\.0\.0\.1(:\d+)?\/auth|https:\/\/localhost:\d+\/auth|http:\/\/\[::1\]:\d+\/auth|https:\/\/evil\.example\/auth)$/,
      },
    });
    const withAction = (extra: string) =>
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.example.com http://localhost:5173 consumera:${extra}; base-uri 'none'; frame-ancestors 'none'`;
    it("adds the scheme of a custom scheme dev redirect", () => {
      expect(confirmPagePolicy(dev, "exp://192.168.1.10:8081/--/auth")).toBe(withAction(" exp:"));
    });
    it("adds the origin of a loopback dev redirect", () => {
      expect(confirmPagePolicy(dev, "http://127.0.0.1:43123/auth")).toBe(
        withAction(" http://127.0.0.1:43123"),
      );
    });
    it("adds the https origin of a localhost dev redirect, with its port", () => {
      expect(confirmPagePolicy(dev, "https://localhost:8443/auth")).toBe(
        withAction(" https://localhost:8443"),
      );
    });
    it("adds the origin with no port for a loopback dev redirect on the default port", () => {
      // The URL parser drops the default port, so the source is the bare origin.
      expect(confirmPagePolicy(dev, "http://127.0.0.1:80/auth")).toBe(
        withAction(" http://127.0.0.1"),
      );
    });
    it("adds nothing for a redirect on the schemes list, or for one the start would refuse", () => {
      expect(confirmPagePolicy(dev, "consumera://auth")).toBe(noScriptPagePolicy(dev));
      expect(confirmPagePolicy(dev, "https://evil.example/auth")).toBe(noScriptPagePolicy(dev));
      expect(confirmPagePolicy(dev, "http://[::1]:8081/auth")).toBe(noScriptPagePolicy(dev));
    });
    it("keeps the old header byte for byte when no dev pattern is set", () => {
      const plain = cfg({ handoff: { schemes: ["consumera://"] } });
      expect(confirmPagePolicy(plain, "exp://192.168.1.10:8081/--/auth")).toBe(
        noScriptPagePolicy(plain),
      );
    });
  });
  it("sends strict-origin, never no-referrer", () => {
    // With no-referrer, Chrome sends "Origin: null" on a same-origin form post and the router answers 403 (headless Chrome 155, 2026-10-09). no-referrer must never come back.
    expect(pageHeaders(cfg(), "x")["referrer-policy"]).toBe("strict-origin");
  });
  it("builds the page headers with the policy and no-store", () => {
    const h = pageHeaders(cfg(), "default-src 'none'");
    expect(h).toEqual({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "strict-origin",
      "x-robots-tag": "noindex",
      "content-security-policy": "default-src 'none'",
    });
  });
});

describe("handoff confirm page", () => {
  const input = {
    action: "/auth/handoff/continue",
    handoffId: "hs_abc",
    email: "ada@example.com",
    redirect: "consumera://auth",
    appName: "App",
  };
  it("shows the account and the redirect and posts the id to the action", () => {
    const html = defaultHandoffConfirmPage(input);
    expect(html).toContain("Signed in as <strong>ada@example.com</strong>");
    expect(html).toContain("<code>consumera://auth</code>");
    expect(html).toContain(`<form method="post" action="/auth/handoff/continue">`);
    expect(html).toContain(`<input type="hidden" name="h" value="hs_abc">`);
    expect(html).toContain(`<meta name="referrer" content="strict-origin">`);
    expect(html).not.toContain("<script");
  });
  it("escapes every value", () => {
    const html = defaultHandoffConfirmPage({
      ...input,
      redirect: "http://127.0.0.1/<b>",
      email: `a"<i>@x`,
      handoffId: `h"><script>`,
      action: `/a"b`,
    });
    expect(html).toContain("http://127.0.0.1/&lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<script");
    expect(html).toContain(`action="/a&quot;b"`);
  });
});

describe("resolveNext and authErrorUrl", () => {
  const cfg = resolveConfig({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: ["https://app.example.com"],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
  });
  it("sends an app path to appURL and an auth path to baseURL (Review Focus 2)", () => {
    expect(resolveNext(cfg, "/dashboard")).toBe("https://app.example.com/dashboard");
    expect(resolveNext(cfg, "/")).toBe("https://app.example.com/");
    expect(resolveNext(cfg, "/auth/handoff/continue?h=hs_x")).toBe(
      "https://api.example.com/auth/handoff/continue?h=hs_x",
    );
    expect(resolveNext(cfg, "/authx")).toBe("https://app.example.com/authx");
  });
  it("sends an error to appURL", () => {
    expect(authErrorUrl(cfg, "invalid_token")).toBe(
      "https://app.example.com/?auth_error=invalid_token",
    );
  });
});

describe("isJsonRequest", () => {
  it("is true for application/json with or without a charset", () => {
    const req = (headers: Record<string, string>) =>
      new Request("https://x/", { method: "POST", headers });
    expect(isJsonRequest(req({ "content-type": "application/json; charset=utf-8" }))).toBe(true);
    expect(isJsonRequest(req({ "content-type": "application/x-www-form-urlencoded" }))).toBe(false);
    expect(isJsonRequest(req({}))).toBe(false);
  });
});

describe("appName on the pages", () => {
  it("escapes the name in the title and the heading of each page", () => {
    const appName = "A<b>";
    const signIn = defaultSignInPage({
      basePath: "/auth",
      continuePath: "/auth/handoff/continue?h=hs_abc",
      methods: {
        magicLink: true as const,
        google: false,
        apple: false,
        passkey: false,
        password: false,
        providers: [],
      },
      nonce: "n0nce",
      appName,
    });
    expect(signIn).toContain("<title>Sign in to A&lt;b&gt;</title>");
    expect(signIn).toContain("<h1>Sign in to A&lt;b&gt;</h1>");
    const confirm = defaultConfirmPage({ action: "/a", token: "ml_x", appName });
    expect(confirm).toContain("<title>Continue to sign in to A&lt;b&gt;</title>");
    expect(confirm).toContain("<h1>Continue to sign in to A&lt;b&gt;</h1>");
    const handoff = defaultHandoffConfirmPage({
      action: "/a",
      handoffId: "hs_abc",
      email: "ada@example.com",
      redirect: "consumera://auth",
      appName,
    });
    expect(handoff).toContain("<title>Continue to A&lt;b&gt;</title>");
    expect(handoff).toContain("<h1>Continue to A&lt;b&gt;?</h1>");
    for (const html of [signIn, confirm, handoff]) expect(html).not.toContain("A<b>");
  });
});

describe("sign-in page", () => {
  const input = {
    basePath: "/auth",
    continuePath: "/auth/handoff/continue?h=hs_abc",
    methods: {
      magicLink: true as const,
      google: true,
      apple: false,
      passkey: true,
      password: false,
      providers: [],
    },
    nonce: "n0nce",
    appName: "App",
  };
  it("renders one button per list provider, with the name encoded in the path and the label escaped (plan 9c)", () => {
    const html = defaultSignInPage({
      ...input,
      methods: {
        ...input.methods,
        providers: [
          { name: "github", label: "Continue with GitHub" },
          { name: "acme", label: `<img src=x onerror=alert(1)> & "Acme"` },
          { name: `a b"`, label: "Odd" },
        ],
      },
    });
    const next = "next=%2Fauth%2Fhandoff%2Fcontinue%3Fh%3Dhs_abc";
    expect(html).toContain(
      `<a class="button" href="/auth/social/github/start?${next}">Continue with GitHub</a>`,
    );
    expect(html).toContain(
      `<a class="button" href="/auth/social/acme/start?${next}">&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Acme&quot;</a>`,
    );
    expect(html).toContain(`href="/auth/social/a%20b%22/start?${next}"`);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Acme&quot;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    // Google keeps its own flag and its place before the list.
    expect(html.indexOf("/social/google/start")).toBeLessThan(html.indexOf("/social/github/start"));
  });

  it("renders the enabled methods with the nonce and escaped values", () => {
    const html = defaultSignInPage(input);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<script nonce="n0nce">`);
    expect(html).toContain(`<form id="magic-link"`);
    expect(html).toContain(
      `href="/auth/social/google/start?next=%2Fauth%2Fhandoff%2Fcontinue%3Fh%3Dhs_abc"`,
    );
    expect(html).not.toContain("/social/apple/start");
    expect(html).toContain(`<button id="passkey"`);
    expect(html).toContain(`data-continue="/auth/handoff/continue?h=hs_abc"`);
    expect(html).toContain(`<meta name="referrer" content="strict-origin">`);
    // The script sets `hidden` on the passkey button when the browser lacks
    // the JSON parsers. The page's own `button { display: block }` rule beats
    // the browser's hidden rule, so the page must carry its own.
    expect(html).toContain("[hidden] { display: none !important; }");
    expect(html).toContain("passkey.hidden = true");
  });
  it("shows the password form and the forgot button only when methods.password is true (plan 8)", () => {
    const pw = {
      basePath: "/auth",
      continuePath: "/auth/handoff/continue?h=hs_1",
      methods: {
        magicLink: true as const,
        google: false,
        apple: false,
        passkey: false,
        password: true,
        providers: [],
      },
      nonce: "n1",
      appName: "Acme",
    };
    const on = defaultSignInPage(pw);
    // An explicit action: with no script the browser posts to the sign-in
    // route, not to the continue path (plan 8 final review N-4).
    expect(on).toContain(
      `<form id="password" method="post" action="/auth/password/sign-in" autocomplete="on">`,
    );
    expect(on).toContain(`autocomplete="current-password"`);
    expect(on).toContain(`<button id="forgot" type="button">Forgot password</button>`);
    expect(on).toContain(`postJson("/password/sign-in"`);
    expect(on).toContain(`postJson("/password/reset/request", { email: email, next: cont })`);
    const off = defaultSignInPage({ ...pw, methods: { ...pw.methods, password: false } });
    expect(off).not.toContain(`id="password"`);
    expect(off).not.toContain(`id="forgot"`);
  });
  it("offers Create account beside Sign in only when methods.password is true, and posts it to the sign-up route (plan 10)", () => {
    const pw = {
      basePath: "/auth",
      continuePath: "/auth/handoff/continue?h=hs_1",
      methods: {
        magicLink: true as const,
        google: false,
        apple: false,
        passkey: false,
        password: true,
        providers: [],
      },
      nonce: "n1",
      appName: "Acme",
    };
    const on = defaultSignInPage(pw);
    expect(on).toContain(`<button id="sign-up" type="button">Create account</button>`);
    const start = on.indexOf(`postJson("/password/sign-up"`);
    expect(start).toBeGreaterThan(-1);
    const handler = on.slice(start, on.indexOf(".catch(", start));
    // The same success path as the sign-in: the sign-up answer sets the cookie (spec 8.7 item 1).
    expect(handler).toContain(`if (res.ok) { location.href = cont; return; }`);
    expect(handler).toContain(`fail("An account with this address exists. Sign in instead.");`);
    expect(handler).toContain(`fail("Too many attempts. Try again later.");`);
    // The click handler, from its first line to the post: the form check and the lock
    // run before the post, and the failure helper unlocks both buttons (plan 10 final review L2, L3).
    const click = on.indexOf(`signUp.addEventListener("click"`);
    expect(click).toBeGreaterThan(-1);
    const beforePost = on.slice(click, start);
    expect(beforePost).toContain(`if (!pwForm.reportValidity()) return;`);
    expect(beforePost).toContain(`signUp.disabled = true;`);
    expect(beforePost).toContain(`signInButton.disabled = true;`);
    expect(beforePost).toContain(
      `function fail(text) { signUp.disabled = false; signInButton.disabled = false; say(text); }`,
    );
    // Every code the handler names is a real core code, so a renamed code fails here.
    const codes = [...handler.matchAll(/code === "([a-z_]+)"/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual([
      "email_taken",
      "email_taken_unverified",
      "password_breached",
      "password_policy",
    ]);
    for (const c of codes) expect(Object.hasOwn(ERRORS, c as string)).toBe(true);
    const off = defaultSignInPage({ ...pw, methods: { ...pw.methods, password: false } });
    expect(off).not.toContain(`id="sign-up"`);
  });
  it("shows the magic link form only when methods.magicLink is true, and its script checks for it (plan 9)", () => {
    const off = defaultSignInPage({ ...input, methods: { ...input.methods, magicLink: false } });
    expect(off).not.toContain(`id="magic-link"`);
    expect(off).toContain(`if (ml) ml.addEventListener("submit"`);
    expect(defaultSignInPage(input)).toContain(
      `<form id="magic-link" method="post" autocomplete="on">`,
    );
  });
  it("says 'not correct' for a 401 only and 'not accepted' for every other failure but 429 (plan 8 final review M-1)", () => {
    const html = defaultSignInPage({ ...input, methods: { ...input.methods, password: true } });
    const start = html.indexOf(`postJson("/password/sign-in"`);
    const handler = html.slice(start, html.indexOf(".catch(", start));
    expect(handler).toContain(
      `else if (res.status === 401) say("The email or the password is not correct.");`,
    );
    expect(handler).toContain(
      `else if (res.status === 429) say("Too many attempts. Try again later.");`,
    );
    expect(handler).toContain(`else say("The request was not accepted.");`);
    expect(html.split("is not correct").length).toBe(2);
  });
  it("escapes the continue path and hides disabled methods", () => {
    const html = defaultSignInPage({
      ...input,
      continuePath: `/auth/x"><script>`,
      methods: {
        magicLink: true,
        google: false,
        apple: true,
        passkey: false,
        password: false,
        providers: [],
      },
    });
    expect(html).toContain(`data-continue="/auth/x&quot;&gt;&lt;script&gt;"`);
    expect(html).not.toContain(`<script>`);
    expect(html).not.toContain(`id="passkey"`);
    expect(html).toContain("/social/apple/start");
  });
  it("posts next with the password, and goes to the challenge page on a challenge answer (plan 9f)", () => {
    const html = defaultSignInPage({ ...input, methods: { ...input.methods, password: true } });
    const start = html.indexOf(`postJson("/password/sign-in"`);
    const handler = html.slice(start, html.indexOf(".catch(", start));
    expect(handler).toContain(
      `postJson("/password/sign-in", { email: pwForm.elements.email.value, password: pwForm.elements.password.value, next: cont })`,
    );
    expect(handler).toContain(
      `if (body && body.twoFactor) location.href = base + "/totp/challenge?challenge=" + encodeURIComponent(body.twoFactor.challenge);`,
    );
    expect(handler).toContain("else location.href = cont;");
  });
});

describe("the TOTP challenge page (plan 9f)", () => {
  const input = {
    action: "/auth/totp/challenge",
    challenge: `tf_"><b>`,
    appName: "Acme & Co",
    backup: false,
    trustDays: 30,
    error: null,
    methods: ["totp", "backup"] as const,
    method: "totp" as const,
    trusted: false,
    emailSent: false,
  };

  it("escapes every value, offers the backup link, and shows the error only when set", () => {
    const html = defaultTotpPage(input);
    expect(html).toContain('<input type="hidden" name="challenge" value="tf_&quot;&gt;&lt;b&gt;">');
    expect(html).toContain("Enter the code for Acme &amp; Co");
    expect(html).toContain("Trust this device for 30 days");
    expect(html).toContain(
      '<a href="/auth/totp/challenge?challenge=tf_%22%3E%3Cb%3E&amp;backup=1">Use a backup code</a>',
    );
    expect(html).not.toContain("not correct");
    expect(html).not.toContain("<b>");
    const shown = defaultTotpPage({
      ...input,
      backup: true,
      method: "backup",
      error: "invalid_code",
    });
    expect(shown).toContain("The code is not correct. Try again.");
    expect(shown).toContain('name="backupCode"');
    expect(shown).toContain("Use a code from your authenticator app");
  });

  it("offers the email method with a send button, the code form after a send, and the trusted-device button (plan 12c)", () => {
    const email = defaultTotpPage({
      ...input,
      methods: ["totp", "email", "backup"],
      method: "email",
    });
    expect(email).toContain('<input type="hidden" name="action" value="send-email">');
    expect(email).toContain("Send a code to my email");
    expect(email).not.toContain('name="emailCode"');
    const sent = defaultTotpPage({
      ...input,
      methods: ["totp", "email", "backup"],
      method: "email",
      emailSent: true,
    });
    expect(sent).toContain('name="emailCode"');
    expect(sent).toContain("Send a new code");
    const trusted = defaultTotpPage({ ...input, trusted: true });
    expect(trusted).toContain('<input type="hidden" name="action" value="trusted">');
    expect(trusted).toContain("Continue on this trusted device");
    const totp = defaultTotpPage({ ...input, methods: ["totp", "email", "backup"] });
    expect(totp).toContain("&amp;method=email");
    expect(totp).not.toContain("trusted device</button>");
    const passkey = defaultTotpPage({ ...input, methods: ["passkey", "backup"], method: "backup" });
    expect(passkey).toContain("A passkey works in the app's own sign-in page.");
  });

  it("links no method that the challenge does not offer (plan 12c)", () => {
    expect(defaultTotpPage(input)).not.toContain("method=email");
    const email = defaultTotpPage({ ...input, methods: ["email", "backup"], method: "email" });
    expect(email).not.toContain("Use a code from your authenticator app");
    const only = defaultTotpPage({ ...input, methods: ["totp"] });
    expect(only).not.toContain("Use a backup code");
  });
});
