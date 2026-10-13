import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@tempo-auth/core";
import { base32Decode, totpCode } from "@tempo-auth/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient, expoClient, twoFactorClient } from "../src/client/index.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, twoFactor } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import type { CompatDatabase } from "../src/types.js";

const BASE = "https://api.example.com";
const EMAIL = "pat@example.com";
const PASSWORD = "correct horse battery";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

/** A server with the plugin, and an Expo client: the token lives in storage, so no cookie jar is needed. */
async function setup(onTwoFactorRedirect = vi.fn()) {
  const links: string[] = [];
  const database: CompatDatabase = {
    kind: "tempo-auth-compat-database",
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
    tempoAuth: {
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  });
  const fetchImpl: typeof fetch = async (input, init) => auth.handler(new Request(input, init));
  const storage = memoryStorage();
  const c = createAuthClient({
    baseURL: BASE,
    basePath: "/api/auth",
    plugins: [
      expoClient({ scheme: "reception", storagePrefix: "reception", storage }),
      twoFactorClient({ onTwoFactorRedirect }),
    ],
    fetchOptions: { customFetchImpl: fetchImpl },
  });
  await c.signUp.email({ email: EMAIL, password: PASSWORD, name: "Pat" });
  await auth.handler(
    new Request(`${BASE}/api/auth/password/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ token: links.at(-1) }),
    }),
  );
  // The verify claims the address and ends the sign-up session: sign in again.
  const signedIn = await c.signIn.email({ email: EMAIL, password: PASSWORD });
  if (signedIn.error) throw new Error(signedIn.error.code);
  return { auth, c, storage, onTwoFactorRedirect };
}

/** The factor on through the client: enable with the password, then verifyTotp with the session. */
async function enrolled() {
  const s = await setup();
  const enabled = await s.c.twoFactor.enable({ password: PASSWORD });
  if (!enabled.data) throw new Error(enabled.error?.code);
  const secret = base32Decode(new URL(enabled.data.totpURI).searchParams.get("secret") ?? "");
  const confirm = await s.c.twoFactor.verifyTotp({ code: await totpCode(secret, new Date()) });
  if (confirm.error) throw new Error(confirm.error.code);
  return { ...s, secret, backupCodes: enabled.data.backupCodes };
}

afterEach(() => {
  vi.useRealTimers();
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
});
