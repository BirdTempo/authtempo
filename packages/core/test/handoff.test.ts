import { describe, expect, it } from "vitest";
import {
  continueHandoff,
  continuePath,
  redeemHandoff,
  startHandoff,
} from "../src/engine/handoff.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { handoffRoutes } from "../src/http/routes/handoff.js";
import { passwordRoutes } from "../src/http/routes/password.js";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import { createPbkdf2PasswordHash } from "../src/seams/password-hash.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post } from "./helpers.js";

const SCHEMES = ["consumera://"];
const DEV = /^exp:\/\/[\d.]+:\d+\/--\/auth$/;

function handoffAuth(over: Parameters<typeof makeAuth>[0] = {}) {
  return makeAuth({ handoff: { schemes: SCHEMES, devRedirectPattern: DEV }, ...over });
}

async function pkce() {
  const verifier = randomBase64Url(32);
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

async function rows(auth: ReturnType<typeof makeAuth>) {
  const found = await auth.storage.findMany("verification", [
    { field: "purpose", op: "eq", value: "handoff-code" },
  ]);
  // The clock is frozen, so row ids tie on time and sort at random. Put the start row first.
  return found.sort((a, b) => Number(b.identifier === "start") - Number(a.identifier === "start"));
}

describe("startHandoff", () => {
  it("writes a start row with the challenge and redirect and returns the handoff id", async () => {
    const auth = handoffAuth();
    const { challenge } = await pkce();
    const r = await startHandoff(auth.config, {
      challenge,
      redirect: "consumera://auth",
      ip: "1.1.1.1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.handoffId).toMatch(/^hs_[A-Za-z0-9_-]{43}$/);
    expect(continuePath(auth.config, r.value.handoffId)).toBe(
      `/auth/handoff/continue?h=${r.value.handoffId}`,
    );
    const [row] = await rows(auth);
    expect(row).toMatchObject({
      identifier: "start",
      consumedAt: null,
      data: { challenge, redirect: "consumera://auth" },
    });
    expect(row?.valueHash).toBe(await sha256Hex(r.value.handoffId));
    expect(row?.expiresAt.getTime()).toBe(auth.clock.now().getTime() + 15 * 60_000);
    expect(JSON.stringify(row)).not.toContain(r.value.handoffId.slice(3));
  });
  it("accepts a dev redirect that matches the pattern, and refuses other redirects and bad challenges (Review Focus 5)", async () => {
    const auth = handoffAuth();
    const { challenge } = await pkce();
    expect(
      (
        await startHandoff(auth.config, {
          challenge,
          redirect: "exp://192.168.1.5:8081/--/auth",
          ip: null,
        })
      ).ok,
    ).toBe(true);
    for (const redirect of [
      "https://evil.example/auth",
      "consumera://evil",
      "consumera://auth?x=1",
      "exp://evil.example:80/--/auth",
      "",
    ]) {
      expect(await startHandoff(auth.config, { challenge, redirect, ip: null })).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    }
    expect(
      await startHandoff(auth.config, {
        challenge: "short",
        redirect: "consumera://auth",
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await rows(auth)).toHaveLength(1);
    const plain = makeAuth({ handoff: { schemes: SCHEMES } });
    expect(
      await startHandoff(plain.config, {
        challenge,
        redirect: "https://evil.example/auth",
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(
      await startHandoff(plain.config, {
        challenge,
        redirect: "exp://192.168.1.5:8081/--/auth",
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    const off = makeAuth();
    expect(
      await startHandoff(off.config, { challenge, redirect: "consumera://auth", ip: null }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
  it("refuses a redirect that contains a fragment, even when the pattern admits it", async () => {
    const auth = makeAuth({ handoff: { schemes: SCHEMES, devRedirectPattern: /.*/ } });
    const { challenge } = await pkce();
    for (const redirect of ["http://127.0.0.1:5000/auth#x", "exp://192.168.1.5:8081/--/auth#"]) {
      expect(await startHandoff(auth.config, { challenge, redirect, ip: null })).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    }
    expect(await rows(auth)).toHaveLength(0);
  });
  it("keeps a start row as long as the magic link, and at least 10 minutes", async () => {
    const { challenge } = await pkce();
    const input = { challenge, redirect: "consumera://auth", ip: null };
    const long = handoffAuth({ magicLink: { ttlMinutes: 20 } });
    await startHandoff(long.config, input);
    expect((await rows(long))[0]?.expiresAt.getTime()).toBe(
      long.clock.now().getTime() + 20 * 60_000,
    );
    const short = handoffAuth({ magicLink: { ttlMinutes: 5 } });
    await startHandoff(short.config, input);
    expect((await rows(short))[0]?.expiresAt.getTime()).toBe(
      short.clock.now().getTime() + 10 * 60_000,
    );
  });
  it("lets a dev pattern admit a non-web scheme or a loopback web URL, never a remote web URL", async () => {
    const auth = makeAuth({ handoff: { schemes: SCHEMES, devRedirectPattern: /.*/ } });
    const { challenge } = await pkce();
    const start = (redirect: string) =>
      startHandoff(auth.config, { challenge, redirect, ip: null });
    expect(await start("https://evil.example/cb")).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(await start("http://evil.example/cb")).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(await start("not a url")).toMatchObject({ ok: false, code: "invalid_body" });
    for (const ok of [
      "exp://192.168.1.5:8081/--/auth",
      "http://127.0.0.1:5000/auth",
      "http://localhost:5173/auth",
      "http://[::1]:5000/auth",
    ])
      expect((await start(ok)).ok, ok).toBe(true);
  });
  it("limits starts to 30 per ip per 15 minutes", async () => {
    const auth = handoffAuth();
    const { challenge } = await pkce();
    for (let i = 0; i < 30; i++)
      expect(
        (
          await startHandoff(auth.config, {
            challenge,
            redirect: "consumera://auth",
            ip: "9.9.9.9",
          })
        ).ok,
      ).toBe(true);
    expect(
      await startHandoff(auth.config, { challenge, redirect: "consumera://auth", ip: "9.9.9.9" }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("continueHandoff and redeemHandoff", () => {
  async function started(auth: ReturnType<typeof makeAuth>) {
    const { verifier, challenge } = await pkce();
    const r = await startHandoff(auth.config, {
      challenge,
      redirect: "consumera://auth",
      ip: null,
    });
    if (!r.ok) throw new Error(r.code);
    return { verifier, handoffId: r.value.handoffId };
  }
  /** A browser session for the user, as the continue route checks it. */
  async function sessionId(auth: ReturnType<typeof makeAuth>, userId: string) {
    return (await createSession(auth.config, { userId, ip: null, userAgent: null })).session.id;
  }
  async function continued(auth: ReturnType<typeof makeAuth>, handoffId: string, userId: string) {
    const browser = await sessionId(auth, userId);
    const r = await continueHandoff(auth.config, { handoffId, userId, sessionId: browser });
    if (!r.ok) throw new Error(r.code);
    const url = new URL(r.value.location);
    return { location: r.value.location, code: url.searchParams.get("code") ?? "", browser };
  }

  it("consumes the start row, mints a code row for the user, and redeems it for a bearer session", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const { verifier, handoffId } = await started(auth);
    const { location, code } = await continued(auth, handoffId, user.id);
    expect(location).toBe(`consumera://auth?code=${code}`);
    expect(code).toMatch(/^hc_[A-Za-z0-9_-]{43}$/);
    const all = await rows(auth);
    expect(all).toHaveLength(2);
    expect(all[0]?.consumedAt).not.toBeNull();
    expect(all[1]).toMatchObject({ identifier: user.id, consumedAt: null });
    expect(all[1]?.valueHash).toBe(await sha256Hex(code));
    expect(all[1]?.expiresAt.getTime()).toBe(auth.clock.now().getTime() + 2 * 60_000);
    const r = await redeemHandoff(auth.config, {
      code,
      verifier,
      ip: "2.2.2.2",
      userAgent: "consumera/1.0",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user.id).toBe(user.id);
    expect(r.value.token).toMatch(/^ts_/);
    expect((await resolveSession(auth.config, r.value.token))?.session.userAgent).toBe(
      "consumera/1.0",
    );
    expect((await rows(auth))[1]?.consumedAt).not.toBeNull();
  });

  it("refuses a live session of one user passed with the user id of another, and mints no code (final review M-6)", async () => {
    const auth = handoffAuth();
    const ada = await auth.seedUser("ada@example.com");
    const bob = await auth.seedUser("bob@example.com");
    const { handoffId } = await started(auth);
    const adaSession = await sessionId(auth, ada.id);
    const r = await continueHandoff(auth.config, {
      handoffId,
      userId: bob.id,
      sessionId: adaSession,
    });
    expect(r).toMatchObject({ ok: false, code: "invalid_token" });
    expect((await rows(auth)).filter((x) => x.identifier === bob.id)).toEqual([]);
  });
  it("redeems a verifier that holds . and ~, as RFC 7636 allows", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const verifier = `a.b~c-d_e${"x".repeat(34)}`;
    expect(verifier).toHaveLength(43);
    const r = await startHandoff(auth.config, {
      challenge: await sha256Base64Url(verifier),
      redirect: "consumera://auth",
      ip: null,
    });
    if (!r.ok) throw new Error(r.code);
    const { code } = await continued(auth, r.value.handoffId, user.id);
    expect(
      (await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null })).ok,
    ).toBe(true);
  });

  it("adds the code to a dev redirect that already has a query", async () => {
    const auth = makeAuth({ handoff: { schemes: SCHEMES, devRedirectPattern: /.*/ } });
    const user = await auth.seedUser("ada@example.com");
    const { challenge } = await pkce();
    const r = await startHandoff(auth.config, {
      challenge,
      redirect: "http://127.0.0.1:5000/auth?x=1",
      ip: null,
    });
    if (!r.ok) throw new Error(r.code);
    const { location, code } = await continued(auth, r.value.handoffId, user.id);
    expect(location).toBe(`http://127.0.0.1:5000/auth?x=1&code=${code}`);
  });

  it("rejects a wrong verifier and consumes the code (Review Focus 3)", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const { handoffId } = await started(auth);
    const { code, browser } = await continued(auth, handoffId, user.id);
    const other = await pkce();
    expect(
      await redeemHandoff(auth.config, {
        code,
        verifier: other.verifier,
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    // The browser session that continued the handoff is not a bearer session.
    expect(
      await auth.storage.findMany("session", [{ field: "id", op: "ne", value: browser }]),
    ).toHaveLength(0);
    expect((await rows(auth))[1]?.consumedAt).not.toBeNull();
  });

  it("rejects a replayed code and keeps one session (Review Focus 4)", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const { verifier, handoffId } = await started(auth);
    const { code, browser } = await continued(auth, handoffId, user.id);
    expect(
      (await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null })).ok,
    ).toBe(true);
    expect(
      await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    expect(
      await auth.storage.findMany("session", [{ field: "id", op: "ne", value: browser }]),
    ).toHaveLength(1);
  });

  it("rejects an expired code, a malformed code, a start id used as a code, and a reused or unknown handoff id", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const { verifier, handoffId } = await started(auth);
    expect(
      await redeemHandoff(auth.config, { code: handoffId, verifier, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    const { code } = await continued(auth, handoffId, user.id);
    expect(
      await continueHandoff(auth.config, {
        handoffId,
        userId: user.id,
        sessionId: await sessionId(auth, user.id),
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(
      await continueHandoff(auth.config, {
        handoffId: "hs_nope",
        userId: user.id,
        sessionId: await sessionId(auth, user.id),
      }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    auth.clock.advance(2 * 60_000);
    expect(
      await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "token_expired" });
    expect(
      await redeemHandoff(auth.config, { code: "nope", verifier, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    const { handoffId: h2 } = await started(auth);
    auth.clock.advance(15 * 60_000);
    expect(
      await continueHandoff(auth.config, {
        handoffId: h2,
        userId: user.id,
        sessionId: await sessionId(auth, user.id),
      }),
    ).toMatchObject({
      ok: false,
      code: "token_expired",
    });
  });

  it("refuses a malformed verifier without spending the code", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const { verifier, handoffId } = await started(auth);
    const { code } = await continued(auth, handoffId, user.id);
    expect(
      await redeemHandoff(auth.config, { code, verifier: "short", ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    expect((await rows(auth))[1]?.consumedAt).toBeNull();
    expect(
      (await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null })).ok,
    ).toBe(true);
  });

  it("limits redeems to 20 per ip per 15 minutes", async () => {
    const auth = handoffAuth();
    for (let i = 0; i < 20; i++) {
      expect(
        await redeemHandoff(auth.config, {
          code: "nope",
          verifier: "v",
          ip: "8.8.8.8",
          userAgent: null,
        }),
      ).toMatchObject({ ok: false, code: "invalid_token" });
    }
    expect(
      await redeemHandoff(auth.config, {
        code: "nope",
        verifier: "v",
        ip: "8.8.8.8",
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("handoff routes", () => {
  async function challenge() {
    const { verifier, challenge } = await pkce();
    return {
      verifier,
      q: `challenge=${challenge}&redirect=${encodeURIComponent("consumera://auth")}`,
    };
  }

  it("GET start renders the sign-in page with the continue path, a nonce, and the policy", async () => {
    const auth = handoffAuth({
      social: { google: { clientId: "g", clientSecret: "s" } },
      passkey: { rpID: "api.example.com", rpName: "x", origins: ["https://api.example.com"] },
    });
    const handle = createRouter(auth.config, handoffRoutes(auth.config));
    const { q } = await challenge();
    const res = await handle(get(`/auth/handoff/start?${q}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1] ?? "";
    expect(nonce).toHaveLength(22);
    expect(csp).toBe(
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self' https://app.example.com consumera:; base-uri 'none'; frame-ancestors 'none'`,
    );
    const html = await res.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`data-continue="/auth/handoff/continue?h=hs_`);
    expect(html).toContain("/social/google/start");
    expect(html).toContain(`id="passkey"`);
  });

  async function signedIn(auth: ReturnType<typeof makeAuth>) {
    const user = await auth.seedUser("ada@example.com");
    const { token } = await createSession(auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    return `tempo_session=${token}`;
  }
  const formPost = (h: string, headers: Record<string, string>) =>
    new Request(`${BASE_URL}/auth/handoff/continue`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ h }).toString(),
    });
  async function startedId(handle: ReturnType<typeof createRouter>, q: string) {
    const page = await handle(get(`/auth/handoff/start?${q}`));
    return (
      /data-continue="\/auth\/handoff\/continue\?h=(hs_[A-Za-z0-9_-]+)"/.exec(
        await page.text(),
      )?.[1] ?? ""
    );
  }

  it("signs in by password on the sign-in page and continues the handoff to a redeem (plan 8)", async () => {
    const auth = handoffAuth({
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    });
    const handle = createRouter(auth.config, [
      ...handoffRoutes(auth.config),
      ...passwordRoutes(auth.config),
    ]);
    const { verifier, q } = await challenge();
    const h = await startedId(handle, q);
    const pageHtml = await (await handle(get(`/auth/handoff/continue?h=${h}`))).text();
    expect(pageHtml).toContain(`id="password"`);
    expect(
      (
        await handle(
          post("/auth/password/sign-up", {
            email: "ada@example.com",
            password: "correct horse battery",
          }),
        )
      ).status,
    ).toBe(200);
    const signIn = await handle(
      post("/auth/password/sign-in", {
        email: "ada@example.com",
        password: "correct horse battery",
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const confirm = await handle(get(`/auth/handoff/continue?h=${h}`, { cookie }));
    expect(await confirm.text()).toContain("Signed in as <strong>ada@example.com</strong>");
    const res = await handle(formPost(h, { origin: BASE_URL, cookie }));
    const code = new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const redeem = await handle(post("/auth/handoff/redeem", { code, verifier }));
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toMatchObject({ user: { email: "ada@example.com" } });
  });

  it("creates an account on the sign-in page and continues the handoff to a redeem (plan 10)", async () => {
    const auth = handoffAuth({
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    });
    const handle = createRouter(auth.config, [
      ...handoffRoutes(auth.config),
      ...passwordRoutes(auth.config),
    ]);
    const { verifier, q } = await challenge();
    const h = await startedId(handle, q);
    const pageHtml = await (await handle(get(`/auth/handoff/continue?h=${h}`))).text();
    expect(pageHtml).toContain(`<button id="sign-up" type="button">Create account</button>`);
    // What the Create account handler sends: the form's two fields, as JSON.
    const up = await handle(
      post("/auth/password/sign-up", {
        email: "new@example.com",
        password: "correct horse battery",
      }),
    );
    expect(up.status).toBe(200);
    const cookie = (up.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const confirm = await handle(get(`/auth/handoff/continue?h=${h}`, { cookie }));
    expect(await confirm.text()).toContain("Signed in as <strong>new@example.com</strong>");
    const res = await handle(formPost(h, { origin: BASE_URL, cookie }));
    const code = new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const redeem = await handle(post("/auth/handoff/redeem", { code, verifier }));
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toMatchObject({
      user: { email: "new@example.com", emailVerified: false },
    });
    // A second Create account on the same address: the code the handler turns into "Sign in instead".
    const again = await handle(
      post("/auth/password/sign-up", {
        email: "new@example.com",
        password: "correct horse battery",
      }),
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "email_taken" });
  });

  it("shows no password form without a password config", async () => {
    const auth = handoffAuth();
    const handle = createRouter(auth.config, handoffRoutes(auth.config));
    const { q } = await challenge();
    const h = await startedId(handle, q);
    expect(await (await handle(get(`/auth/handoff/continue?h=${h}`))).text()).not.toContain(
      `id="password"`,
    );
  });

  it("GET start with a session redirects to the confirm page and mints nothing", async () => {
    const auth = handoffAuth();
    const handle = createRouter(auth.config, handoffRoutes(auth.config));
    const cookie = await signedIn(auth);
    const { q } = await challenge();
    const res = await handle(get(`/auth/handoff/start?${q}`, { cookie }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      new RegExp(`^${BASE_URL}/auth/handoff/continue\\?h=hs_[A-Za-z0-9_-]{43}$`),
    );
    const all = await rows(auth);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ identifier: "start", consumedAt: null });
  });

  it("GET start answers 400 on a bad redirect or challenge, and 429 when limited, as JSON", async () => {
    const auth = handoffAuth();
    const handle = createRouter(auth.config, handoffRoutes(auth.config));
    const bad = await handle(
      get(`/auth/handoff/start?challenge=x&redirect=${encodeURIComponent("https://evil.example")}`),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_body" });
    const { q } = await challenge();
    for (let i = 0; i < 30; i++)
      await handle(get(`/auth/handoff/start?${q}`, { "cf-connecting-ip": "7.7.7.7" }));
    expect(
      (await handle(get(`/auth/handoff/start?${q}`, { "cf-connecting-ip": "7.7.7.7" }))).status,
    ).toBe(429);
  });

  it("GET continue shows the sign-in page or the confirm page, POST continue mints the code, and redeem works", async () => {
    const auth = handoffAuth();
    const handle = createRouter(auth.config, handoffRoutes(auth.config));
    const { verifier, q } = await challenge();
    const h = await startedId(handle, q);
    const anon = await handle(get(`/auth/handoff/continue?h=${h}`));
    expect(anon.status).toBe(200);
    expect(await anon.text()).toContain(`data-continue="/auth/handoff/continue?h=${h}"`);
    const cookie = await signedIn(auth);
    const confirm = await handle(get(`/auth/handoff/continue?h=${h}`, { cookie }));
    expect(confirm.status).toBe(200);
    // The whole header. A redirect on the schemes list adds nothing to the
    // no-script policy that the password and magic link pages also use.
    expect(confirm.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.example.com consumera:; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(confirm.headers.get("referrer-policy")).toBe("strict-origin");
    const html = await confirm.text();
    expect(html).toContain("Signed in as <strong>ada@example.com</strong>");
    expect(html).toContain("consumera://auth");
    expect(html).toContain(`<input type="hidden" name="h" value="hs_`);
    expect(html).not.toContain("<script");
    // Neither GET minted a code.
    expect(await rows(auth)).toHaveLength(1);
    const res = await handle(formPost(h, { origin: BASE_URL, cookie }));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^consumera:\/\/auth\?code=hc_/);
    const code = new URL(location).searchParams.get("code") ?? "";
    const redeem = await handle(post("/auth/handoff/redeem", { code, verifier }));
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toMatchObject({
      token: expect.stringMatching(/^ts_/),
      user: { email: "ada@example.com" },
      session: { id: expect.any(String) },
    });
    expect(redeem.headers.get("set-cookie")).toBeNull();
    // A second post for the spent id answers an error redirect on appURL.
    const spent = await handle(formPost(h, { origin: BASE_URL, cookie }));
    expect(spent.status).toBe(302);
    expect(spent.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
  });

  it("lists a dev redirect's source in the confirm page's form-action (plan 6c)", async () => {
    const cases = [
      { pattern: DEV, redirect: "exp://192.168.1.20:8081/--/auth", source: "exp:" },
      {
        pattern: /^http:\/\/127\.0\.0\.1:\d+\/auth$/,
        redirect: "http://127.0.0.1:8081/auth",
        source: "http://127.0.0.1:8081",
      },
    ];
    for (const c of cases) {
      const auth = makeAuth({ handoff: { schemes: SCHEMES, devRedirectPattern: c.pattern } });
      const handle = createRouter(auth.config, handoffRoutes(auth.config));
      const { challenge } = await pkce();
      const h = await startedId(
        handle,
        `challenge=${challenge}&redirect=${encodeURIComponent(c.redirect)}`,
      );
      const cookie = await signedIn(auth);
      const confirm = await handle(get(`/auth/handoff/continue?h=${h}`, { cookie }));
      expect(confirm.status).toBe(200);
      expect(confirm.headers.get("content-security-policy")).toBe(
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${APP_ORIGIN} consumera: ${c.source}; base-uri 'none'; frame-ancestors 'none'`,
      );
    }
  });

  it("POST continue accepts the form from baseURL only, and mints nothing without a session", async () => {
    const auth = handoffAuth();
    const handle = createRouter(auth.config, handoffRoutes(auth.config));
    const { q } = await challenge();
    const h = await startedId(handle, q);
    const cookie = await signedIn(auth);
    for (const headers of [
      { origin: APP_ORIGIN, cookie },
      { cookie },
      { origin: BASE_URL, "sec-fetch-site": "cross-site", cookie },
    ]) {
      const res = await handle(formPost(h, headers));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "origin_not_trusted" });
    }
    const anon = await handle(formPost(h, { origin: BASE_URL }));
    expect(anon.status).toBe(200);
    expect(await anon.text()).toContain(`data-continue="/auth/handoff/continue?h=${h}"`);
    const bad = await handle(
      new Request(`${BASE_URL}/auth/handoff/continue`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL, cookie },
        body: "",
      }),
    );
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    // Only the start row exists: no refused or anonymous post wrote a code.
    expect(await rows(auth)).toHaveLength(1);
  });

  it("GET continue redirects to the error URL for an unknown or spent id", async () => {
    const auth = handoffAuth();
    const handle = createRouter(auth.config, handoffRoutes(auth.config));
    const { q } = await challenge();
    const h = await startedId(handle, q);
    const cookie = await signedIn(auth);
    const unknown = await handle(get(`/auth/handoff/continue?h=hs_nope`));
    expect(unknown.status).toBe(302);
    expect(unknown.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    await handle(formPost(h, { origin: BASE_URL, cookie }));
    for (const headers of [{}, { cookie }]) {
      const spent = await handle(get(`/auth/handoff/continue?h=${h}`, headers));
      expect(spent.status).toBe(302);
      expect(spent.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    }
    // The POST follows the same rule, with and without a session: no page for a dead id.
    for (const headers of [{ origin: BASE_URL }, { origin: BASE_URL, cookie }]) {
      const spent = await handle(formPost(h, headers));
      expect(spent.status).toBe(302);
      expect(spent.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
      const unknown = await handle(formPost("hs_nope", headers));
      expect(unknown.status).toBe(302);
      expect(unknown.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    }
  });

  it("POST redeem answers 400 on a bad body and on a wrong code, with no session", async () => {
    const auth = handoffAuth();
    const handle = createRouter(auth.config, handoffRoutes(auth.config));
    expect((await handle(post("/auth/handoff/redeem", { code: "x" }))).status).toBe(400);
    const res = await handle(
      post("/auth/handoff/redeem", { code: "hc_nope", verifier: "v".repeat(43) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("registers no handoff route when handoff is off", async () => {
    const auth = makeAuth();
    const handle = createRouter(auth.config, handoffRoutes(auth.config));
    expect((await handle(get("/auth/handoff/start?challenge=x&redirect=y"))).status).toBe(404);
  });
});
