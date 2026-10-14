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

/** A test auth with the second factor on that records the `via` of each opened session. */
function recording(extra: Partial<AuthConfig> = {}) {
  const vias: string[] = [];
  const auth = totpAuth({
    hooks: {
      session: {
        afterCreate: (e) => {
          vias.push(e.via);
        },
      },
    },
    ...extra,
  });
  return { auth, vias };
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

async function emailCode(auth: Auth) {
  await requestEmailOtp(auth.config, { email: EMAIL, ip: null });
  const code = /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
  return verifyEmailOtp(auth.config, { email: EMAIL, code, ip: null, userAgent: null });
}

const sessionsOf = (auth: Auth, userId: string) =>
  auth.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }]);

describe("the gate on the magic link (plan 12c)", () => {
  it("answers a challenge with no email method, opens no session, and the verify opens it with via magic_link", async () => {
    const { auth, vias } = recording();
    const { user, secret } = await enrolled(auth);
    const before = (await sessionsOf(auth, user.id)).length;
    vias.length = 0;
    const r = await magicLink(auth);
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("the magic link answered no challenge");
    expect(r.value.next).toBe("/inbox");
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    expect((await sessionsOf(auth, user.id)).length).toBe(before);
    expect(vias).toEqual([]);
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
    const { auth, vias } = recording();
    const { user } = await enrolled(auth);
    const before = (await sessionsOf(auth, user.id)).length;
    const r = await emailCode(auth);
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("the code answered no challenge");
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    expect((await sessionsOf(auth, user.id)).length).toBe(before);
    const off = totpAuth({ totp: { gate: { emailOtp: false } } });
    await enrolled(off);
    const s = await emailCode(off);
    expect(s.ok && "token" in s.value).toBe(true);
    expect(vias).not.toContain("email_otp");
  });
});

describe("the gate on social (plan 12c)", () => {
  const ISS = "https://accounts.google.com";

  async function google(auth: ReturnType<typeof socialAuth>, tokens: Record<string, FakeIdToken>) {
    const start = await startSocial(auth.config, { provider: "google", next: "/home", ip: null });
    if (!start.ok) throw new Error(start.code);
    const url = new URL(start.value.location);
    tokens["idtok-default"] = {
      audience: GOOGLE.clientId,
      issuer: ISS,
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
    });
  }

  it("links the identity, answers a challenge with no email method, and opens no session", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({ password: { hash: FAST } }, fakeJwt(tokens));
    const { user } = await enrolled(auth);
    const before = (await sessionsOf(auth, user.id)).length;
    const r = await google(auth, tokens);
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("social answered no challenge");
    expect(r.value.next).toBe("/home");
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    expect((await sessionsOf(auth, user.id)).length).toBe(before);
    // The link commits with the challenge (spec 9): the link alone opens nothing.
    expect(
      await auth.storage.findOne("identity", [{ field: "provider", op: "eq", value: "google" }]),
    ).toMatchObject({ userId: user.id, subject: "g-1" });
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

describe("the gate on the social callback route (plan 12c)", () => {
  it("answers 302 to the challenge page, sets no session cookie, and clears the binding cookie", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({ password: { hash: FAST } }, fakeJwt(tokens));
    await enrolled(auth);
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
    const res = await handle(
      get(
        `/auth/social/google/callback?code=c1&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`,
        { cookie: bind },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      new RegExp(`^${BASE_URL}/auth/totp/challenge\\?challenge=tf_`),
    );
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("tempo_session="))).toBe(false);
    expect(cookies.some((c) => c.startsWith("tempo_session_oauth=;"))).toBe(true);
  });
});
