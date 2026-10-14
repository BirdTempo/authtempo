import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { requestEmailOtp, verifyEmailOtp } from "../src/engine/email-otp.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { passwordSignIn } from "../src/engine/password.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { verifyTwoFactor } from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { socialRoutes } from "../src/http/routes/social.js";
import { BASE_URL, get, tokenFromMail } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { type FakeIdToken, fakeJwt, GOOGLE, socialAuth } from "./social-helpers.js";
import { type Auth, codeNow, EMAIL, enrolled, PASSWORD, totpAuth } from "./totp-helpers.js";

/**
 * Session hooks that record the `via` of each session hook call: `before`
 * for `beforeCreate`, `vias` for `afterCreate`. A gated sign-in runs neither.
 */
function recorder() {
  const vias: string[] = [];
  const before: string[] = [];
  const hooks: AuthConfig["hooks"] = {
    session: {
      beforeCreate: (e) => {
        before.push(e.via);
      },
      afterCreate: (e) => {
        vias.push(e.via);
      },
    },
  };
  /** Empties both lists, for example after the sign-ins of `enrolled`. */
  const clear = () => {
    vias.length = 0;
    before.length = 0;
  };
  return { hooks, vias, before, clear };
}

/** A test auth with the second factor on that records the session hooks. */
function recording(extra: Partial<AuthConfig> = {}) {
  const r = recorder();
  return { auth: totpAuth({ hooks: r.hooks, ...extra }), ...r };
}

/** A trust token of `email` from a password sign-in and a verify with `trustDevice`. */
async function trustOf(auth: Auth, secret: Uint8Array, email = EMAIL): Promise<string> {
  const s = await passwordSignIn(auth.config, {
    email,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!s.ok || !("twoFactor" in s.value)) throw new Error("no challenge");
  const v = await verifyTwoFactor(auth.config, {
    challenge: s.value.twoFactor.challenge,
    code: await codeNow(auth, secret),
    trustDevice: true,
    ip: null,
  });
  if (!v.ok || !v.value.trustDevice) throw new Error("no trust token");
  return v.value.trustDevice.token;
}

/** The `lastSeenAt` of the one trust row. */
async function lastSeen(auth: Auth): Promise<Date | undefined> {
  const [device] = await auth.storage.findMany("trustedDevice", []);
  return device?.lastSeenAt;
}

async function magicLink(auth: Auth, trustDevice?: string) {
  await requestMagicLink(auth.config, { email: EMAIL, next: "/inbox", ip: null });
  return verifyMagicLink(auth.config, {
    token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
    ip: "5.5.5.5",
    userAgent: "Agent/5",
    ...(trustDevice !== undefined ? { trustDevice } : {}),
  });
}

async function emailCode(auth: Auth, trustDevice?: string) {
  await requestEmailOtp(auth.config, { email: EMAIL, ip: null });
  const code = /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
  return verifyEmailOtp(auth.config, {
    email: EMAIL,
    code,
    ip: null,
    userAgent: null,
    ...(trustDevice !== undefined ? { trustDevice } : {}),
  });
}

/** A Google sign-in of EMAIL through the engine; `fakeJwt` reads `tokens` at each verify. */
async function google(
  auth: ReturnType<typeof socialAuth>,
  tokens: Record<string, FakeIdToken>,
  trustDevice?: string,
) {
  const start = await startSocial(auth.config, { provider: "google", next: "/home", ip: null });
  if (!start.ok) throw new Error(start.code);
  const url = new URL(start.value.location);
  tokens["idtok-default"] = {
    audience: GOOGLE.clientId,
    issuer: "https://accounts.google.com",
    claims: {
      sub: "g-1",
      email: EMAIL,
      email_verified: true,
      name: "Ada",
      nonce: url.searchParams.get("nonce") ?? "",
    },
  };
  return completeSocial(auth.config, {
    provider: "google",
    state: url.searchParams.get("state"),
    code: "c1",
    error: null,
    bindToken: start.value.bindToken,
    ip: null,
    userAgent: null,
    ...(trustDevice !== undefined ? { trustDevice } : {}),
  });
}

const sessionsOf = (auth: Auth, userId: string) =>
  auth.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }]);

describe("the gate on the magic link (plan 12c)", () => {
  it("answers a challenge with no email method, opens no session, and the verify opens it with via magic_link", async () => {
    const { auth, vias, before: hooked, clear } = recording();
    const { user, secret } = await enrolled(auth);
    const before = (await sessionsOf(auth, user.id)).length;
    clear();
    const r = await magicLink(auth);
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("the magic link answered no challenge");
    expect(r.value.next).toBe("/inbox");
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    expect((await sessionsOf(auth, user.id)).length).toBe(before);
    expect(vias).toEqual([]);
    // The session hook runs only for a session that opens (plan 9d).
    expect(hooked).toEqual([]);
    const v = await verifyTwoFactor(auth.config, {
      challenge: r.value.twoFactor.challenge,
      code: await codeNow(auth, secret),
      ip: null,
    });
    expect(v).toMatchObject({ ok: true, value: { next: "/inbox" } });
    expect(vias).toEqual(["magic_link"]);
  });

  it("opens a session on a trusted device and moves its lastSeenAt", async () => {
    const auth = totpAuth();
    const { secret } = await enrolled(auth);
    const first = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    const v = await verifyTwoFactor(auth.config, {
      challenge: first.value.twoFactor.challenge,
      code: await codeNow(auth, secret),
      trustDevice: true,
      ip: null,
    });
    if (!v.ok || !v.value.trustDevice) throw new Error("no trust token");
    auth.clock.advance(60_000);
    const r = await magicLink(auth, v.value.trustDevice.token);
    expect(r.ok && "token" in r.value).toBe(true);
    const [device] = await auth.storage.findMany("trustedDevice", []);
    expect(device?.lastSeenAt).toEqual(auth.clock.now());
  });

  it("opens a session with totp.gate.magicLink false, and for a user with the factor off", async () => {
    const off = totpAuth({ totp: { gate: { magicLink: false } } });
    await enrolled(off);
    const r = await magicLink(off);
    expect(r.ok && "token" in r.value).toBe(true);
    const plain = totpAuth();
    await plain.seedUser(EMAIL);
    const s = await magicLink(plain);
    expect(s.ok && "token" in s.value).toBe(true);
  });
});

describe("the gate on the email code sign-in (plan 12c)", () => {
  it("answers a challenge with no email method, and opens a session with totp.gate.emailOtp false", async () => {
    const { auth, vias, before: hooked, clear } = recording();
    const { user, secret } = await enrolled(auth);
    const before = (await sessionsOf(auth, user.id)).length;
    clear();
    const r = await emailCode(auth);
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("the code answered no challenge");
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    expect((await sessionsOf(auth, user.id)).length).toBe(before);
    expect(vias).toEqual([]);
    expect(hooked).toEqual([]);
    // The verify opens the session with the code's `via`, and the code's landing path.
    const v = await verifyTwoFactor(auth.config, {
      challenge: r.value.twoFactor.challenge,
      code: await codeNow(auth, secret),
      ip: null,
    });
    expect(v).toMatchObject({ ok: true, value: { next: "/" } });
    expect(vias).toEqual(["email_otp"]);
    const off = totpAuth({ totp: { gate: { emailOtp: false } } });
    await enrolled(off);
    const s = await emailCode(off);
    expect(s.ok && "token" in s.value).toBe(true);
  });

  it("opens a session on a trusted device and moves its lastSeenAt", async () => {
    const auth = totpAuth();
    const { user, secret } = await enrolled(auth);
    const token = await trustOf(auth, secret);
    auth.clock.advance(60_000);
    const before = (await sessionsOf(auth, user.id)).length;
    const r = await emailCode(auth, token);
    expect(r.ok && "token" in r.value).toBe(true);
    expect(await sessionsOf(auth, user.id)).toHaveLength(before + 1);
    expect(await lastSeen(auth)).toEqual(auth.clock.now());
  });
});

describe("the gate on social (plan 12c)", () => {
  it("links the identity, answers a challenge with no email method, and opens no session", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const { hooks, vias, before: hooked, clear } = recorder();
    const auth = socialAuth({ password: { hash: FAST }, hooks }, fakeJwt(tokens));
    const { user, secret } = await enrolled(auth);
    const before = (await sessionsOf(auth, user.id)).length;
    clear();
    const r = await google(auth, tokens);
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("social answered no challenge");
    expect(r.value.next).toBe("/home");
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    expect((await sessionsOf(auth, user.id)).length).toBe(before);
    expect(vias).toEqual([]);
    expect(hooked).toEqual([]);
    // The link commits with the challenge (spec 9): the link alone opens nothing.
    expect(
      await auth.storage.findOne("identity", [{ field: "provider", op: "eq", value: "google" }]),
    ).toMatchObject({ userId: user.id, subject: "g-1" });
    // The verify opens the session with `via: "social"` and the row's landing path.
    const v = await verifyTwoFactor(auth.config, {
      challenge: r.value.twoFactor.challenge,
      code: await codeNow(auth, secret),
      ip: null,
    });
    expect(v).toMatchObject({ ok: true, value: { next: "/home" } });
    expect(vias).toEqual(["social"]);
  });

  it("opens a session on a trusted device and moves its lastSeenAt", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({ password: { hash: FAST } }, fakeJwt(tokens));
    const { user, secret } = await enrolled(auth);
    const token = await trustOf(auth, secret);
    auth.clock.advance(60_000);
    const before = (await sessionsOf(auth, user.id)).length;
    const r = await google(auth, tokens, token);
    expect(r.ok && "token" in r.value).toBe(true);
    expect(await sessionsOf(auth, user.id)).toHaveLength(before + 1);
    expect(await lastSeen(auth)).toEqual(auth.clock.now());
  });

  it("opens a session with totp.gate.social false", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth(
      { password: { hash: FAST }, totp: { gate: { social: false } } },
      fakeJwt(tokens),
    );
    await enrolled(auth);
    const r = await google(auth, tokens);
    expect(r.ok && "token" in r.value).toBe(true);
  });
});

describe("the trust token at the gates (plan 12c)", () => {
  it("answers the challenge for another user's trust token, at the magic link, the email code, and social", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({ password: { hash: FAST } }, fakeJwt(tokens));
    const { user } = await enrolled(auth);
    const other = await enrolled(auth, "eve@example.com");
    const token = await trustOf(auth, other.secret, "eve@example.com");
    const before = (await sessionsOf(auth, user.id)).length;
    const ml = await magicLink(auth, token);
    expect(ml.ok && "twoFactor" in ml.value).toBe(true);
    const code = await emailCode(auth, token);
    expect(code.ok && "twoFactor" in code.value).toBe(true);
    const social = await google(auth, tokens, token);
    expect(social.ok && "twoFactor" in social.value).toBe(true);
    expect(await sessionsOf(auth, user.id)).toHaveLength(before);
  });

  it("answers the challenge for an expired trust token at the magic link", async () => {
    const auth = totpAuth();
    const { user, secret } = await enrolled(auth);
    const token = await trustOf(auth, secret);
    const days = auth.config.totp?.trustDays;
    if (days === undefined) throw new Error("no totp config");
    auth.clock.advance(days * 86_400_000 + 1);
    const before = (await sessionsOf(auth, user.id)).length;
    const r = await magicLink(auth, token);
    expect(r.ok && "twoFactor" in r.value).toBe(true);
    expect(await sessionsOf(auth, user.id)).toHaveLength(before);
  });
});

describe("the gate on the social callback route (plan 12c)", () => {
  /** The start and the GET callback through the routes, with the binding cookie and `cookie`. */
  async function callback(
    auth: ReturnType<typeof socialAuth>,
    tokens: Record<string, FakeIdToken>,
    cookie?: string,
  ): Promise<Response> {
    const handle = createRouter(auth.config, socialRoutes(auth.config));
    const start = await handle(get("/auth/social/google/start?next=%2Fhome"));
    const bind = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const url = new URL(start.headers.get("location") ?? "");
    tokens["idtok-default"] = {
      audience: GOOGLE.clientId,
      issuer: "https://accounts.google.com",
      claims: {
        sub: "g-1",
        email: EMAIL,
        email_verified: true,
        nonce: url.searchParams.get("nonce") ?? "",
      },
    };
    return handle(
      get(
        `/auth/social/google/callback?code=c1&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`,
        { cookie: cookie === undefined ? bind : `${bind}; ${cookie}` },
      ),
    );
  }

  it("answers 302 to the challenge page, sets no session cookie, and clears the binding cookie", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({ password: { hash: FAST } }, fakeJwt(tokens));
    await enrolled(auth);
    const res = await callback(auth, tokens);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      new RegExp(`^${BASE_URL}/auth/totp/challenge\\?challenge=tf_`),
    );
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("__Host-tempo_session="))).toBe(false);
    expect(cookies.some((c) => c.startsWith("__Secure-tempo_session_oauth=;"))).toBe(true);
  });

  it("reads the trust cookie at the GET callback and opens the session (deviation 12)", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({ password: { hash: FAST } }, fakeJwt(tokens));
    const { secret } = await enrolled(auth);
    const token = await trustOf(auth, secret);
    const res = await callback(auth, tokens, `tempo_totp_trust=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/home`);
    expect(res.headers.getSetCookie().some((c) => /^__Host-tempo_session=ts_/.test(c))).toBe(true);
  });
});
