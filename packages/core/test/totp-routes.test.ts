import { afterEach, describe, expect, it, vi } from "vitest";
import { totpRoutes } from "../src/http/routes/totp.js";
import { base32Decode, totpCode } from "../src/primitives/totp.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post } from "./helpers.js";
import { FAST, proofCookie, pwHandle } from "./password-helpers.js";

const EMAIL = "ada@example.com";
const PW = "correct horse battery";
type Handle = ReturnType<typeof pwHandle>;

/** The `name=value` part of a Set-Cookie value. */
const pair = (cookie: string) => cookie.split(";")[0] ?? "";
const cookieNamed = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? null;

function form(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: APP_ORIGIN,
      ...headers,
    },
    body,
  });
}

async function signedIn(h: Handle, email = EMAIL): Promise<string> {
  const res = await h.auth.handle(post("/auth/password/sign-in", { email, password: PW }));
  const c = cookieNamed(res, "__Host-tempo_session");
  if (!c) throw new Error(`the sign-in answered ${res.status} with no session cookie`);
  return pair(c);
}

/** A verified user with a password, and the session cookie of a sign-in. */
async function verifiedUser(h: Handle, email = EMAIL): Promise<string> {
  const up = await h.auth.handle(post("/auth/password/sign-up", { email, password: PW }));
  const token = h.mails.findLast((m) => m.to === email && m.subject.startsWith("Confirm"))?.token;
  if (!token) throw new Error("no confirm mail");
  // The sign-up's own browser keeps the password (ruling 11 of plan 12q).
  await h.auth.handle(post("/auth/password/verify", { token }, proofCookie(up)));
  return signedIn(h, email);
}

/** The setup and the enable through the routes; then the clock moves one step on. */
async function enrolled(h: Handle, cookie: string) {
  const setup = await h.auth.handle(post("/auth/totp/setup", { password: PW }, { cookie }));
  const body = (await setup.json()) as { secret: string; uri: string; backupCodes: string[] };
  const secret = base32Decode(body.secret);
  const enable = await h.auth.handle(
    post("/auth/totp/enable", { code: await totpCode(secret, h.clock.now()) }, { cookie }),
  );
  if (enable.status !== 200) throw new Error(`the enable answered ${enable.status}`);
  h.clock.advance(30_000);
  return { ...body, bytes: secret, code: () => totpCode(secret, h.clock.now()) };
}

async function challenge(h: Handle, body: Record<string, unknown> = {}): Promise<string> {
  const res = await h.auth.handle(
    post("/auth/password/sign-in", { email: EMAIL, password: PW, ...body }),
  );
  const json = (await res.json()) as { twoFactor?: { challenge: string } };
  if (!json.twoFactor) throw new Error(`the sign-in answered ${res.status} with no challenge`);
  return json.twoFactor.challenge;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the TOTP routes (plan 9f)", () => {
  it("answers 401 on every route that needs a session, with no session and with a tk_ token", async () => {
    const h = pwHandle({ hash: FAST });
    const cookie = await verifiedUser(h);
    const made = await h.auth.handle(post("/auth/tokens", { name: "ci" }, { cookie }));
    const { token } = (await made.json()) as { token: string };
    expect(token).toMatch(/^tk_/);
    const routes: ["GET" | "POST", string][] = [
      ["POST", "/auth/totp/setup"],
      ["POST", "/auth/totp/enable"],
      ["POST", "/auth/totp/disable"],
      ["POST", "/auth/totp/backup-codes"],
      ["GET", "/auth/totp"],
      ["POST", "/auth/totp/devices/revoke"],
    ];
    for (const [method, path] of routes)
      for (const headers of [{}, { authorization: `Bearer ${token}` }]) {
        const req = method === "GET" ? get(path, headers) : post(path, { code: "123456" }, headers);
        expect({ path, status: (await h.auth.handle(req)).status }).toEqual({ path, status: 401 });
      }
  });

  it("sets up, enables, and answers the status; GET /auth/totp answers no secret, no URI, and no backup code, and no log line holds them (Review Focus 5)", async () => {
    const log = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    const h = pwHandle({ hash: FAST });
    const cookie = await verifiedUser(h);
    const enrolledAt = h.clock.now();
    const f = await enrolled(h, cookie);
    expect(f.uri.startsWith("otpauth://totp/api.example.com:ada%40example.com?secret=")).toBe(true);
    expect(f.backupCodes).toHaveLength(10);
    const res = await h.auth.handle(get("/auth/totp", { cookie }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      enabled: true,
      enabledAt: enrolledAt.toISOString(),
      backupCodesLeft: 10,
      trustedDevices: 0,
      methods: ["totp"],
      backupCodesVersion: 2,
    });
    const logged = JSON.stringify(log.map((s) => s.mock.calls));
    for (const secret of [f.secret, f.uri, ...f.backupCodes]) {
      expect(text).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    expect(text).not.toContain("otpauth");
  });

  it("takes the password at the setup: a wrong one answers 401 invalid_credentials and writes no row, none answers 400 invalid_body (review I-1)", async () => {
    const h = pwHandle({ hash: FAST });
    const cookie = await verifiedUser(h);
    const wrong = await h.auth.handle(
      post("/auth/totp/setup", { password: "not the password" }, { cookie }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: "invalid_credentials" });
    const none = await h.auth.handle(post("/auth/totp/setup", {}, { cookie }));
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: "invalid_body" });
    expect(await h.storage.findMany("totp", [])).toEqual([]);
    const right = await h.auth.handle(post("/auth/totp/setup", { password: PW }, { cookie }));
    expect(right.status).toBe(200);
    expect(await h.storage.findMany("totp", [])).toHaveLength(1);
  });

  it("enable ends the other session: its next GET /session answers 401 (Review Focus 4)", async () => {
    const h = pwHandle({ hash: FAST });
    const mine = await verifiedUser(h);
    const thief = await signedIn(h);
    await enrolled(h, mine);
    expect((await h.auth.handle(get("/auth/session", { cookie: thief }))).status).toBe(401);
    expect((await h.auth.handle(get("/auth/session", { cookie: mine }))).status).toBe(200);
  });

  it("answers a challenge with no cookie; the JSON verify sets the session cookie and the trust cookie; the next sign-in with the trust cookie opens a session", async () => {
    const h = pwHandle({ hash: FAST });
    const f = await enrolled(h, await verifiedUser(h));
    const signIn = await h.auth.handle(
      post("/auth/password/sign-in", { email: EMAIL, password: PW }),
    );
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("set-cookie")).toBeNull();
    const body = (await signIn.json()) as {
      twoFactor: { challenge: string; expiresAt: string; methods: string[] };
    };
    expect(body.twoFactor.methods).toEqual(["totp", "backup"]);
    expect(body.twoFactor.expiresAt).toBe(
      new Date(h.clock.now().getTime() + 300_000).toISOString(),
    );
    const verify = await h.auth.handle(
      post("/auth/totp/verify", {
        challenge: body.twoFactor.challenge,
        code: await f.code(),
        trustDevice: true,
      }),
    );
    expect(verify.status).toBe(200);
    const v = (await verify.json()) as {
      token: string;
      user: { email: string };
      next: string;
      backupCodesLeft: number;
      trustDevice: { token: string; expiresAt: string };
    };
    expect(v).toMatchObject({ user: { email: EMAIL }, next: "/", backupCodesLeft: 10 });
    expect(cookieNamed(verify, "__Host-tempo_session")).toBe(
      `__Host-tempo_session=${v.token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(cookieNamed(verify, "tempo_totp_trust")).toBe(
      `tempo_totp_trust=${v.trustDevice.token}; Path=/auth/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    );
    const again = await h.auth.handle(
      post(
        "/auth/password/sign-in",
        { email: EMAIL, password: PW },
        { cookie: `tempo_totp_trust=${v.trustDevice.token}` },
      ),
    );
    expect(cookieNamed(again, "__Host-tempo_session")).not.toBeNull();
    // A native app sends the token in the body.
    const native = await h.auth.handle(
      post("/auth/password/sign-in", {
        email: EMAIL,
        password: PW,
        trustDevice: v.trustDevice.token,
      }),
    );
    expect(((await native.json()) as { token?: string }).token).toMatch(/^ts_/);
    // The body's token wins over the cookie, and an empty body value falls back to the cookie.
    const other = await h.auth.handle(
      post(
        "/auth/password/sign-in",
        { email: EMAIL, password: PW, trustDevice: `td_${"x".repeat(43)}` },
        { cookie: `tempo_totp_trust=${v.trustDevice.token}` },
      ),
    );
    expect(((await other.json()) as { twoFactor?: unknown }).twoFactor).toBeDefined();
    const empty = await h.auth.handle(
      post(
        "/auth/password/sign-in",
        { email: EMAIL, password: PW, trustDevice: "" },
        { cookie: `tempo_totp_trust=${v.trustDevice.token}` },
      ),
    );
    expect(((await empty.json()) as { token?: string }).token).toMatch(/^ts_/);
  });

  it("serves the challenge page with no script; a wrong code returns to it with the error; a right code redirects to next with both cookies", async () => {
    const h = pwHandle({ hash: FAST });
    const f = await enrolled(h, await verifiedUser(h));
    const c = await challenge(h, { next: "/inbox" });
    const page = await h.auth.handle(get(`/auth/totp/challenge?challenge=${c}`));
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    const html = await page.text();
    expect(html).toContain('<form method="post" action="/auth/totp/challenge">');
    expect(html).toContain(`<input type="hidden" name="challenge" value="${c}">`);
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).not.toContain("<script");
    const backup = await (
      await h.auth.handle(get(`/auth/totp/challenge?challenge=${c}&backup=1`))
    ).text();
    expect(backup).toContain('name="backupCode"');
    const bad = await h.auth.handle(get("/auth/totp/challenge?challenge=tf_bad"));
    expect(bad.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    const right = await f.code();
    // Derived from the right code, so it is always wrong.
    const wrongCode = right === "000000" ? "111111" : "000000";
    const wrong = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&code=${wrongCode}`),
    );
    expect(wrong.status).toBe(302);
    expect(wrong.headers.get("location")).toBe(
      `${BASE_URL}/auth/totp/challenge?challenge=${c}&error=invalid_code`,
    );
    const shown = await (
      await h.auth.handle(get(`/auth/totp/challenge?challenge=${c}&error=invalid_code`))
    ).text();
    expect(shown).toContain("The code is not correct. Try again.");
    // A wrong backup code returns to the backup form.
    const wrongBackup = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&backupCode=not-a-code`),
    );
    expect(wrongBackup.status).toBe(302);
    expect(wrongBackup.headers.get("location")).toBe(
      `${BASE_URL}/auth/totp/challenge?challenge=${c}&backup=1&error=invalid_code`,
    );
    // A foreign Origin is refused before the code check.
    const foreign = await h.auth.handle(
      new Request(`${BASE_URL}/auth/totp/challenge`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
        },
        body: `challenge=${c}&code=${right}`,
      }),
    );
    expect(foreign.status).toBe(403);
    expect(cookieNamed(foreign, "__Host-tempo_session")).toBeNull();
    const done = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&code=${right}&trustDevice=1`),
    );
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${BASE_URL}/inbox`);
    expect(cookieNamed(done, "__Host-tempo_session")).not.toBeNull();
    expect(cookieNamed(done, "tempo_totp_trust")).not.toBeNull();
  });

  it("disables with a code and clears the trust cookie; regenerates the backup codes; revokes the trusted devices", async () => {
    const h = pwHandle({ hash: FAST });
    const cookie = await verifiedUser(h);
    const f = await enrolled(h, cookie);
    const codes = await h.auth.handle(
      post("/auth/totp/backup-codes", { code: await f.code() }, { cookie }),
    );
    const fresh = ((await codes.json()) as { backupCodes: string[] }).backupCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(f.backupCodes[0]);
    const trusted = await h.auth.handle(
      post("/auth/totp/verify", {
        challenge: await challenge(h),
        backupCode: fresh[0],
        trustDevice: true,
      }),
    );
    expect(((await trusted.json()) as { backupCodesLeft: number }).backupCodesLeft).toBe(9);
    const revoke = await h.auth.handle(post("/auth/totp/devices/revoke", {}, { cookie }));
    expect(await revoke.json()).toEqual({ ok: true });
    expect(cookieNamed(revoke, "tempo_totp_trust")).toBe(
      "tempo_totp_trust=; Path=/auth/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
    expect(await h.storage.findMany("trustedDevice", [])).toEqual([]);
    h.clock.advance(30_000);
    const off = await h.auth.handle(
      post("/auth/totp/disable", { code: await f.code() }, { cookie }),
    );
    expect(await off.json()).toEqual({ ok: true });
    expect(cookieNamed(off, "tempo_totp_trust")).not.toBeNull();
    expect(await h.storage.findMany("totp", [])).toEqual([]);
  });

  it("answers the challenge with no Set-Cookie and runs no session hook; the verify runs them once (plan 9f)", async () => {
    const vias: string[] = [];
    const h = pwHandle(
      { hash: FAST },
      {
        hooks: {
          session: {
            beforeCreate(e) {
              vias.push(e.via);
            },
            afterCreate(e) {
              vias.push(`after:${e.via}`);
            },
          },
        },
      },
    );
    const f = await enrolled(h, await verifiedUser(h));
    vias.length = 0;
    const signIn = await h.auth.handle(
      post("/auth/password/sign-in", { email: EMAIL, password: PW }),
    );
    expect(signIn.status).toBe(200);
    expect(signIn.headers.getSetCookie()).toEqual([]);
    const c = ((await signIn.json()) as { twoFactor: { challenge: string } }).twoFactor.challenge;
    expect(vias).toEqual([]);
    const verify = await h.auth.handle(
      post("/auth/totp/verify", { challenge: c, code: await f.code() }),
    );
    expect(verify.status).toBe(200);
    expect(vias).toEqual(["password", "after:password"]);
  });

  it("answers 404 on every TOTP route with totp: false, and api.totp is absent", async () => {
    const h = pwHandle({ hash: FAST }, { totp: false });
    const cookie = await verifiedUser(h);
    const routes = [
      post("/auth/totp/setup", { password: PW }, { cookie }),
      post("/auth/totp/enable", { code: "123456" }, { cookie }),
      post("/auth/totp/disable", { code: "123456" }, { cookie }),
      post("/auth/totp/backup-codes", { code: "123456" }, { cookie }),
      get("/auth/totp", { cookie }),
      post("/auth/totp/devices/revoke", {}, { cookie }),
      post("/auth/totp/verify", { challenge: "tf_x", code: "123456" }),
      get("/auth/totp/challenge?challenge=tf_x"),
      form("/auth/totp/challenge", "challenge=tf_x&code=123456"),
    ];
    for (const req of routes) {
      const path = new URL(req.url).pathname;
      expect({ path, status: (await h.auth.handle(req)).status }).toEqual({ path, status: 404 });
    }
    // One request per route of `totpRoutes`: a new route that is not in this list fails here.
    expect(routes).toHaveLength(totpRoutes(makeAuth({ password: { hash: FAST } }).config).length);
    // The sign-in's gate is off too: the sign-in answers a session.
    const signIn = await h.auth.handle(
      post("/auth/password/sign-in", { email: EMAIL, password: PW }),
    );
    expect(cookieNamed(signIn, "__Host-tempo_session")).not.toBeNull();
    expect(h.auth.api.totp).toBeUndefined();
    expect(pwHandle({ hash: FAST }).auth.api.totp).toBeDefined();
  });
});

describe("the reset gate on the routes (plan 12c)", () => {
  /** A reset link from the mail, after the route's request. */
  async function resetToken(h: Handle): Promise<string> {
    await h.auth.handle(post("/auth/password/reset/request", { email: EMAIL, next: "/after" }));
    const token = h.mails.findLast((m) => m.to === EMAIL && m.subject.startsWith("Reset"))?.token;
    if (!token) throw new Error("no reset link");
    return token;
  }

  it("answers the form with 302 to the challenge page and no session cookie", async () => {
    const h = pwHandle({ hash: FAST });
    await enrolled(h, await verifiedUser(h));
    const token = await resetToken(h);
    const res = await h.auth.handle(
      form("/auth/password/reset", `token=${token}&password=a+brand+new+long+password`),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${BASE_URL}/auth/totp/challenge`);
    expect(location.searchParams.get("challenge")).toMatch(/^tf_/);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers JSON with 200 and the challenge, and no cookie", async () => {
    const h = pwHandle({ hash: FAST });
    await enrolled(h, await verifiedUser(h));
    const token = await resetToken(h);
    const res = await h.auth.handle(
      post("/auth/password/reset", { token, password: "a brand new long password" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { twoFactor: { challenge: string; methods: string[] } };
    expect(body.twoFactor.challenge).toMatch(/^tf_/);
    expect(body.twoFactor.methods).toEqual(["totp", "backup"]);
  });

  it("opens the session for the form on a device with the trust cookie, and lands on next", async () => {
    const h = pwHandle({ hash: FAST });
    const f = await enrolled(h, await verifiedUser(h));
    const verify = await h.auth.handle(
      post("/auth/totp/verify", {
        challenge: await challenge(h),
        code: await f.code(),
        trustDevice: true,
      }),
    );
    const trust = cookieNamed(verify, "tempo_totp_trust");
    if (!trust) throw new Error("no trust cookie");
    const token = await resetToken(h);
    const res = await h.auth.handle(
      form("/auth/password/reset", `token=${token}&password=a+brand+new+long+password`, {
        cookie: pair(trust),
      }),
    );
    expect(res.status).toBe(302);
    // appURL is baseURL in this test config, so `next` lands on the API origin.
    expect(res.headers.get("location")).toBe(`${BASE_URL}/after`);
    expect(cookieNamed(res, "__Host-tempo_session")).toMatch(/^__Host-tempo_session=ts_/);
  });
});

describe("the gated sign-ins on the routes (plan 12c)", () => {
  async function magicToken(h: Handle): Promise<string> {
    await h.auth.handle(post("/auth/magic-link/request", { email: EMAIL, next: "/inbox" }));
    const token = h.mails.findLast((m) => m.to === EMAIL && m.subject.startsWith("Sign in"))?.token;
    if (!token) throw new Error("no magic link");
    return token;
  }

  it("answers the magic link form with 302 to the challenge page and no cookie, and JSON with the challenge", async () => {
    const h = pwHandle({ hash: FAST });
    await enrolled(h, await verifiedUser(h));
    const res = await h.auth.handle(
      form("/auth/magic-link/verify", `token=${await magicToken(h)}`),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      new RegExp(`^${BASE_URL}/auth/totp/challenge\\?challenge=tf_`),
    );
    expect(res.headers.get("set-cookie")).toBeNull();
    const json = await h.auth.handle(
      post("/auth/magic-link/verify", { token: await magicToken(h) }),
    );
    expect(json.status).toBe(200);
    expect(json.headers.get("set-cookie")).toBeNull();
    expect(((await json.json()) as { twoFactor: { methods: string[] } }).twoFactor.methods).toEqual(
      ["totp", "backup"],
    );
  });

  it("answers the email code verify with the challenge and no cookie", async () => {
    const h = pwHandle({ hash: FAST });
    await enrolled(h, await verifiedUser(h));
    await h.auth.handle(post("/auth/otp/request", { email: EMAIL }));
    const code = /\b(\d{6})\b/.exec(h.mails.at(-1)?.text ?? "")?.[1] ?? "";
    const res = await h.auth.handle(post("/auth/otp/verify", { email: EMAIL, code }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(((await res.json()) as { twoFactor?: unknown }).twoFactor).toBeDefined();
  });

  /** A trusted device through the routes: the `name=value` of the trust cookie and the clear token of the body. */
  async function trusted(h: Handle): Promise<{ cookie: string; token: string }> {
    const f = await enrolled(h, await verifiedUser(h));
    const verify = await h.auth.handle(
      post("/auth/totp/verify", {
        challenge: await challenge(h),
        code: await f.code(),
        trustDevice: true,
      }),
    );
    const trust = cookieNamed(verify, "tempo_totp_trust");
    const body = (await verify.json()) as { trustDevice?: { token: string } };
    if (!trust || !body.trustDevice) throw new Error("no trust token");
    return { cookie: pair(trust), token: body.trustDevice.token };
  }

  it("opens the magic link session on a trusted device: the form with the trust cookie, JSON with the body token", async () => {
    const h = pwHandle({ hash: FAST });
    const t = await trusted(h);
    const res = await h.auth.handle(
      form("/auth/magic-link/verify", `token=${await magicToken(h)}`, { cookie: t.cookie }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/inbox`);
    expect(cookieNamed(res, "__Host-tempo_session")).toMatch(/^__Host-tempo_session=ts_/);
    const json = await h.auth.handle(
      post("/auth/magic-link/verify", { token: await magicToken(h), trustDevice: t.token }),
    );
    expect(json.status).toBe(200);
    expect(cookieNamed(json, "__Host-tempo_session")).toMatch(/^__Host-tempo_session=ts_/);
  });

  it("opens the email code session on a trusted device: the body token, and the trust cookie", async () => {
    const h = pwHandle({ hash: FAST });
    const t = await trusted(h);
    const codeOf = async () => {
      await h.auth.handle(post("/auth/otp/request", { email: EMAIL }));
      return /\b(\d{6})\b/.exec(h.mails.at(-1)?.text ?? "")?.[1] ?? "";
    };
    const body = await h.auth.handle(
      post("/auth/otp/verify", { email: EMAIL, code: await codeOf(), trustDevice: t.token }),
    );
    expect(body.status).toBe(200);
    expect(cookieNamed(body, "__Host-tempo_session")).toMatch(/^__Host-tempo_session=ts_/);
    const cookie = await h.auth.handle(
      post("/auth/otp/verify", { email: EMAIL, code: await codeOf() }, { cookie: t.cookie }),
    );
    expect(cookie.status).toBe(200);
    expect(cookieNamed(cookie, "__Host-tempo_session")).toMatch(/^__Host-tempo_session=ts_/);
  });
});

describe("the challenge page (plan 12c)", () => {
  it("answers the error URL for a well-formed challenge that does not exist", async () => {
    const h = pwHandle({ hash: FAST });
    const unknown = `tf_${"a".repeat(43)}`;
    const res = await h.auth.handle(get(`/auth/totp/challenge?challenge=${unknown}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
  });

  it("shows the trusted-device button to a device with the trust cookie, and the button opens the session with no code", async () => {
    const h = pwHandle({ hash: FAST });
    const f = await enrolled(h, await verifiedUser(h));
    const verify = await h.auth.handle(
      post("/auth/totp/verify", {
        challenge: await challenge(h),
        code: await f.code(),
        trustDevice: true,
      }),
    );
    const trust = pair(cookieNamed(verify, "tempo_totp_trust") ?? "");
    // A challenge as a social sign-in from Apple leaves it: the form post carried no Lax cookie.
    const c = await challenge(h, { next: "/inbox" });
    const page = await (
      await h.auth.handle(get(`/auth/totp/challenge?challenge=${c}`, { cookie: trust }))
    ).text();
    expect(page).toContain("Continue on this trusted device");
    const plain = await (await h.auth.handle(get(`/auth/totp/challenge?challenge=${c}`))).text();
    expect(plain).not.toContain("Continue on this trusted device");
    // A well-formed token with no row is no trust: the page reads the row, not the cookie's presence.
    const forged = await (
      await h.auth.handle(
        get(`/auth/totp/challenge?challenge=${c}`, {
          cookie: `tempo_totp_trust=td_${"a".repeat(43)}`,
        }),
      )
    ).text();
    expect(forged).not.toContain("Continue on this trusted device");
    // The post reads the row too: a forged token opens no session, and the challenge still lives.
    const forgedPost = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&action=trusted`, {
        cookie: `tempo_totp_trust=td_${"a".repeat(43)}`,
      }),
    );
    expect(forgedPost.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    const done = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&action=trusted`, { cookie: trust }),
    );
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${BASE_URL}/inbox`);
    expect(cookieNamed(done, "__Host-tempo_session")).not.toBeNull();
    const none = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${await challenge(h)}&action=trusted`),
    );
    expect(none.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
  });

  it("moves lastSeenAt of the trust row when the trusted button opens the session (plan 12c final review, ruling e)", async () => {
    const h = pwHandle({ hash: FAST });
    const f = await enrolled(h, await verifiedUser(h));
    const verify = await h.auth.handle(
      post("/auth/totp/verify", {
        challenge: await challenge(h),
        code: await f.code(),
        trustDevice: true,
      }),
    );
    const trust = pair(cookieNamed(verify, "tempo_totp_trust") ?? "");
    const c = await challenge(h);
    h.clock.advance(60_000);
    const done = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&action=trusted`, { cookie: trust }),
    );
    expect(cookieNamed(done, "__Host-tempo_session")).not.toBeNull();
    const rows = await h.storage.findMany("trustedDevice", []);
    expect(rows.map((r) => r.lastSeenAt)).toEqual([h.clock.now()]);
  });

  it("sends an email code from the page, shows its form, and a wrong email code returns to it", async () => {
    const h = pwHandle({ hash: FAST });
    const cookie = await verifiedUser(h);
    await enrolled(h, cookie);
    const on = await h.auth.handle(
      post("/auth/second-factor/email/enable", { password: PW }, { cookie }),
    );
    expect(on.status).toBe(200);
    const c = await challenge(h, { next: "/inbox" });
    const sent = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&action=send-email`),
    );
    expect(sent.headers.get("location")).toBe(
      `${BASE_URL}/auth/totp/challenge?challenge=${c}&method=email`,
    );
    const page = await (
      await h.auth.handle(get(`/auth/totp/challenge?challenge=${c}&method=email`))
    ).text();
    expect(page).toContain('name="emailCode"');
    const code = /\b(\d{6})\b/.exec(h.mails.at(-1)?.text ?? "")?.[1] ?? "";
    const wrongCode = code === "000000" ? "111111" : "000000";
    const wrong = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&emailCode=${wrongCode}`),
    );
    expect(wrong.headers.get("location")).toBe(
      `${BASE_URL}/auth/totp/challenge?challenge=${c}&method=email&error=invalid_code`,
    );
    const done = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&emailCode=${code}`),
    );
    expect(done.headers.get("location")).toBe(`${BASE_URL}/inbox`);
  });

  it("refuses another user's trust cookie and an expired one on the trusted button", async () => {
    const h = pwHandle({ hash: FAST });
    await enrolled(h, await verifiedUser(h));
    const bea = "bea@example.com";
    const fb = await enrolled(h, await verifiedUser(h, bea));
    const sb = await h.auth.handle(post("/auth/password/sign-in", { email: bea, password: PW }));
    const cb = ((await sb.json()) as { twoFactor: { challenge: string } }).twoFactor.challenge;
    const vb = await h.auth.handle(
      post("/auth/totp/verify", { challenge: cb, code: await fb.code(), trustDevice: true }),
    );
    const beaTrust = pair(cookieNamed(vb, "tempo_totp_trust") ?? "");
    expect(beaTrust).toMatch(/^tempo_totp_trust=td_/);
    // Bea's live trust row is no trust for Ann's challenge: on the page and on the post.
    const c = await challenge(h);
    const page = await (
      await h.auth.handle(get(`/auth/totp/challenge?challenge=${c}`, { cookie: beaTrust }))
    ).text();
    expect(page).not.toContain("Continue on this trusted device");
    const other = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&action=trusted`, { cookie: beaTrust }),
    );
    expect(other.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    // After the trust days, Bea's own row is no trust.
    h.clock.advance(31 * 86_400_000);
    const sb2 = await h.auth.handle(post("/auth/password/sign-in", { email: bea, password: PW }));
    const cb2 =
      ((await sb2.json()) as { twoFactor?: { challenge: string } }).twoFactor?.challenge ?? "";
    expect(cb2).toMatch(/^tf_/);
    const page2 = await (
      await h.auth.handle(get(`/auth/totp/challenge?challenge=${cb2}`, { cookie: beaTrust }))
    ).text();
    expect(page2).not.toContain("Continue on this trusted device");
    const old = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${cb2}&action=trusted`, { cookie: beaTrust }),
    );
    expect(old.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
  });

  it("writes nothing on the page GET (deviation 11)", async () => {
    const h = pwHandle({ hash: FAST });
    const f = await enrolled(h, await verifiedUser(h));
    const verify = await h.auth.handle(
      post("/auth/totp/verify", {
        challenge: await challenge(h),
        code: await f.code(),
        trustDevice: true,
      }),
    );
    const trust = pair(cookieNamed(verify, "tempo_totp_trust") ?? "");
    const c = await challenge(h);
    const writes = (["create", "update", "delete", "transaction"] as const).map((m) =>
      vi.spyOn(h.storage, m),
    );
    for (const q of ["", "&method=email", "&backup=1"]) {
      const res = await h.auth.handle(
        get(`/auth/totp/challenge?challenge=${c}${q}`, { cookie: trust }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Continue on this trusted device");
    }
    for (const w of writes) expect(w).not.toHaveBeenCalled();
  });

  it("serves no email form for a challenge that offers no email code (a magic link)", async () => {
    const h = pwHandle({ hash: FAST });
    const cookie = await verifiedUser(h);
    await enrolled(h, cookie);
    const on = await h.auth.handle(
      post("/auth/second-factor/email/enable", { password: PW }, { cookie }),
    );
    expect(on.status).toBe(200);
    await h.auth.handle(post("/auth/magic-link/request", { email: EMAIL }));
    const token = h.mails.findLast((m) => m.subject.startsWith("Sign in"))?.token ?? "";
    const gated = await h.auth.handle(form("/auth/magic-link/verify", `token=${token}`));
    const c = new URL(gated.headers.get("location") ?? "").searchParams.get("challenge") ?? "";
    expect(c).toMatch(/^tf_/);
    const page = await (
      await h.auth.handle(get(`/auth/totp/challenge?challenge=${c}&method=email`))
    ).text();
    expect(page).toContain('name="code"');
    expect(page).not.toContain('name="emailCode"');
    expect(page).not.toContain("Send a code to my email");
    expect(page).not.toContain("method=email");
    // The send button of a page with no email method is refused, and no mail goes.
    const mails = h.mails.length;
    const sent = await h.auth.handle(
      form("/auth/totp/challenge", `challenge=${c}&action=send-email`),
    );
    expect(sent.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_body`);
    expect(h.mails.length).toBe(mails);
  });

  it("refuses a fourth send of one challenge on the page and sends no mail", async () => {
    const h = pwHandle({ hash: FAST });
    const cookie = await verifiedUser(h);
    await enrolled(h, cookie);
    await h.auth.handle(post("/auth/second-factor/email/enable", { password: PW }, { cookie }));
    const c = await challenge(h);
    const send = () =>
      h.auth.handle(form("/auth/totp/challenge", `challenge=${c}&action=send-email`));
    for (let i = 0; i < 3; i++)
      expect((await send()).headers.get("location")).toBe(
        `${BASE_URL}/auth/totp/challenge?challenge=${c}&method=email`,
      );
    const mails = h.mails.length;
    expect((await send()).headers.get("location")).toBe(`${BASE_URL}/?auth_error=rate_limited`);
    expect(h.mails.length).toBe(mails);
  });
});
