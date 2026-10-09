import { describe, expect, it } from "vitest";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { magicLinkRoutes } from "../src/http/routes/magic-link.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post, tokenFromMail } from "./helpers.js";

describe("magic link engine", () => {
  it("names the app in the mail subject", async () => {
    const def = makeAuth();
    await requestMagicLink(def.config, { email: "ada@example.com", ip: null });
    expect(def.mail[0]?.subject).toBe("Sign in to api.example.com");
    const named = makeAuth({ appName: "Acme" });
    await requestMagicLink(named.config, { email: "ada@example.com", ip: null });
    expect(named.mail[0]?.subject).toBe("Sign in to Acme");
  });
  it("sends a link whose token is stored only as a hash", async () => {
    const { config, storage, mail } = makeAuth();
    const r = await requestMagicLink(config, {
      email: "ada@example.com",
      next: "/home",
      ip: "1.1.1.1",
    });
    expect(r).toEqual({ ok: true, value: { sent: true } });
    expect(mail).toHaveLength(1);
    expect(mail[0]?.to).toBe("ada@example.com");
    const token = tokenFromMail(mail[0]?.text ?? "");
    expect(token.startsWith("ml_")).toBe(true);
    const rows = await storage.findMany("verification", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "magic-link",
      identifier: "ada@example.com",
      consumedAt: null,
      data: { next: "/home" },
    });
    expect(JSON.stringify(rows)).not.toContain(token.slice(3));
  });

  it("normalizes the email so two spellings make one user (Review Focus 1)", async () => {
    const { config, mail } = makeAuth();
    await requestMagicLink(config, { email: "  Ada@Example.COM ", ip: null });
    expect(mail[0]?.to).toBe("ada@example.com");
    const a = await verifyMagicLink(config, {
      token: tokenFromMail(mail[0]?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    await requestMagicLink(config, { email: "ADA@example.com", ip: null });
    const b = await verifyMagicLink(config, {
      token: tokenFromMail(mail[1]?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    expect(a.ok && b.ok && a.value.user.id === b.value.user.id).toBe(true);
  });

  it("answers ok and sends nothing for an email that is not an address", async () => {
    const { config, mail } = makeAuth();
    expect(await requestMagicLink(config, { email: "not-an-address", ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    expect(mail).toHaveLength(0);
  });

  it("rate limits per email and per ip", async () => {
    const { config } = makeAuth();
    for (let i = 0; i < 5; i++)
      expect((await requestMagicLink(config, { email: "a@example.com", ip: "9.9.9.9" })).ok).toBe(
        true,
      );
    expect(await requestMagicLink(config, { email: "a@example.com", ip: "9.9.9.9" })).toMatchObject(
      { ok: false, code: "rate_limited" },
    );
    for (let i = 0; i < 20; i++)
      await requestMagicLink(config, { email: `u${i}@example.com`, ip: "8.8.8.8" });
    expect(
      await requestMagicLink(config, { email: "fresh@example.com", ip: "8.8.8.8" }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("counts a request with no ip against one shared budget", async () => {
    const { config } = makeAuth();
    for (let i = 0; i < 20; i++)
      expect((await requestMagicLink(config, { email: `n${i}@example.com`, ip: null })).ok).toBe(
        true,
      );
    expect(await requestMagicLink(config, { email: "n20@example.com", ip: null })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
  });

  it("verifies once, creates the user and a session, then rejects the same link (Review Focus 2)", async () => {
    const { config, storage, mail } = makeAuth();
    await requestMagicLink(config, { email: "ada@example.com", next: "/home", ip: null });
    const token = tokenFromMail(mail[0]?.text ?? "");
    const first = await verifyMagicLink(config, { token, ip: "1.1.1.1", userAgent: "ua" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.next).toBe("/home");
    expect(first.value.user.email).toBe("ada@example.com");
    expect((await resolveSession(config, first.value.token))?.user.id).toBe(first.value.user.id);
    const second = await verifyMagicLink(config, { token, ip: null, userAgent: null });
    expect(second).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await storage.findMany("user", [])).toHaveLength(1);
    expect(await storage.findMany("session", [])).toHaveLength(1);
  });

  it("rejects an expired link and a malformed token", async () => {
    const { config, clock, mail } = makeAuth();
    await requestMagicLink(config, { email: "ada@example.com", ip: null });
    const token = tokenFromMail(mail[0]?.text ?? "");
    clock.advance(15 * 60_000);
    expect(await verifyMagicLink(config, { token, ip: null, userAgent: null })).toMatchObject({
      ok: false,
      code: "token_expired",
    });
    expect(
      await verifyMagicLink(config, { token: "nope", ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
  });

  it("replaces an unsafe next with / (Review Focus 3)", async () => {
    const { config, mail } = makeAuth();
    for (const next of ["//evil.example", "https://evil.example", "javascript:alert(1)"]) {
      await requestMagicLink(config, { email: "ada@example.com", next, ip: null });
      const token = tokenFromMail(mail[mail.length - 1]?.text ?? "");
      const r = await verifyMagicLink(config, { token, ip: null, userAgent: null });
      expect(r.ok && r.value.next).toBe("/");
    }
  });
});

describe("magic link routes", () => {
  const VERIFY = "/auth/magic-link/verify";

  /** A browser form post from the confirm page: same origin as baseURL. */
  function verifyForm(token: string, headers: Record<string, string> = {}): Request {
    return new Request(`${BASE_URL}${VERIFY}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE_URL,
        ...headers,
      },
      body: new URLSearchParams({ token }).toString(),
    });
  }

  it("POST request answers 200 with no detail, 400 on a bad body, 429 when limited", async () => {
    const { config, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    const ok = await handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sent: true });
    expect(mail).toHaveLength(1);
    expect((await handle(post("/auth/magic-link/request", { nope: 1 }))).status).toBe(400);
    for (let i = 0; i < 5; i++)
      await handle(post("/auth/magic-link/request", { email: "b@example.com" }));
    expect(
      (await handle(post("/auth/magic-link/request", { email: "b@example.com" }))).status,
    ).toBe(429);
  });

  it("GET verify renders the confirm page with the token and no side effect (Review Focus 1)", async () => {
    const { config, storage, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com", next: "/home" }));
    const token = tokenFromMail(mail[0]?.text ?? "");
    // Count every call to storage and the limiter while GET runs. Zero is the rule.
    const calls: string[] = [];
    const counting = <T extends object>(name: string, target: T): T =>
      new Proxy(target, {
        get(obj, prop, receiver) {
          const value = Reflect.get(obj, prop, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            calls.push(`${name}.${String(prop)}`);
            return Reflect.apply(value, obj, args);
          };
        },
      });
    const spied = {
      ...config,
      storage: counting("storage", config.storage),
      limiter: counting("limiter", config.limiter),
    };
    const spiedHandle = createRouter(spied, magicLinkRoutes(spied));
    let page: Response | undefined;
    for (let i = 0; i < 3; i++) {
      page = await spiedHandle(get(`${VERIFY}?token=${encodeURIComponent(token)}`));
      expect(page.status).toBe(200);
    }
    expect(calls).toEqual([]);
    if (!page) throw new Error("no page");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("strict-origin");
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.example.com; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(page.headers.get("set-cookie")).toBeNull();
    const html = await page.text();
    expect(html).toContain(`<form method="post" action="${VERIFY}">`);
    expect(html).toContain(`<input type="hidden" name="token" value="${token}">`);
    const rows = await storage.findMany("verification", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumedAt).toBeNull();
    expect(await storage.findMany("session", [])).toHaveLength(0);
    expect(await storage.findMany("user", [])).toHaveLength(0);
  });

  it("GET verify uses the configured page", async () => {
    const { config, mail } = makeAuth({
      magicLink: { confirmPage: (i) => `<p>custom ${i.action} ${i.token}</p>` },
    });
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    const token = tokenFromMail(mail[0]?.text ?? "");
    const page = await handle(get(`${VERIFY}?token=${encodeURIComponent(token)}`));
    expect(await page.text()).toBe(`<p>custom ${VERIFY} ${token}</p>`);
  });

  it("GET verify with a malformed or missing token redirects without rendering (Review Focus 2)", async () => {
    const { config } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    for (const path of [
      VERIFY,
      `${VERIFY}?token=`,
      `${VERIFY}?token=${encodeURIComponent("<script>")}`,
      `${VERIFY}?token=ml_short`,
    ]) {
      const res = await handle(get(path));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://api.example.com/?auth_error=invalid_token");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("POST verify sets the cookie and redirects to next", async () => {
    const { config, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com", next: "/home" }));
    const token = tokenFromMail(mail[0]?.text ?? "");
    const res = await handle(verifyForm(token));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://api.example.com/home");
    expect(res.headers.get("set-cookie")).toMatch(
      /^tempo_session=ts_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("POST verify with a JSON body answers the session as JSON with the cookie, and errors as JSON", async () => {
    const { config, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    const token = tokenFromMail(mail[0]?.text ?? "");
    const res = await handle(post(VERIFY, { token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { email: "ada@example.com" },
      session: { id: expect.any(String) },
    });
    expect(res.headers.get("set-cookie")).toMatch(/^tempo_session=ts_/);
    const again = await handle(post(VERIFY, { token }));
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_token" });
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("redirects to appURL after a form verify, and keeps an auth path on baseURL (Review Focus 2)", async () => {
    const { config, mail } = makeAuth({ appURL: APP_ORIGIN });
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com", next: "/home" }));
    const r1 = await handle(verifyForm(tokenFromMail(mail[0]?.text ?? "")));
    expect(r1.headers.get("location")).toBe(`${APP_ORIGIN}/home`);
    await handle(
      post("/auth/magic-link/request", {
        email: "ada@example.com",
        next: "/auth/handoff/continue?h=hs_1",
      }),
    );
    const r2 = await handle(verifyForm(tokenFromMail(mail[1]?.text ?? "")));
    expect(r2.headers.get("location")).toBe(`${BASE_URL}/auth/handoff/continue?h=hs_1`);
    const bad = await handle(verifyForm("ml_nope"));
    expect(bad.headers.get("location")).toBe(`${APP_ORIGIN}/?auth_error=invalid_token`);
  });

  it("widens form-action to the trusted web origins and the handoff schemes", async () => {
    const { config, mail } = makeAuth({ handoff: { schemes: ["consumera://"] } });
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    const page = await handle(
      get(`${VERIFY}?token=${encodeURIComponent(tokenFromMail(mail[0]?.text ?? ""))}`),
    );
    expect(page.headers.get("content-security-policy")).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${APP_ORIGIN} consumera:; base-uri 'none'; frame-ancestors 'none'`,
    );
  });

  it("POST verify twice signs in once (Review Focus 3)", async () => {
    const { config, storage, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    const token = tokenFromMail(mail[0]?.text ?? "");
    const first = await handle(verifyForm(token));
    expect(first.status).toBe(302);
    expect(first.headers.get("set-cookie")).toMatch(/^tempo_session=ts_/);
    const second = await handle(verifyForm(token));
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe(
      "https://api.example.com/?auth_error=invalid_token",
    );
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(await storage.findMany("session", [])).toHaveLength(1);
  });

  it("POST verify from a foreign origin is refused and consumes nothing (Review Focus 4)", async () => {
    const { config, storage, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    const token = tokenFromMail(mail[0]?.text ?? "");
    const res = await handle(verifyForm(token, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    const rows = await storage.findMany("verification", []);
    expect(rows[0]?.consumedAt).toBeNull();
    expect((await handle(verifyForm(token))).headers.get("set-cookie")).toMatch(
      /^tempo_session=ts_/,
    );
  });

  it("POST verify with an expired token redirects with auth_error=token_expired", async () => {
    const { config, mail, clock } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    const token = tokenFromMail(mail[0]?.text ?? "");
    clock.advance(15 * 60_000);
    const res = await handle(verifyForm(token));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://api.example.com/?auth_error=token_expired");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("POST verify with a spent token reports invalid_token even after it expires", async () => {
    const { config, mail, clock } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    const token = tokenFromMail(mail[0]?.text ?? "");
    await handle(verifyForm(token));
    clock.advance(15 * 60_000);
    const res = await handle(verifyForm(token));
    expect(res.headers.get("location")).toBe("https://api.example.com/?auth_error=invalid_token");
  });

  it("POST verify with a missing, empty, or badly encoded token redirects with invalid_token (Review Focus 5)", async () => {
    const { config } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    const bodies: Request[] = [
      verifyForm(""),
      new Request(`${BASE_URL}${VERIFY}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
        body: "nope=1",
      }),
      new Request(`${BASE_URL}${VERIFY}`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: BASE_URL },
        body: "token=ml_x",
      }),
      new Request(`${BASE_URL}${VERIFY}`, { method: "POST", headers: { origin: BASE_URL } }),
    ];
    for (const req of bodies) {
      const res = await handle(req);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://api.example.com/?auth_error=invalid_token");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });
});
