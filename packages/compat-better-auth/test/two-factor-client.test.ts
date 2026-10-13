import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient, expoClient, twoFactorClient } from "../src/client/index.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, twoFactor } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import type { CompatDatabase, TwoFactorClientOptions } from "../src/types.js";

const BASE = "https://api.example.com";
const EMAIL = "pat@example.com";
const PASSWORD = "correct horse battery";
const OTHER = "sam@example.com";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

/** A server with the plugin, and an Expo client: the token lives in storage, so no cookie jar is needed. */
async function setup(tf: TwoFactorClientOptions = { onTwoFactorRedirect: vi.fn() }) {
  const links: string[] = [];
  const database: CompatDatabase = {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
  const auth = betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: ["reception://"],
    database,
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: { sendVerificationEmail: async (d) => void links.push(d.token) },
    plugins: [bearer(), twoFactor({ accountLockout: { enabled: false } })],
    authtempo: {
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  });
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push(new URL(req.url).pathname);
    return auth.handler(req);
  };
  const storage = memoryStorage();
  const c = createAuthClient({
    baseURL: BASE,
    basePath: "/api/auth",
    plugins: [
      expoClient({ scheme: "reception", storagePrefix: "reception", storage }),
      twoFactorClient(tf),
    ],
    fetchOptions: { customFetchImpl: fetchImpl },
  });
  /** Sign up and verify the address. The verify claims it and ends the sign-up session. */
  const register = async (email: string, name: string) => {
    await c.signUp.email({ email, password: PASSWORD, name });
    await auth.handler(
      new Request(`${BASE}/api/auth/password/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ token: links.at(-1) }),
      }),
    );
  };
  await register(EMAIL, "Pat");
  const signedIn = await c.signIn.email({ email: EMAIL, password: PASSWORD });
  if (signedIn.error) throw new Error(signedIn.error.code);
  return { auth, c, storage, register, calls, onTwoFactorRedirect: tf.onTwoFactorRedirect };
}

/** The factor on through the client: enable with the password, then verifyTotp with the session. */
async function enrolled(tf?: TwoFactorClientOptions) {
  const s = await setup(tf);
  const enabled = await s.c.twoFactor.enable({ password: PASSWORD });
  if (!enabled.data) throw new Error(enabled.error?.code);
  const secret = base32Decode(new URL(enabled.data.totpURI).searchParams.get("secret") ?? "");
  const confirm = await s.c.twoFactor.verifyTotp({ code: await totpCode(secret, new Date()) });
  if (confirm.error) throw new Error(confirm.error.code);
  return { ...s, secret, backupCodes: enabled.data.backupCodes };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("twoFactorClient (plan 9f)", () => {
  it("enables, answers twoFactorRedirect at the next sign-in, calls onTwoFactorRedirect, and verifyTotp signs in", async () => {
    const { c, secret, storage, onTwoFactorRedirect } = await enrolled();
    const r = await c.signIn.email({ email: EMAIL, password: PASSWORD });
    expect(r).toEqual({
      data: { twoFactorRedirect: true, twoFactorMethods: ["totp"] },
      error: null,
    });
    expect(onTwoFactorRedirect).toHaveBeenCalledWith({ twoFactorMethods: ["totp"] });
    vi.useFakeTimers({ now: Date.now() + 30_000, toFake: ["Date"] });
    const v = await c.twoFactor.verifyTotp({ code: await totpCode(secret, new Date()) });
    expect(v.error).toBeNull();
    expect(v.data?.user.email).toBe(EMAIL);
    expect(storage.map.get("reception_tempo_session")).toBe(v.data?.token);
  });

  it("answers INVALID_CODE for a wrong code and TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE at the fifth", async () => {
    const { c, secret } = await enrolled();
    await c.signIn.email({ email: EMAIL, password: PASSWORD });
    const right = await totpCode(secret, new Date());
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++)
      expect((await c.twoFactor.verifyTotp({ code: wrong })).error).toMatchObject({
        code: "INVALID_CODE",
        status: 400,
      });
    expect((await c.twoFactor.verifyTotp({ code: wrong })).error).toMatchObject({
      code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
    });
    // The capped challenge is gone: the next call does not send it. The gated sign-in dropped the
    // enrolment's bearer (review M-6), so the shim path has no session and no cookie.
    expect((await c.twoFactor.verifyTotp({ code: right })).error).toMatchObject({
      code: "INVALID_TWO_FACTOR_COOKIE",
      status: 401,
    });
  });

  it("drops the stored bearer when the sign-in answers a challenge (review M-6)", async () => {
    const { c, storage } = await enrolled();
    expect(storage.map.get("reception_tempo_session")).toMatch(/^ts_/);
    const r = await c.signIn.email({ email: EMAIL, password: PASSWORD });
    expect(r.data).toMatchObject({ twoFactorRedirect: true });
    expect(storage.map.get("reception_tempo_session")).toBe("");
    expect(c.getCookie()).toBe("");
  });

  it("drops a dead challenge at INVALID_TWO_FACTOR_COOKIE: the next verify goes to the shim, not to core's verify", async () => {
    const { c, secret, calls } = await enrolled();
    await c.signIn.email({ email: EMAIL, password: PASSWORD });
    vi.useFakeTimers({ now: Date.now() + 300_000, toFake: ["Date"] });
    const code = await totpCode(secret, new Date());
    calls.length = 0;
    expect((await c.twoFactor.verifyTotp({ code })).error).toMatchObject({
      code: "INVALID_TWO_FACTOR_COOKIE",
    });
    expect(calls).toEqual(["/api/auth/totp/verify"]);
    calls.length = 0;
    await c.twoFactor.verifyTotp({ code });
    expect(calls).toEqual(["/api/auth/two-factor/verify-totp"]);
  });

  it("sends verifyBackupCode to the shim with no kept challenge: with a session the shim answers NOT_SUPPORTED", async () => {
    const { c, backupCodes, calls } = await enrolled();
    calls.length = 0;
    const r = await c.twoFactor.verifyBackupCode({ code: backupCodes[0] ?? "" });
    expect(r.error).toMatchObject({ code: "NOT_SUPPORTED", status: 501 });
    expect(calls).toEqual(["/api/auth/two-factor/verify-backup-code"]);
  });

  it("signs in with a backup code once, and keeps the trusted device for the next sign-in", async () => {
    const { c, backupCodes, storage } = await enrolled();
    await c.signIn.email({ email: EMAIL, password: PASSWORD });
    const v = await c.twoFactor.verifyBackupCode({ code: backupCodes[0] ?? "", trustDevice: true });
    expect(v.error).toBeNull();
    expect(storage.map.get("reception_trust_device")).toMatch(/^td_/);
    const again = await c.signIn.email({ email: EMAIL, password: PASSWORD });
    expect(again.data).toMatchObject({ token: expect.stringMatching(/^ts_/) });
    expect(
      (await c.twoFactor.verifyBackupCode({ code: "x", disableSession: true })).error,
    ).toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("answers the URI and new backup codes with the password, disables, and refuses the email code calls", async () => {
    const { c } = await enrolled();
    const uri = await c.twoFactor.getTotpUri({ password: PASSWORD });
    expect(uri.data?.totpURI.startsWith("otpauth://totp/")).toBe(true);
    const codes = await c.twoFactor.generateBackupCodes({ password: PASSWORD });
    expect(codes.data?.backupCodes).toHaveLength(10);
    expect((await c.twoFactor.disable({ password: "wrong password" })).error).toMatchObject({
      code: "INVALID_PASSWORD",
      status: 400,
    });
    expect(await c.twoFactor.disable({ password: PASSWORD })).toEqual({
      data: { status: true },
      error: null,
    });
    expect((await c.twoFactor.sendOtp()).error).toMatchObject({ code: "NOT_SUPPORTED" });
    expect((await c.twoFactor.verifyOtp({ code: "123456" })).error).toMatchObject({
      code: "NOT_SUPPORTED",
    });
  });

  it("drops the kept challenge at the next sign-in, so the enable confirm of another user takes the session path", async () => {
    const { c, register } = await enrolled();
    // A gated sign-in keeps a challenge for Pat.
    expect((await c.signIn.email({ email: EMAIL, password: PASSWORD })).data).toMatchObject({
      twoFactorRedirect: true,
    });
    await register(OTHER, "Sam");
    const sam = await c.signIn.email({ email: OTHER, password: PASSWORD });
    if (!sam.data || !("token" in sam.data)) throw new Error("Sam has no session");
    const enabled = await c.twoFactor.enable({ password: PASSWORD });
    if (!enabled.data) throw new Error(enabled.error?.code);
    const secret = base32Decode(new URL(enabled.data.totpURI).searchParams.get("secret") ?? "");
    const confirm = await c.twoFactor.verifyTotp({ code: await totpCode(secret, new Date()) });
    expect(confirm).toEqual({
      data: {
        token: sam.data.token,
        user: { id: sam.data.user.id, name: "Sam", email: OTHER, emailVerified: true, image: null },
      },
      error: null,
    });
  });

  it("sends the browser to a relative or https twoFactorPage, and never to another scheme", async () => {
    const location = { href: "https://app.example.com/sign-in" };
    vi.stubGlobal("location", location);
    const safe = await enrolled({ twoFactorPage: "/two-factor" });
    await safe.c.signIn.email({ email: EMAIL, password: PASSWORD });
    expect(location.href).toBe("/two-factor");
    location.href = "https://app.example.com/sign-in";
    const unsafe = await enrolled({ twoFactorPage: "javascript:alert(1)" });
    const r = await unsafe.c.signIn.email({ email: EMAIL, password: PASSWORD });
    expect(r.data).toMatchObject({ twoFactorRedirect: true });
    expect(location.href).toBe("https://app.example.com/sign-in");
  });
});
