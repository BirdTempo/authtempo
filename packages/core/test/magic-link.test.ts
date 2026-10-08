import { describe, expect, it } from "vitest";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { magicLinkRoutes } from "../src/http/routes/magic-link.js";
import { get, makeAuth, post, tokenFromMail } from "./helpers.js";

describe("magic link engine", () => {
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
    clock.advance(16 * 60_000);
    expect(await verifyMagicLink(config, { token, ip: null, userAgent: null })).toMatchObject({
      ok: false,
      code: "invalid_token",
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

  it("GET verify sets the cookie and redirects to next", async () => {
    const { config, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com", next: "/home" }));
    const token = tokenFromMail(mail[0]?.text ?? "");
    const res = await handle(get(`/auth/magic-link/verify?token=${encodeURIComponent(token)}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://api.example.com/home");
    expect(res.headers.get("set-cookie")).toMatch(
      /^tempo_session=ts_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("GET verify with a spent or missing token redirects to / with auth_error", async () => {
    const { config, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    await handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    const token = tokenFromMail(mail[0]?.text ?? "");
    await handle(get(`/auth/magic-link/verify?token=${encodeURIComponent(token)}`));
    const spent = await handle(get(`/auth/magic-link/verify?token=${encodeURIComponent(token)}`));
    expect(spent.status).toBe(302);
    expect(spent.headers.get("location")).toBe("https://api.example.com/?auth_error=invalid_token");
    expect(spent.headers.get("set-cookie")).toBeNull();
    const missing = await handle(get("/auth/magic-link/verify"));
    expect(missing.headers.get("location")).toBe(
      "https://api.example.com/?auth_error=invalid_token",
    );
  });
});
