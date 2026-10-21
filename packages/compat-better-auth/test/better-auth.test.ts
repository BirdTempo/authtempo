import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  ERRORS,
  type LimiterPort,
  systemClock,
} from "@authtempo/core";
import { TEST_SECRET } from "@authtempo/core/testing";
import { describe, expect, it, vi } from "vitest";
import { type DrizzleAdapterConfig, drizzleAdapter } from "../src/adapters/drizzle.js";
import {
  APIError,
  BETTER_AUTH_CODES,
  PASSWORD_MAX_LENGTH,
  passwordPolicyCode,
} from "../src/errors.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { magicLink } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { BETTER_AUTH_DEFAULTS, mapOptions, skipUnknownIp } from "../src/server/map-options.js";
import { SESSION_KEYS, toNext, USER_KEYS } from "../src/server/shapes.js";
import type { BetterAuthOptions, CompatDatabase, EmailCallbackData } from "../src/types.js";

const BASE = "https://api.example.com";
const APP = "https://app.example.com";
const OTHER = "https://other.example.com";
function memoryDatabase(): CompatDatabase {
  // A test database: core's memory adapter under the compat kind. The SQL storage has its own tests (Tasks 5 and 6).
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}
const fast = betterAuthPasswordHash({ pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }) });

function app(extra: Record<string, unknown> = {}) {
  const sent: { kind: string; data: EmailCallbackData }[] = [];
  const auth = betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database: memoryDatabase(),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      sendResetPassword: async (data) => {
        sent.push({ kind: "reset", data });
      },
    },
    emailVerification: {
      sendVerificationEmail: async (data) => {
        sent.push({ kind: "verify", data });
      },
    },
    authtempo: { passwordHash: fast },
    ...extra,
  });
  return { auth, sent };
}

describe("betterAuth", () => {
  it("throws one BetterAuthCompatError that lists every refused item, sorted", () => {
    expect(() =>
      betterAuth({
        baseURL: BASE,
        secret: TEST_SECRET,
        database: memoryDatabase(),
        hooks: {},
        secondaryStorage: {},
      }),
    ).toThrowError(
      "authtempo compat: this config uses 2 items that authtempo cannot keep:\n- hooks: core has no request hooks: wrap auth.handler and read auth.tempo.session(request); see the README recipe\n- secondaryStorage: core keeps sessions in the session table; secondary storage is refused",
    );
  });

  it("lists drizzleAdapter's refusals in the same one error (plan 9b)", () => {
    const database = drizzleAdapter({ $client: {} }, {
      provider: "pg",
      casing: "snake",
    } as unknown as DrizzleAdapterConfig);
    expect(() =>
      betterAuth({
        baseURL: BASE,
        secret: TEST_SECRET,
        database,
        hooks: {},
      } as BetterAuthOptions),
    ).toThrowError(
      "authtempo compat: this config uses 3 items that authtempo cannot keep:\n- database.casing: drizzleAdapter accepts provider, schema, usePlural, transaction, and debugLogs only\n- database: drizzleAdapter needs a Drizzle database on postgres.js (drizzle-orm/postgres-js); other drivers are refused\n- hooks: core has no request hooks: wrap auth.handler and read auth.tempo.session(request); see the README recipe",
    );
  });

  it("answers better-auth/api at ./api with APIError only (plan 9b)", async () => {
    const pkg = JSON.parse((await import("../package.json?raw")).default) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports["./api"]).toEqual({ types: "./dist/api.d.ts", default: "./dist/api.js" });
    const api = await import("../src/api.js");
    expect(Object.keys(api)).toEqual(["APIError"]);
    expect(api.APIError).toBe(APIError);
  });

  it("turns a core ConfigError into the same error", () => {
    expect(() =>
      betterAuth({ baseURL: BASE, secret: "short", database: memoryDatabase() }),
    ).toThrowError(/config: secret must be at least 32 characters/);
  });

  it("logs one note per accepted speed option", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    app({ session: { cookieCache: { enabled: true, maxAge: 60 } } });
    expect(info).toHaveBeenCalledWith(
      "authtempo compat: session.cookieCache: accepted and has no effect: every request reads the session row",
    );
    info.mockRestore();
  });

  it("applies Better Auth's defaults before the mapping", () => {
    const m = mapOptions({ baseURL: BASE, secret: TEST_SECRET, database: memoryDatabase() });
    expect(BETTER_AUTH_DEFAULTS).toEqual({
      sessionExpiresIn: 604800,
      sessionUpdateAge: 86400,
      resetPasswordTokenExpiresIn: 3600,
      minPasswordLength: 8,
      magicLinkExpiresIn: 300,
      emailVerificationExpiresIn: 3600,
      invitationExpiresIn: 172800,
      membershipLimit: 100,
      invitationLimit: 100,
      emailOtpExpiresIn: 300,
      emailOtpAllowedAttempts: 3,
      twoFactorBackupCodes: 10,
      trustDeviceMaxAge: 2592000,
      freshAge: 86400,
      deleteTokenExpiresIn: 86400,
      basePath: "/api/auth",
    });
    expect(m.config.session).toEqual({ ttlDays: 7, slidingRefreshDays: 1, freshMinutes: 1440 });
    expect(m.config.magicLink).toEqual({ ttlMinutes: 60 });
    expect(m.basePath).toBe("/api/auth");
    expect(m.config.basePath).toBe("/api/auth");
  });

  it("moves the path of baseURL to basePath, as Better Auth reads it", () => {
    const m = mapOptions({
      baseURL: `${BASE}/auth`,
      secret: TEST_SECRET,
      database: memoryDatabase(),
    });
    expect([m.origin, m.basePath, m.config.baseURL]).toEqual([BASE, "/auth", BASE]);
  });

  it("maps the client IP options", () => {
    const off = mapOptions({
      baseURL: BASE,
      secret: TEST_SECRET,
      database: memoryDatabase(),
      advanced: { ipAddress: { disableIpTracking: true } },
    });
    expect(
      off.clientIp(new Request(BASE, { headers: { "cf-connecting-ip": "203.0.113.1" } })),
    ).toBeNull();
    const list = mapOptions({
      baseURL: BASE,
      secret: TEST_SECRET,
      database: memoryDatabase(),
      advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] } },
    });
    expect(
      list.clientIp(
        new Request(BASE, { headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" } }),
      ),
    ).toBe("198.51.100.7");
  });

  it("answers null for a listed IP header value that is not an IPv4 or IPv6 literal (M-6)", () => {
    const list = mapOptions({
      baseURL: BASE,
      secret: TEST_SECRET,
      database: memoryDatabase(),
      advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } },
    });
    const ipOf = (v: string) => list.clientIp(new Request(BASE, { headers: { "x-real-ip": v } }));
    expect([ipOf("unknown"), ipOf("not-an-ip"), ipOf("1".repeat(300)), ipOf("256.1.1.1")]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect([ipOf("203.0.113.9"), ipOf("2001:db8::1")]).toEqual(["203.0.113.9", "2001:db8::1"]);
  });

  it("notes the verify link lifetime when the magic link plugin is on and no verify lifetime is set (M-1)", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    app({ plugins: [magicLink({ sendMagicLink: async () => {} })] });
    expect(info).toHaveBeenCalledWith(
      "authtempo compat: emailVerification.expiresIn: not set: the verify link lives 300 s, the magic link's lifetime, not Better Auth's verify default of 3600 s",
    );
    info.mockRestore();
  });

  it("skips the per-IP limits with a note under disableIpTracking, and keeps the per-email limits", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    app({ advanced: { ipAddress: { disableIpTracking: true } } });
    expect(info).toHaveBeenCalledWith(
      "authtempo compat: advanced.ipAddress.disableIpTracking: accepted: password sign-in, the magic link, the email codes, and the reset request skip their per-IP limits and keep their per-email limits; every other flow counts all requests in one shared per-IP bucket. The cost: one caller can try one password on many addresses, bounded only by each address's limit, and can guess 10 email codes on each of many addresses per 15 minutes (at most 100 a day per address), about 1 takeover per 100,000 addresses per window, and each address gets the code mails",
    );
    info.mockRestore();
    const m = mapOptions({
      baseURL: BASE,
      secret: TEST_SECRET,
      database: memoryDatabase(),
      advanced: { ipAddress: { disableIpTracking: true } },
    });
    const limiter = m.config.limiter as LimiterPort;
    const w = { seconds: 60, max: 1 };
    const twice = async (key: string) => [await limiter.allow(key, w), await limiter.allow(key, w)];
    // No shared bucket for the flows that keep a per-email limit.
    expect(await twice("password:ip:unknown")).toEqual([true, true]);
    expect(await twice("magic-link:ip:unknown")).toEqual([true, true]);
    expect(await twice("password-reset:ip:unknown")).toEqual([true, true]);
    // A flow with only a per-IP limit keeps core's shared bucket (review I-2).
    expect(await twice("password-sign-up:ip:unknown")).toEqual([true, false]);
    expect(await twice("invitation-accept:ip:unknown")).toEqual([true, false]);
    expect(await twice("password:email:a@example.com")).toEqual([true, false]);
    expect(await twice("password:ip:203.0.113.1")).toEqual([true, false]);
  });

  it("maps Google, Apple, the cookie's sameSite, and the cookie name onto core's config", () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----";
    const m = mapOptions({
      baseURL: BASE,
      secret: TEST_SECRET,
      database: memoryDatabase(),
      socialProviders: {
        google: { clientId: "g", clientSecret: "gs" },
        apple: {
          clientId: "com.example.web",
          teamId: "TEAM123456",
          keyId: "KEY1234567",
          privateKey,
        },
        github: { clientId: "h", clientSecret: "hs" },
        linkedin: { clientId: "l", clientSecret: "ls" },
      },
      advanced: { defaultCookieAttributes: { sameSite: "None" } },
    });
    expect(m.config.social).toEqual({
      google: { clientId: "g", clientSecret: "gs" },
      apple: { clientId: "com.example.web", teamId: "TEAM123456", keyId: "KEY1234567", privateKey },
      github: { clientId: "h", clientSecret: "hs" },
      linkedin: { clientId: "l", clientSecret: "ls" },
    });
    expect(m.config.cookie).toEqual({ sameSite: "None" });
    expect(m.config.cookieName).toBe("__Host-tempo_session");
    const lax = mapOptions({
      baseURL: BASE,
      secret: TEST_SECRET,
      database: memoryDatabase(),
      advanced: { defaultCookieAttributes: { sameSite: "lax" } },
    });
    expect(lax.config.cookie).toEqual({ sameSite: "Lax" });
    expect(
      mapOptions({ baseURL: BASE, secret: TEST_SECRET, database: memoryDatabase() }).config.cookie,
    ).toBeUndefined();
  });

  it("keeps an absolute callbackURL on appURL and refuses every other origin (Review Focus 1)", async () => {
    expect(toNext("/dashboard?x=1", APP)).toBe("/dashboard?x=1");
    expect(toNext(`${APP}/dashboard?x=1#top`, APP)).toBe("/dashboard?x=1#top");
    expect([
      toNext(`${OTHER}/x`, APP),
      toNext("//evil.example.com/x", APP),
      toNext("dashboard", APP),
      toNext(`${APP}/x`, null),
    ]).toEqual([null, null, null, null]);
    const { auth } = app({
      trustedOrigins: [APP, OTHER],
      authtempo: { passwordHash: fast, appURL: APP },
      plugins: [magicLink({ sendMagicLink: async () => {} })],
    });
    expect(
      await auth.api.signInMagicLink({ body: { email: "a@example.com", callbackURL: `${APP}/x` } }),
    ).toEqual({ status: true });
    // A trusted origin that is not appURL is refused too: core would land on appURL.
    await expect(
      auth.api.signInMagicLink({ body: { email: "a@example.com", callbackURL: `${OTHER}/x` } }),
    ).rejects.toMatchObject({ statusCode: 403, body: { code: "INVALID_CALLBACK_URL" } });
  });

  it("ties PASSWORD_MAX_LENGTH to core's length rule through core's real sign-up (final review L-7)", async () => {
    const { auth } = app();
    // Code points, not UTF-16 units: every second one is an emoji of two units.
    const of = (n: number) =>
      Array.from({ length: n }, (_, i) => (i % 2 ? "\u{1F600}" : "a")).join("");
    const signUp = (email: string, n: number) =>
      auth.api.signUpEmail({ body: { email, password: of(n), name: "L" } });
    expect((await signUp("max@example.com", 128)).user.email).toBe("max@example.com");
    await expect(signUp("over@example.com", 129)).rejects.toMatchObject({
      statusCode: 400,
      body: { code: "PASSWORD_TOO_LONG" },
    });
    // The constant itself: core accepts its length and refuses one more.
    expect((await signUp("at@example.com", PASSWORD_MAX_LENGTH)).user.email).toBe("at@example.com");
    await expect(signUp("past@example.com", PASSWORD_MAX_LENGTH + 1)).rejects.toMatchObject({
      statusCode: 400,
      body: { code: "PASSWORD_TOO_LONG" },
    });
  });

  it("signs up through api.signUpEmail and mails the verify link through sendVerificationEmail", async () => {
    const { auth, sent } = app();
    const up = await auth.api.signUpEmail({
      body: { email: "Pat@Example.com", password: "correct horse battery", name: "Pat" },
    });
    expect(up.token).toMatch(/^ts_/);
    expect(Object.keys(up.user).sort()).toEqual([...USER_KEYS].sort());
    expect(up.user).toMatchObject({ email: "pat@example.com", name: "Pat", emailVerified: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe("verify");
    expect(sent[0]?.data.url.startsWith(`${BASE}/api/auth/password/verify?token=pv_`)).toBe(true);
    expect(sent[0]?.data.token.startsWith("pv_")).toBe(true);
    expect(sent[0]?.data.user.email).toBe("pat@example.com");
  });

  it("answers getSession with Better Auth's shapes, the token included (Review Focus 4)", async () => {
    const { auth } = app();
    const up = await auth.api.signUpEmail({
      body: { email: "a@example.com", password: "correct horse battery", name: "" },
    });
    const s = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${up.token}` }),
    });
    expect(Object.keys(s?.session ?? {}).sort()).toEqual([...SESSION_KEYS].sort());
    expect(s?.session.token).toBe(up.token);
    expect(s?.session.expiresAt).toBeInstanceOf(Date);
    expect(s?.user.name).toBe("");
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
    await auth.api.signOut({
      headers: new Headers({ cookie: `__Host-tempo_session=${up.token}` }),
    });
    expect(
      await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${up.token}` }) }),
    ).toBeNull();
  });

  it("throws APIError with Better Auth's code and core's status (Review Focus 5)", async () => {
    const { auth } = app();
    await auth.api.signUpEmail({
      body: { email: "a@example.com", password: "correct horse battery", name: "A" },
    });
    const wrong = auth.api.signInEmail({
      body: { email: "a@example.com", password: "wrong horse battery" },
    });
    await expect(wrong).rejects.toBeInstanceOf(APIError);
    await expect(wrong).rejects.toMatchObject({
      statusCode: 401,
      status: "UNAUTHORIZED",
      body: { code: "INVALID_EMAIL_OR_PASSWORD" },
    });
    await expect(
      auth.api.signUpEmail({
        body: { email: "a@example.com", password: "correct horse battery", name: "A" },
      }),
    ).rejects.toMatchObject({ statusCode: 409, body: { code: "USER_ALREADY_EXISTS" } });
    await expect(
      auth.api.signUpEmail({ body: { email: "b@example.com", password: "short", name: "B" } }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: "PASSWORD_TOO_SHORT" } });
    // 10 code points under minPasswordLength 12: Better Auth's code, by the configured minimum.
    await expect(
      auth.api.signUpEmail({ body: { email: "c@example.com", password: "ten chars!", name: "C" } }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: "PASSWORD_TOO_SHORT" } });
    // Core's verify link lands on the app origin; a callbackURL would be dropped in silence.
    await expect(
      auth.api.sendVerificationEmail({ body: { email: "a@example.com", callbackURL: "/x" } }),
    ).rejects.toMatchObject({ statusCode: 501, body: { code: "NOT_SUPPORTED" } });
  });

  it("resends the verify mail through api.sendVerificationEmail (plan 8b)", async () => {
    const { auth, sent } = app();
    await auth.api.signUpEmail({
      body: { email: "pat@example.com", password: "correct horse battery", name: "Pat" },
    });
    expect(await auth.api.sendVerificationEmail({ body: { email: "Pat@Example.com" } })).toEqual({
      status: true,
    });
    const verifies = sent.filter((m) => m.kind === "verify");
    expect(verifies).toHaveLength(2);
    const confirm = (token: string) =>
      auth.handler(
        new Request(`${BASE}/api/auth/password/verify`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify({ token }),
        }),
      );
    // The second link replaced the first.
    expect((await confirm(verifies[0]?.data.token ?? "")).status).toBe(400);
    expect((await confirm(verifies[1]?.data.token ?? "")).status).toBe(200);
    // An unknown address answers the same and sends nothing.
    expect(await auth.api.sendVerificationEmail({ body: { email: "nobody@example.com" } })).toEqual(
      { status: true },
    );
    expect(sent.filter((m) => m.kind === "verify")).toHaveLength(2);
  });

  it("skips the unknown-IP key of the resend, which has a per-email limit (plan 8b)", async () => {
    const keys: string[] = [];
    const limiter = skipUnknownIp({
      allow: async (key) => {
        keys.push(key);
        return true;
      },
    });
    await limiter.allow("password-resend:ip:unknown", { seconds: 900, max: 20 });
    await limiter.allow("password-resend:email:a@example.com", { seconds: 900, max: 3 });
    await limiter.allow("password-sign-up:ip:unknown", { seconds: 3600, max: 10 });
    expect(keys).toEqual(["password-resend:email:a@example.com", "password-sign-up:ip:unknown"]);
  });

  it("skips the unknown-IP keys of the email codes, which have per-email limits, and keeps their per-email and daily keys (plan 9e)", async () => {
    const keys: string[] = [];
    const limiter = skipUnknownIp({
      allow: async (key) => {
        keys.push(key);
        return true;
      },
    });
    await limiter.allow("otp:ip:unknown", { seconds: 900, max: 20 });
    await limiter.allow("otp:email:a@example.com", { seconds: 900, max: 3 });
    await limiter.allow("otp:email-day:a@example.com", { seconds: 86_400, max: 20 });
    await limiter.allow("otp-verify:ip:unknown", { seconds: 900, max: 30 });
    await limiter.allow("otp-verify:email:a@example.com", { seconds: 900, max: 10 });
    await limiter.allow("otp:ip:1.2.3.4", { seconds: 900, max: 20 });
    expect(keys).toEqual([
      "otp:email:a@example.com",
      "otp:email-day:a@example.com",
      "otp-verify:email:a@example.com",
      "otp:ip:1.2.3.4",
    ]);
  });

  it("maps every core and client code to one Better Auth code", () => {
    expect(Object.keys(BETTER_AUTH_CODES).sort()).toEqual(
      [...Object.keys(ERRORS), "cancelled", "network", "unexpected"].sort(),
    );
    expect(BETTER_AUTH_CODES).toMatchObject({
      invalid_credentials: "INVALID_EMAIL_OR_PASSWORD",
      email_taken: "USER_ALREADY_EXISTS",
      email_taken_unverified: "USER_ALREADY_EXISTS",
      unauthorized: "UNAUTHORIZED",
      rate_limited: "TOO_MANY_REQUESTS",
      invalid_token: "INVALID_TOKEN",
      token_expired: "TOKEN_EXPIRED",
      email_unverified: "EMAIL_NOT_VERIFIED",
      slug_taken: "ORGANIZATION_SLUG_ALREADY_TAKEN",
      invalid_code: "INVALID_OTP",
      too_many_attempts: "TOO_MANY_ATTEMPTS",
      totp_enabled: "TOTP_ALREADY_ENABLED",
      totp_not_enabled: "TOTP_NOT_ENABLED",
      // Plan 12h: the readiness route. Better Auth 1.7 has no such route, so the name is our own.
      not_ready: "NOT_READY",
    });
    expect([
      passwordPolicyCode("1234567", 8),
      passwordPolicyCode("x".repeat(129), 8),
      passwordPolicyCode("correct horse", 8),
    ]).toEqual(["PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG", "INVALID_PASSWORD"]);
    // The configured minimum decides, not Better Auth's default (Review Focus 5).
    expect([passwordPolicyCode("ten chars!", 12), passwordPolicyCode("twelve chars", 12)]).toEqual([
      "PASSWORD_TOO_SHORT",
      "INVALID_PASSWORD",
    ]);
  });

  it("serves core's routes under basePath and answers 404 outside it", async () => {
    const { auth } = app();
    expect((await auth.handler(new Request(`${BASE}/other/session`))).status).toBe(404);
    const res = await auth.handler(new Request(`${BASE}/api/auth/session`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(auth.tempo.api.sweepExpired).toBeTypeOf("function");
  });

  it("adds Better Auth's length code to core's password_policy answer, by the configured minimum", async () => {
    const { auth } = app();
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/password/sign-up`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "c@example.com", password: "ten chars!" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "password_policy", code: "PASSWORD_TOO_SHORT" });
  });
});

const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });

describe("the mail routes through compatMail (fix round 1: I-1, M-7)", () => {
  it("answers 200 for a reset request to an unknown address and calls no callback (I-1)", async () => {
    const { auth, sent } = app();
    const res = await auth.handler(
      json("/password/reset/request", { email: "nobody@example.com" }),
    );
    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("answers 404 on core's email code routes without the email-otp plugin (plan 9e)", async () => {
    const { auth, sent } = app();
    for (const path of ["/otp/request", "/otp/verify", "/otp/reset/request", "/otp/reset"])
      expect({
        path,
        status: (
          await auth.handler(
            json(path, { email: "a@example.com", code: "123456", password: "a long password" }),
          )
        ).status,
      }).toEqual({ path, status: 404 });
    expect(sent).toEqual([]);
  });

  it("answers 404 on core's JWT and OAuth routes: the package maps no jwt or OAuth plugin (plan 9g)", async () => {
    const { auth } = app();
    const routes = [
      ["GET", "/jwks"],
      ["GET", "/token"],
      ["GET", "/oauth/authorize"],
      ["POST", "/oauth/token"],
      ["GET", "/.well-known/openid-configuration"],
    ] as const;
    for (const [method, path] of routes) {
      const res = await auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
          method,
          ...(method === "POST"
            ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" }
            : {}),
        }),
      );
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    expect(auth.tempo.api.jwt).toBeUndefined();
    expect(
      (await auth.tempo.wellKnown(new Request(`${BASE}/.well-known/oauth-authorization-server`)))
        .status,
    ).toBe(404);
  });

  it("mails a reset link through sendResetPassword with the user, the URL, and the token", async () => {
    const { auth, sent } = app();
    await auth.api.signUpEmail({
      body: { email: "a@example.com", password: "correct horse battery", name: "A" },
    });
    const res = await auth.handler(json("/password/reset/request", { email: "a@example.com" }));
    expect(res.status).toBe(200);
    const reset = sent.filter((m) => m.kind === "reset");
    expect(reset).toHaveLength(1);
    const data = reset[0]?.data;
    expect(data?.user.email).toBe("a@example.com");
    expect(data?.url.startsWith(`${BASE}/api/auth/password/reset?token=`)).toBe(true);
    expect(data?.token).not.toBe("");
    expect(new URL(data?.url ?? BASE).searchParams.get("token")).toBe(data?.token);
  });

  it("mails a magic link through sendMagicLink with the email, the URL, and the token", async () => {
    const links: { email: string; url: string; token: string }[] = [];
    const { auth } = app({
      plugins: [
        magicLink({
          sendMagicLink: async (d) => {
            links.push(d);
          },
        }),
      ],
    });
    await auth.api.signInMagicLink({ body: { email: "m@example.com" } });
    expect(links).toHaveLength(1);
    expect(links[0]?.email).toBe("m@example.com");
    expect(links[0]?.url.startsWith(`${BASE}/api/auth/magic-link/verify?token=`)).toBe(true);
    expect(new URL(links[0]?.url ?? BASE).searchParams.get("token")).toBe(links[0]?.token);
  });
});

describe("withPolicyCode on the reset and change routes (M-7)", () => {
  it("adds the length code on /password/reset (field password)", async () => {
    const { auth, sent } = app();
    // Too long, not too short: a wrong field name reads "" and answers PASSWORD_TOO_SHORT.
    await auth.api.signUpEmail({
      body: { email: "a@example.com", password: "correct horse battery", name: "A" },
    });
    await auth.handler(json("/password/reset/request", { email: "a@example.com" }));
    const token = sent.find((m) => m.kind === "reset")?.data.token ?? "";
    const res = await auth.handler(json("/password/reset", { token, password: "x".repeat(129) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "password_policy", code: "PASSWORD_TOO_LONG" });
  });

  it("adds the length code on /password/change (field newPassword)", async () => {
    const { auth, sent } = app();
    await auth.api.signUpEmail({
      body: { email: "a@example.com", password: "correct horse battery", name: "A" },
    });
    // Core changes a password only for a verified address. The verify ends the
    // sign-up session and sets a new session cookie: the change uses that one.
    const verifyToken = sent.find((m) => m.kind === "verify")?.data.token ?? "";
    const verified = await auth.handler(json("/password/verify", { token: verifyToken }));
    expect(verified.status).toBe(200);
    const session =
      /__Host-tempo_session=([^;]+)/.exec(verified.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const res = await auth.handler(
      json(
        "/password/change",
        { currentPassword: "correct horse battery", newPassword: "x".repeat(129) },
        { authorization: `Bearer ${session}` },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "password_policy", code: "PASSWORD_TOO_LONG" });
  });
});

describe("the notices are off under the shim (plan 12a)", () => {
  it("sends no notice and logs no notice failure after a password change (plan 12a)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { auth, sent } = app();
      await auth.api.signUpEmail({
        body: { email: "a@example.com", password: "correct horse battery", name: "A" },
      });
      const verifyToken = sent.find((m) => m.kind === "verify")?.data.token ?? "";
      const verified = await auth.handler(json("/password/verify", { token: verifyToken }));
      const session =
        /__Host-tempo_session=([^;]+)/.exec(verified.headers.get("set-cookie") ?? "")?.[1] ?? "";
      const res = await auth.handler(
        json(
          "/password/change",
          { currentPassword: "correct horse battery", newPassword: "another long password" },
          { authorization: `Bearer ${session}` },
        ),
      );
      expect(res.status).toBe(200);
      expect(sent.map((m) => m.kind)).toEqual(["verify"]);
      expect(log.mock.calls.filter((c) => c[0] === "authtempo: notice mail failed")).toEqual([]);
      // The account section holds the delete and the mail too (plan 12a Task 14): read the one key.
      expect(
        mapOptions({ baseURL: BASE, secret: TEST_SECRET, database: memoryDatabase() }).config
          .account?.notices,
      ).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

describe("api refuses the arguments core cannot keep (M-3)", () => {
  it("answers 501 NOT_SUPPORTED for callbackURL at sign-up, and callbackURL or rememberMe: false at sign-in", async () => {
    const { auth } = app();
    const notSupported = { statusCode: 501, body: { code: "NOT_SUPPORTED" } };
    await expect(
      auth.api.signUpEmail({
        body: {
          email: "a@example.com",
          password: "correct horse battery",
          name: "A",
          callbackURL: "/x",
        },
      }),
    ).rejects.toMatchObject(notSupported);
    await auth.api.signUpEmail({
      body: { email: "a@example.com", password: "correct horse battery", name: "A" },
    });
    const body = { email: "a@example.com", password: "correct horse battery" };
    await expect(
      auth.api.signInEmail({ body: { ...body, callbackURL: "/x" } }),
    ).rejects.toMatchObject(notSupported);
    await expect(
      auth.api.signInEmail({ body: { ...body, rememberMe: false } }),
    ).rejects.toMatchObject(notSupported);
    await expect(auth.api.signInEmail({ body })).resolves.toMatchObject({ redirect: false });
    // rememberMe: true is Better Auth's default and what core does (review R-1).
    await expect(
      auth.api.signInEmail({ body: { ...body, rememberMe: true } }),
    ).resolves.toMatchObject({ redirect: false });
  });
});
