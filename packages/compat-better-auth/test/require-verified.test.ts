import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { APIError } from "../src/errors.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { betterAuth } from "../src/server/better-auth.js";
import type { CompatDatabase, EmailCallbackData } from "../src/types.js";

const BASE = "https://api.example.com";
const EMAIL = "pat@example.com";
const PASSWORD = "correct horse battery";
const fast = betterAuthPasswordHash({ pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }) });

function memoryDatabase(): CompatDatabase {
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}

/**
 * consumerb's password and verify options (apps/api/src/auth.ts lines 95 to
 * 115, read 2026-10-15), with no plugin. consumerb sets no sendOnSignIn.
 * The shim needs sendResetPassword, which consumerb does not set yet (the
 * README's consumerb list), so the test adds one.
 */
function consumerb() {
  const verifies: EmailCallbackData[] = [];
  const auth = betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database: memoryDatabase(),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async () => {},
    },
    emailVerification: {
      sendVerificationEmail: async (data) => {
        verifies.push(data);
      },
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 86400,
    },
    authtempo: { passwordHash: fast },
  });
  return { auth, verifies };
}

const signUp = (auth: ReturnType<typeof consumerb>["auth"], name = "Pat") =>
  auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name } });

describe("emailAndPassword.requireEmailVerification (plan 12b Task 15)", () => {
  it("starts with consumerb's options", () => {
    expect(() => consumerb()).not.toThrow();
  });

  it("answers { token: null, user } at sign-up with no cookie", async () => {
    const { auth, verifies } = consumerb();
    const up = await signUp(auth);
    expect(up.token).toBeNull();
    expect(up.user).toMatchObject({ email: EMAIL, name: "Pat", emailVerified: false });
    expect(verifies).toHaveLength(1);
    // The handler path: core's route answers the user and no cookie.
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/password/sign-up`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: "lee@example.com", password: PASSWORD }),
      }),
    );
    expect({ status: res.status, cookie: res.headers.get("set-cookie") }).toEqual({
      status: 200,
      cookie: null,
    });
  });

  it("answers EMAIL_NOT_VERIFIED at sign-in before the verify, and a session after", async () => {
    const { auth, verifies } = consumerb();
    await signUp(auth);
    const refused = auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD } });
    await expect(refused).rejects.toBeInstanceOf(APIError);
    await expect(refused).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "EMAIL_NOT_VERIFIED" },
    });
    expect(verifies).toHaveLength(2);
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/password/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ token: verifies[1]?.token ?? "" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/session=ts_/);
    const after = await auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD } });
    expect(after).toMatchObject({ token: expect.stringMatching(/^ts_/) });
  });

  it("answers the generic { token: null, user } for a taken address", async () => {
    const { auth, verifies } = consumerb();
    const first = await signUp(auth);
    const again = await signUp(auth, "Lee");
    expect(again.token).toBeNull();
    expect(again.user).toMatchObject({ email: EMAIL, name: "Lee", emailVerified: false });
    expect(again.user.id).not.toBe(first.user.id);
    expect(again.user.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Object.keys(again.user).sort()).toEqual(Object.keys(first.user).sort());
    expect(verifies).toHaveLength(1);
  });

  it("refuses emailVerification.sendOnSignIn: false at start", () => {
    expect(() =>
      betterAuth({
        baseURL: BASE,
        secret: "0123456789abcdef0123456789abcdef",
        database: memoryDatabase(),
        emailAndPassword: {
          enabled: true,
          requireEmailVerification: true,
          sendResetPassword: async () => {},
        },
        emailVerification: { sendVerificationEmail: async () => {}, sendOnSignIn: false },
      }),
    ).toThrowError(
      "emailVerification.sendOnSignIn: core sends a new verify link at each unverified sign-in, at most 3 per 15 minutes",
    );
  });
});
