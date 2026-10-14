import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { describe, expect, it, vi } from "vitest";
import readme from "../README.md?raw";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, COMPAT_PLUGIN, emailOTP, twoFactor } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import { TWO_FACTOR_NOT_SUPPORTED } from "../src/server/two-factor.js";
import type { BetterAuthOptions, CompatDatabase, TwoFactorOptions } from "../src/types.js";

const BASE = "https://api.example.com";
const EMAIL = "pat@example.com";
const PASSWORD = "correct horse battery";

function memoryDatabase(): CompatDatabase {
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}

function options(tf: TwoFactorOptions | null, links: string[] = []): BetterAuthOptions {
  return {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database: memoryDatabase(),
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async ({ token }) => {
        links.push(token);
      },
    },
    plugins: tf ? [twoFactor({ accountLockout: { enabled: false }, ...tf }), bearer()] : [bearer()],
    authtempo: {
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  };
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? null;
const pair = (cookie: string | null) => (cookie ?? "").split(";")[0] ?? "";

/** A verified user with a session; `post` sends a JSON POST under /api/auth with the given cookies. */
async function app(tf: TwoFactorOptions | null = {}) {
  const links: string[] = [];
  const opts = options(tf, links);
  const storage = (opts.database as CompatDatabase).storage;
  const auth = betterAuth(opts);
  const post = (path: string, body: unknown, cookie = "") =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const get = (path: string, cookie = "") =>
    auth.handler(new Request(`${BASE}/api/auth${path}`, { headers: cookie ? { cookie } : {} }));
  await post("/password/sign-up", { email: EMAIL, password: PASSWORD });
  await post("/password/verify", { token: links.at(-1) });
  const signIn = await post("/password/sign-in", { email: EMAIL, password: PASSWORD });
  const session = pair(cookieOf(signIn, "__Host-tempo_session"));
  return { auth, post, get, session, storage };
}

/** The factor on through Better Auth's two paths: enable with the password, then verify-totp with the session. */
async function enrolled(tf: TwoFactorOptions = {}) {
  const a = await app(tf);
  const enable = await a.post("/two-factor/enable", { password: PASSWORD }, a.session);
  const body = (await enable.clone().json()) as { totpURI: string; backupCodes: string[] };
  const secret = base32Decode(new URL(body.totpURI).searchParams.get("secret") ?? "");
  const confirm = await a.post(
    "/two-factor/verify-totp",
    { code: await totpCode(secret, new Date()) },
    a.session,
  );
  if (confirm.status !== 200) throw new Error(`verify-totp answered ${confirm.status}`);
  return { ...a, secret, backupCodes: body.backupCodes, enable, confirm };
}

describe("the two-factor options (plan 9f)", () => {
  it("maps the issuer, the backup codes, and the trust days, with Better Auth 1.7.2's defaults", () => {
    const totp = (tf: TwoFactorOptions | null) => mapOptions(options(tf)).config.totp;
    expect(totp({})).toEqual({
      backupCodes: 10,
      trustDays: 30,
      trustCookieName: "better-auth.trust_device",
      gate: { magicLink: false, emailOtp: false, social: false },
    });
    expect(
      totp({
        issuer: "Acme",
        backupCodeOptions: { amount: 12, length: 24 },
        trustDeviceMaxAge: 7 * 86_400,
        totpOptions: { digits: 6, period: 30 },
      }),
    ).toEqual({
      issuer: "Acme",
      backupCodes: 12,
      backupCodeLength: 24,
      trustDays: 7,
      trustCookieName: "better-auth.trust_device",
      gate: { magicLink: false, emailOtp: false, social: false },
    });
    expect(totp(null)).toBe(false);
  });

  it("refuses each option core cannot keep, by name, and needs emailAndPassword", () => {
    const refusalsFor = (tf: Record<string, unknown>) =>
      checkOptions({
        ...options(null),
        plugins: [{ kind: COMPAT_PLUGIN, id: "two-factor", options: tf } as never],
      }).refusals;
    expect(refusalsFor({ issuer: "Acme", accountLockout: { enabled: false } })).toEqual([]);
    expect(
      refusalsFor({
        issuer: "Acme:Co",
        totpOptions: { digits: 8, period: 60 },
        otpOptions: {},
        backupCodeOptions: {
          amount: 4,
          length: 13,
          customBackupCodesGenerate: () => [],
          storeBackupCodes: "plain",
        },
        skipVerificationOnEnable: true,
        allowPasswordless: true,
        twoFactorTable: "mfa",
        schema: {},
        twoFactorCookieMaxAge: 300,
        trustDeviceMaxAge: 3600,
        accountLockout: { enabled: true, maxFailedAttempts: 3 },
      }).sort(),
    ).toEqual(
      [
        "plugins[two-factor].accountLockout: core has no account lockout; pass { enabled: false }. Core caps the code checks per user at 10 per 15 minutes and 30 per 24 hours, and 5 codes per challenge",
        "plugins[two-factor].allowPasswordless: core asks for the password at every change of the factor",
        "plugins[two-factor].backupCodeOptions.amount: core takes an integer from 5 to 20",
        "plugins[two-factor].backupCodeOptions.customBackupCodesGenerate: core makes its own backup codes",
        "plugins[two-factor].backupCodeOptions.length: core takes an integer from 23 to 32: a backup code holds 112 bits or more (ASVS 5.0 6.5.2)",
        "plugins[two-factor].backupCodeOptions.storeBackupCodes: core stores a keyed hash of each code; leave it out",
        "plugins[two-factor].issuer: core takes 1 to 80 characters with no colon",
        "plugins[two-factor].otpOptions: core's email second factor sends through totp.emailMail; the shim maps no Better Auth sender, so send-otp stays NOT_SUPPORTED; see the plan index",
        "plugins[two-factor].schema: core keeps the factor in its own ta_second_factor and ta_totp tables",
        "plugins[two-factor].skipVerificationOnEnable: core turns the factor on only after a right code",
        "plugins[two-factor].totpOptions.digits: core makes 6-digit codes",
        "plugins[two-factor].totpOptions.period: core fixes the step at 30 seconds",
        "plugins[two-factor].trustDeviceMaxAge: core takes whole days from 1 to 365",
        "plugins[two-factor].twoFactorCookieMaxAge: core's challenge lives 5 minutes; the cookie lives 600 s",
        "plugins[two-factor].twoFactorTable: core keeps the factor in its own ta_second_factor and ta_totp tables",
      ].sort(),
    );
    // Whole days, but more than core's 365.
    expect(
      refusalsFor({ accountLockout: { enabled: false }, trustDeviceMaxAge: 366 * 86_400 }),
    ).toEqual(["plugins[two-factor].trustDeviceMaxAge: core takes whole days from 1 to 365"]);
    expect(
      refusalsFor({ accountLockout: { enabled: false }, trustDeviceMaxAge: 365 * 86_400 }),
    ).toEqual([]);
    const noPassword = checkOptions({
      ...options(null),
      emailAndPassword: { enabled: false },
      plugins: [twoFactor({ accountLockout: { enabled: false } })],
    }).refusals;
    expect(noPassword).toContain(
      "plugins[two-factor]: needs emailAndPassword.enabled: core's second factor gates the password sign-in only",
    );
  });

  it("notes Better Auth's account lockout when the app sets none", () => {
    const notes = checkOptions({ ...options(null), plugins: [twoFactor()] }).notes;
    expect(notes).toContain(
      "plugins[two-factor].accountLockout: not set: Better Auth locks an account for 900 s after 10 wrong codes; core has no account lockout and caps the code checks per user at 10 per 15 minutes and 30 per 24 hours, and 5 codes per challenge",
    );
  });
});

describe("the two-factor paths (plan 9f)", () => {
  it("enables with the password: the setup answers the URI and the backup codes, and verify-totp with the session turns it on", async () => {
    const { enable, confirm, backupCodes, get, session, post } = await enrolled({ issuer: "Acme" });
    expect(enable.status).toBe(200);
    const body = await json(enable);
    expect(body.method).toBe("totp");
    expect(String(body.totpURI).startsWith("otpauth://totp/Acme:pat%40example.com?")).toBe(true);
    expect(backupCodes).toHaveLength(10);
    expect(backupCodes[0]).toHaveLength(27);
    expect(await json(confirm)).toMatchObject({ user: { email: EMAIL, twoFactorEnabled: true } });
    const s = await json(await get("/session", session));
    expect(s.user).toMatchObject({ twoFactorEnabled: true });
    const wrong = await post("/two-factor/enable", { password: "wrong password" }, session);
    expect(wrong.status).toBe(400);
    expect(await json(wrong)).toMatchObject({ code: "INVALID_PASSWORD" });
  });

  it("checks the password before any setup: a wrong one on enable and on core's /totp/setup writes no row (review I-1)", async () => {
    const { post, session, storage } = await app();
    const wrong = await post("/two-factor/enable", { password: "wrong password" }, session);
    expect(wrong.status).toBe(400);
    expect(await json(wrong)).toMatchObject({ code: "INVALID_PASSWORD" });
    // Core's own setup route, which the handler passes through, takes the password too.
    const bare = await post("/totp/setup", {}, session);
    expect(bare.status).toBe(400);
    const coreWrong = await post("/totp/setup", { password: "wrong password" }, session);
    expect(coreWrong.status).toBe(401);
    expect(await json(coreWrong)).toMatchObject({ error: "invalid_credentials" });
    expect(await storage.findMany("totp", [])).toEqual([]);
    const right = await post("/two-factor/enable", { password: PASSWORD }, session);
    expect(right.status).toBe(200);
    expect(await storage.findMany("totp", [])).toHaveLength(1);
  });

  it("limits the enable's password check on its own key: five wrong passwords answer INVALID_PASSWORD, the sixth 429, and the owner's password sign-in still passes (plan 9h final fix wave, I-2)", async () => {
    const { post, session } = await app();
    const answers: { status: number; code: unknown }[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await post("/two-factor/enable", { password: "wrong password" }, session);
      answers.push({ status: r.status, code: (await json(r)).code });
    }
    expect(answers).toEqual([
      ...Array.from({ length: 5 }, () => ({ status: 400, code: "INVALID_PASSWORD" })),
      { status: 429, code: "TOO_MANY_REQUESTS" },
    ]);
    // The setup's key is not the sign-in's: the owner still signs in with the password.
    const signIn = await post("/password/sign-in", { email: EMAIL, password: PASSWORD });
    expect(signIn.status).toBe(200);
  });

  it("answers TOTP_ALREADY_ENABLED (409) for a second enable, and INVALID_PASSWORD (400) for a wrong password on disable, get-totp-uri, and generate-backup-codes", async () => {
    const { post, session, get } = await enrolled();
    const again = await post("/two-factor/enable", { password: PASSWORD }, session);
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: "TOTP_ALREADY_ENABLED" });
    for (const path of [
      "/two-factor/disable",
      "/two-factor/get-totp-uri",
      "/two-factor/generate-backup-codes",
    ]) {
      const r = await post(path, { password: "wrong password" }, session);
      expect({ path, status: r.status, body: await json(r) }).toMatchObject({
        path,
        status: 400,
        body: { code: "INVALID_PASSWORD" },
      });
    }
    expect((await json(await get("/session", session))).user).toMatchObject({
      twoFactorEnabled: true,
    });
  });

  it("answers INVALID_TWO_FACTOR_COOKIE (401) and clears a challenge cookie of another shape, also one over 64 characters", async () => {
    const { post } = await enrolled();
    for (const value of [`tf_${"a".repeat(80)}`, "not-a-challenge"]) {
      const r = await post(
        "/two-factor/verify-totp",
        { code: "123456" },
        `better-auth.two_factor=${value}`,
      );
      expect({ value, status: r.status }).toEqual({ value, status: 401 });
      expect(await json(r)).toMatchObject({ code: "INVALID_TWO_FACTOR_COOKIE" });
      expect(cookieOf(r, "better-auth.two_factor")).toMatch(/Max-Age=0/);
    }
  });

  it("clears the two_factor cookie on core's own verify of the challenge (review M-5)", async () => {
    const { post, secret } = await enrolled();
    const signIn = await post("/password/sign-in", { email: EMAIL, password: PASSWORD });
    const body = (await signIn.json()) as { twoFactor: { challenge: string } };
    const challenge = pair(cookieOf(signIn, "better-auth.two_factor"));
    vi.useFakeTimers({ now: Date.now() + 30_000, toFake: ["Date"] });
    try {
      const v = await post(
        "/totp/verify",
        { challenge: body.twoFactor.challenge, code: await totpCode(secret, new Date()) },
        challenge,
      );
      expect(v.status).toBe(200);
      expect(cookieOf(v, "better-auth.two_factor")).toBe(
        "better-auth.two_factor=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      );
      expect(cookieOf(v, "__Host-tempo_session")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a challenge at the sign-in with the two_factor cookie, and verify-totp opens the session", async () => {
    const { post, secret } = await enrolled();
    const signIn = await post("/password/sign-in", { email: EMAIL, password: PASSWORD });
    expect(cookieOf(signIn, "__Host-tempo_session")).toBeNull();
    const challenge = cookieOf(signIn, "better-auth.two_factor");
    expect(challenge).toMatch(
      /^better-auth\.two_factor=tf_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
    vi.useFakeTimers({ now: Date.now() + 30_000, toFake: ["Date"] });
    try {
      const v = await post(
        "/two-factor/verify-totp",
        { code: await totpCode(secret, new Date()), trustDevice: true },
        pair(challenge),
      );
      expect(v.status).toBe(200);
      const body = await json(v);
      expect(body).toMatchObject({ user: { email: EMAIL, twoFactorEnabled: true } });
      expect(String(body.token)).toMatch(/^ts_/);
      expect(v.headers.get("set-auth-token")).toBe(body.token);
      expect(cookieOf(v, "better-auth.two_factor")).toMatch(/Max-Age=0/);
      const trust = cookieOf(v, "better-auth.trust_device");
      expect(trust).toMatch(/^better-auth\.trust_device=td_[A-Za-z0-9_-]{43}; Path=\/api\/auth\//);
      const again = await post(
        "/password/sign-in",
        { email: EMAIL, password: PASSWORD },
        pair(trust),
      );
      expect(cookieOf(again, "__Host-tempo_session")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers INVALID_TWO_FACTOR_COOKIE (401) for a missing cookie and for a stale one, and clears the stale one (Review Focus)", async () => {
    const { post, secret } = await enrolled();
    const missing = await post("/two-factor/verify-totp", { code: "123456" });
    expect(missing.status).toBe(401);
    expect(await json(missing)).toMatchObject({ code: "INVALID_TWO_FACTOR_COOKIE" });
    const signIn = await post("/password/sign-in", { email: EMAIL, password: PASSWORD });
    const challenge = pair(cookieOf(signIn, "better-auth.two_factor"));
    vi.useFakeTimers({ now: Date.now() + 300_000, toFake: ["Date"] });
    try {
      const stale = await post(
        "/two-factor/verify-totp",
        { code: await totpCode(secret, new Date()) },
        challenge,
      );
      expect(stale.status).toBe(401);
      expect(await json(stale)).toMatchObject({ code: "INVALID_TWO_FACTOR_COOKIE" });
      expect(cookieOf(stale, "better-auth.two_factor")).toMatch(/Max-Age=0/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers INVALID_CODE for a wrong code, TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE at the fifth, and INVALID_BACKUP_CODE for a wrong backup code", async () => {
    const { post, secret, backupCodes } = await enrolled();
    const signIn = await post("/password/sign-in", { email: EMAIL, password: PASSWORD });
    const challenge = pair(cookieOf(signIn, "better-auth.two_factor"));
    const right = await totpCode(secret, new Date());
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) {
      const r = await post("/two-factor/verify-totp", { code: wrong }, challenge);
      expect(r.status).toBe(400);
      expect(await json(r)).toMatchObject({ code: "INVALID_CODE" });
    }
    const fifth = await post("/two-factor/verify-totp", { code: wrong }, challenge);
    expect(fifth.status).toBe(400);
    expect(await json(fifth)).toMatchObject({ code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" });
    // The capped challenge answers the same to a right code.
    const after = await post("/two-factor/verify-totp", { code: right }, challenge);
    expect(await json(after)).toMatchObject({ code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" });
    const next = pair(
      cookieOf(
        await post("/password/sign-in", { email: EMAIL, password: PASSWORD }),
        "better-auth.two_factor",
      ),
    );
    const badBackup = await post("/two-factor/verify-backup-code", { code: "zzzzzzzzzz" }, next);
    expect(await json(badBackup)).toMatchObject({ code: "INVALID_BACKUP_CODE" });
    const used = await post("/two-factor/verify-backup-code", { code: backupCodes[0] }, next);
    expect(used.status).toBe(200);
    expect(
      await json(
        await post(
          "/two-factor/verify-backup-code",
          { code: backupCodes[1], disableSession: true },
          next,
        ),
      ),
    ).toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("answers the URI and new backup codes after the password, and disables; then TOTP_NOT_ENABLED and TWO_FACTOR_NOT_ENABLED", async () => {
    const { post, session } = await enrolled();
    const uri = await json(await post("/two-factor/get-totp-uri", { password: PASSWORD }, session));
    expect(String(uri.totpURI).startsWith("otpauth://totp/")).toBe(true);
    const codes = await json(
      await post("/two-factor/generate-backup-codes", { password: PASSWORD }, session),
    );
    expect(codes).toMatchObject({ status: true });
    expect(codes.backupCodes).toHaveLength(10);
    const off = await post("/two-factor/disable", { password: PASSWORD }, session);
    expect(await json(off)).toEqual({ status: true });
    expect(cookieOf(off, "better-auth.trust_device")).toMatch(/Max-Age=0/);
    expect(
      await json(await post("/two-factor/get-totp-uri", { password: PASSWORD }, session)),
    ).toMatchObject({ code: "TOTP_NOT_ENABLED" });
    expect(
      await json(await post("/two-factor/generate-backup-codes", { password: PASSWORD }, session)),
    ).toMatchObject({ code: "TWO_FACTOR_NOT_ENABLED" });
  });

  it("answers NOT_SUPPORTED (501) for the email and SMS code paths and for method otp, and 401 with no session", async () => {
    const { post, session } = await app();
    for (const path of TWO_FACTOR_NOT_SUPPORTED) {
      const r = await post(path, {}, session);
      expect({ path, status: r.status }).toEqual({ path, status: 501 });
      expect(await json(r)).toMatchObject({ code: "NOT_SUPPORTED" });
    }
    expect(
      (await post("/two-factor/enable", { password: PASSWORD, method: "otp" }, session)).status,
    ).toBe(501);
    const none = await post("/two-factor/enable", { password: PASSWORD });
    expect(none.status).toBe(401);
  });

  it("api.signInEmail answers twoFactorRedirect, and api.getSession answers twoFactorEnabled", async () => {
    const { auth, session, storage } = await enrolled();
    expect(await auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD } })).toEqual({
      twoFactorRedirect: true,
      twoFactorMethods: ["totp"],
    });
    // No caller can reach a server sign-in's challenge, so no row stays (review M-1).
    expect(
      await storage.findMany("verification", [{ field: "purpose", op: "eq", value: "two-factor" }]),
    ).toEqual([]);
    const s = await auth.api.getSession({ headers: new Headers({ cookie: session }) });
    expect(s?.user.twoFactorEnabled).toBe(true);
  });

  it("api.signInEmail reads the trust cookie from the headers: a trusted device signs in with no challenge (review M-1)", async () => {
    const { auth, post, secret } = await enrolled();
    const signIn = await post("/password/sign-in", { email: EMAIL, password: PASSWORD });
    const challenge = pair(cookieOf(signIn, "better-auth.two_factor"));
    vi.useFakeTimers({ now: Date.now() + 30_000, toFake: ["Date"] });
    try {
      const v = await post(
        "/two-factor/verify-totp",
        { code: await totpCode(secret, new Date()), trustDevice: true },
        challenge,
      );
      const trust = pair(cookieOf(v, "better-auth.trust_device"));
      expect(trust).toMatch(/^better-auth\.trust_device=td_/);
      const r = await auth.api.signInEmail({
        body: { email: EMAIL, password: PASSWORD },
        headers: new Headers({ cookie: trust }),
      });
      expect(r).toMatchObject({ redirect: false, user: { email: EMAIL } });
      expect(String((r as { token?: string }).token)).toMatch(/^ts_/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 404 on the two-factor paths and on core's TOTP routes without the plugin", async () => {
    const { post, get, session } = await app(null);
    expect((await post("/two-factor/enable", { password: PASSWORD }, session)).status).toBe(404);
    expect((await get("/totp", session)).status).toBe(404);
  });

  it("documents the mapping in the README", () => {
    expect(readme).toContain("| `twoFactor` |");
    expect(readme).toContain("INVALID_TWO_FACTOR_COOKIE");
    expect(readme).toContain("accountLockout: { enabled: false }");
  });
});

describe("the reset of a user with the factor on (plan 12c)", () => {
  /** A verified user with the factor on, on an app with the email OTP plugin; `sent` holds the mailed codes. */
  async function resetApp() {
    const sent: { email: string; otp: string; type: string }[] = [];
    const links: string[] = [];
    const opts = options({}, links);
    const auth = betterAuth({
      ...opts,
      plugins: [
        ...(opts.plugins ?? []),
        emailOTP({
          sendVerificationOTP: async (d) => {
            sent.push(d);
          },
        }),
      ],
    });
    const post = (path: string, body: unknown, cookie = "") =>
      auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: BASE,
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    await post("/password/sign-up", { email: EMAIL, password: PASSWORD });
    await post("/password/verify", { token: links.at(-1) });
    const session = pair(
      cookieOf(
        await post("/password/sign-in", { email: EMAIL, password: PASSWORD }),
        "__Host-tempo_session",
      ),
    );
    const enable = await post("/two-factor/enable", { password: PASSWORD }, session);
    const uri = ((await enable.json()) as { totpURI: string }).totpURI;
    const secret = base32Decode(new URL(uri).searchParams.get("secret") ?? "");
    const on = await post(
      "/two-factor/verify-totp",
      { code: await totpCode(secret, new Date()) },
      session,
    );
    expect(on.status).toBe(200);
    const reset = async (cookie = "") => {
      await post(
        "/email-otp/send-verification-otp",
        { email: EMAIL, type: "forget-password" },
        cookie,
      );
      const otp = sent.findLast((s) => s.type === "forget-password")?.otp ?? "";
      return post(
        "/email-otp/reset-password",
        { email: EMAIL, otp, password: "a brand new long password" },
        cookie,
      );
    };
    return { auth, post, secret, reset, sent, storage: (opts.database as CompatDatabase).storage };
  }

  it("answers success with no cookie for a user with the factor on, and the next sign-in asks for the factor", async () => {
    const { auth, post, reset } = await resetApp();
    const r = await reset();
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ success: true });
    expect(cookieOf(r, "__Host-tempo_session")).toBeNull();
    expect(cookieOf(r, "better-auth.two_factor")).toBeNull();
    const signIn = await post("/password/sign-in", {
      email: EMAIL,
      password: "a brand new long password",
    });
    expect((await json(signIn)).twoFactor).toBeDefined();
    expect(
      await auth.api.signInEmail({ body: { email: EMAIL, password: "a brand new long password" } }),
    ).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
  });

  it("keeps no challenge row after the reset: the shim answers { success: true }, so no caller holds the challenge", async () => {
    const { reset, storage } = await resetApp();
    const challenges = () =>
      storage.findMany("verification", [{ field: "purpose", op: "eq", value: "two-factor" }]);
    expect(await challenges()).toEqual([]);
    expect((await reset()).status).toBe(200);
    expect(await challenges()).toEqual([]);
  });

  it("keeps the email code gate off: a code sign-in of a user with the factor on opens the session, as in Better Auth", async () => {
    const { post, sent } = await resetApp();
    await post("/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" });
    const otp = sent.findLast((s) => s.type === "sign-in")?.otp ?? "";
    const r = await post("/sign-in/email-otp", { email: EMAIL, otp });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ user: { email: EMAIL } });
    expect(cookieOf(r, "__Host-tempo_session")).not.toBeNull();
  });

  it("opens the session at the reset on a trusted device: core reads the trust cookie the shim forwards (plan 12c)", async () => {
    const { post, secret, reset } = await resetApp();
    const signIn = await post("/password/sign-in", { email: EMAIL, password: PASSWORD });
    const challenge = pair(cookieOf(signIn, "better-auth.two_factor"));
    vi.useFakeTimers({ now: Date.now() + 30_000, toFake: ["Date"] });
    try {
      const v = await post(
        "/two-factor/verify-totp",
        { code: await totpCode(secret, new Date()), trustDevice: true },
        challenge,
      );
      const trust = pair(cookieOf(v, "better-auth.trust_device"));
      expect(trust).toMatch(/^better-auth\.trust_device=td_/);
      const r = await reset(trust);
      expect(r.status).toBe(200);
      expect(await json(r)).toEqual({ success: true });
      expect(cookieOf(r, "__Host-tempo_session")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps send-otp and verify-otp at NOT_SUPPORTED: the shim maps no Better Auth sender for the email factor", () => {
    expect(TWO_FACTOR_NOT_SUPPORTED).toEqual(["/two-factor/send-otp", "/two-factor/verify-otp"]);
  });
});
