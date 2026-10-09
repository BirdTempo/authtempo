import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveConfig } from "../src/config.js";
import { isJsonRequest, readBody } from "../src/http/body.js";
import { defaultConfirmPage, escapeHtml } from "../src/http/confirm-page.js";
import {
  clearOauthCookie,
  clearSessionCookie,
  oauthCookie,
  readCookie,
  sessionCookie,
} from "../src/http/cookies.js";
import { formAction, pageHeaders } from "../src/http/csp.js";
import { defaultHandoffConfirmPage } from "../src/http/handoff-confirm-page.js";
import { json, readJson, respond } from "../src/http/json.js";
import { authErrorUrl, redirect, resolveNext } from "../src/http/redirect.js";
import { safeNext } from "../src/http/safe-next.js";
import { defaultSignInPage } from "../src/http/sign-in-page.js";
import { fail, ok } from "../src/result.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

describe("cookies", () => {
  it("sets an HttpOnly Secure SameSite=Lax cookie on /", () => {
    const c = sessionCookie("tempo_session", "ts_abc", 60, "Lax");
    expect(sessionCookie("tempo_session", "ts_abc", 60, "None")).toBe(
      "tempo_session=ts_abc; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=None",
    );
    expect(c).toBe("tempo_session=ts_abc; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax");
  });
  it("clears with Max-Age=0", () => {
    expect(clearSessionCookie("tempo_session", "Lax")).toBe(
      "tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
  });
  it("reads one cookie among several", () => {
    const req = new Request("https://x/", {
      headers: { cookie: "a=1; tempo_session=ts_abc; b=2" },
    });
    expect(readCookie(req, "tempo_session")).toBe("ts_abc");
    expect(readCookie(req, "nope")).toBeNull();
    expect(readCookie(new Request("https://x/"), "tempo_session")).toBeNull();
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
    expect(oauthCookie("tempo_session_oauth", "abc", "/auth/social", 600)).toBe(
      "tempo_session_oauth=abc; Path=/auth/social; Max-Age=600; HttpOnly; Secure; SameSite=None",
    );
    expect(clearOauthCookie("tempo_session_oauth", "/auth/social")).toBe(
      "tempo_session_oauth=; Path=/auth/social; Max-Age=0; HttpOnly; Secure; SameSite=None",
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
      methods: { magicLink: true as const, google: false, apple: false, passkey: false },
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
    methods: { magicLink: true as const, google: true, apple: false, passkey: true },
    nonce: "n0nce",
    appName: "App",
  };
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
  it("escapes the continue path and hides disabled methods", () => {
    const html = defaultSignInPage({
      ...input,
      continuePath: `/auth/x"><script>`,
      methods: { magicLink: true, google: false, apple: true, passkey: false },
    });
    expect(html).toContain(`data-continue="/auth/x&quot;&gt;&lt;script&gt;"`);
    expect(html).not.toContain(`<script>`);
    expect(html).not.toContain(`id="passkey"`);
    expect(html).toContain("/social/apple/start");
  });
});
