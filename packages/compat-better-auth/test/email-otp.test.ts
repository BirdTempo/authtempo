import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import readme from "../README.md?raw";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, COMPAT_PLUGIN, emailOTP } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { EMAIL_OTP_NOT_SUPPORTED } from "../src/server/email-otp.js";
import { mapOptions } from "../src/server/map-options.js";
import { USER_KEYS } from "../src/server/shapes.js";
import type { BetterAuthOptions, CompatDatabase, EmailOtpOptions } from "../src/types.js";

const BASE = "https://api.example.com";
const EMAIL = "otp@example.com";
type Sent = { email: string; otp: string; type: string };

function memoryDatabase(): CompatDatabase {
  return {
    kind: "tempo-auth-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}

/** Options with the plugin; `sent` collects every call of sendVerificationOTP. */
function options(otp: Partial<EmailOtpOptions>, sent: Sent[] = []): BetterAuthOptions {
  return {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database: memoryDatabase(),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      sendResetPassword: async () => {},
    },
    emailVerification: { sendVerificationEmail: async () => {} },
    plugins: [
      emailOTP({
        ...otp,
        sendVerificationOTP: async (d) => {
          sent.push(d);
        },
      }),
      bearer(),
    ],
    tempoAuth: {
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  };
}

function app(otp: Partial<EmailOtpOptions> = {}) {
  const sent: Sent[] = [];
  const auth = betterAuth(options(otp, sent));
  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify(body),
      }),
    );
  return { auth, sent, post };
}

const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("the email-otp options (plan 9e)", () => {
  it("maps consumerd's options onto core's emailOtp, and rounds expiresIn up to whole minutes (Review Focus)", () => {
    const emailOtp = (otp: Partial<EmailOtpOptions>) => mapOptions(options(otp)).config.emailOtp;
    expect(
      emailOtp({ otpLength: 6, expiresIn: 600, allowedAttempts: 5, storeOTP: "hashed" }),
    ).toMatchObject({ ttlMinutes: 10, length: 6, maxAttempts: 5 });
    expect(emailOtp({ expiresIn: 90 })).toMatchObject({ ttlMinutes: 2 });
    expect(emailOtp({ otpLength: 8, expiresIn: 3600 })).toMatchObject({
      ttlMinutes: 60,
      length: 8,
    });
    // Better Auth 1.7.2's defaults: 300 s and 3 attempts.
    expect(emailOtp({})).toMatchObject({ ttlMinutes: 5, length: 6, maxAttempts: 3 });
    expect(mapOptions({ ...options({}), plugins: [] }).config.emailOtp).toBe(false);
  });

  it("refuses each option core cannot keep, by name", () => {
    const send = async () => {};
    const refusalsFor = (otp: Record<string, unknown>) =>
      checkOptions({
        ...options({}),
        plugins: [{ kind: COMPAT_PLUGIN, id: "email-otp", options: otp } as never],
      }).refusals;
    const STORE =
      "plugins[email-otp].storeOTP: core stores a keyed hash; pass hashed or leave it out";
    expect(
      refusalsFor({
        sendVerificationOTP: send,
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: "hashed",
      }),
    ).toEqual([]);
    expect(
      refusalsFor({
        sendVerificationOTP: send,
        otpLength: 8,
        expiresIn: 60,
        allowedAttempts: 3,
        disableSignUp: false,
        overrideDefaultEmailVerification: false,
        sendVerificationOnSignUp: false,
        resendStrategy: "rotate",
      }),
    ).toEqual([]);
    expect(
      refusalsFor({
        otpLength: 7,
        expiresIn: 30,
        allowedAttempts: 11,
        storeOTP: "plain",
        generateOTP: () => "123456",
        disableSignUp: true,
        overrideDefaultEmailVerification: true,
        sendVerificationOnSignUp: true,
        resendStrategy: "reuse",
        changeEmail: { enabled: true },
        rateLimit: { window: 60, max: 3 },
        other: 1,
      }),
    ).toEqual([
      "plugins[email-otp].allowedAttempts: core takes 3 to 10",
      "plugins[email-otp].changeEmail: core has no change of address by code; see the plan index",
      "plugins[email-otp].disableSignUp: core creates the user at the first code",
      "plugins[email-otp].expiresIn: core takes 60 to 3600 seconds, rounded up to whole minutes",
      "plugins[email-otp].generateOTP: core makes the code itself, from crypto.getRandomValues",
      "plugins[email-otp].other: tempo-auth has no such option",
      "plugins[email-otp].otpLength: core generates 6 or 8 digits",
      "plugins[email-otp].overrideDefaultEmailVerification: core's verify mail is a link; a code for it is a later input (see the plan index)",
      "plugins[email-otp].rateLimit: core's owned limiter has fixed limits per flow",
      "plugins[email-otp].resendStrategy: core sends a new code at every request",
      "plugins[email-otp].sendVerificationOTP: required",
      "plugins[email-otp].sendVerificationOnSignUp: core mails a verify link at sign-up, not a code",
      STORE,
    ]);
    expect(refusalsFor({ sendVerificationOTP: send, storeOTP: "encrypted" })).toEqual([STORE]);
    expect(
      refusalsFor({ sendVerificationOTP: send, storeOTP: { hash: async (s: string) => s } }),
    ).toEqual([STORE]);
    expect(refusalsFor({ sendVerificationOTP: send, expiresIn: 3601 })).toEqual([
      "plugins[email-otp].expiresIn: core takes 60 to 3600 seconds, rounded up to whole minutes",
    ]);
  });

  it("says in the README that 90 seconds live 2 minutes", () => {
    expect(readme).toContain("`expiresIn: 90` lives 2 minutes");
  });
});

describe("Better Auth's email OTP paths (plan 9e)", () => {
  it("sends the sign-in code through sendVerificationOTP with type sign-in, and signs in on /sign-in/email-otp in Better Auth's shape (Review Focus 5)", async () => {
    const { sent, post } = app();
    const res = await post("/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ success: true });
    expect(sent).toEqual([
      { email: EMAIL, otp: expect.stringMatching(/^\d{6}$/), type: "sign-in" },
    ]);
    const signedIn = await post("/sign-in/email-otp", { email: EMAIL, otp: sent[0]?.otp });
    expect(signedIn.status).toBe(200);
    const body = await json(signedIn);
    expect(Object.keys(body).sort()).toEqual(["token", "user"]);
    expect(body.token).toMatch(/^ts_/);
    expect(Object.keys(body.user as object).sort()).toEqual([...USER_KEYS].sort());
    expect(body.user).toMatchObject({ email: EMAIL, emailVerified: true, name: "" });
    expect(signedIn.headers.get("set-cookie")).toContain(`tempo_session=${body.token}`);
    expect(signedIn.headers.get("set-auth-token")).toBe(body.token);
  });

  it("answers Better Auth's codes: a wrong code 400 INVALID_OTP, and the cap 400 TOO_MANY_ATTEMPTS", async () => {
    const { sent, post } = app({ allowedAttempts: 3 });
    await post("/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" });
    const wrong = wrongFor(sent[0]?.otp ?? "");
    for (let i = 0; i < 2; i++) {
      const res = await post("/sign-in/email-otp", { email: EMAIL, otp: wrong });
      expect({ status: res.status, body: await json(res) }).toEqual({
        status: 400,
        body: { code: "INVALID_OTP", message: "Invalid otp" },
      });
    }
    const capped = await post("/sign-in/email-otp", { email: EMAIL, otp: wrong });
    expect({ status: capped.status, body: await json(capped) }).toEqual({
      status: 400,
      body: { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts" },
    });
  });

  it("sends the reset code with type forget-password from each of the three request paths, and resets on /email-otp/reset-password (Review Focus 5)", async () => {
    const { auth, sent, post } = app();
    await auth.api.signUpEmail({
      body: { email: EMAIL, password: "correct horse battery", name: "Pat" },
    });
    for (const [path, body] of [
      ["/email-otp/send-verification-otp", { email: EMAIL, type: "forget-password" }],
      ["/forget-password/email-otp", { email: EMAIL }],
      ["/email-otp/request-password-reset", { email: EMAIL }],
    ] as const) {
      const res = await post(path, body);
      expect({ path, status: res.status, body: await json(res) }).toEqual({
        path,
        status: 200,
        body: { success: true },
      });
    }
    expect(sent.map((s) => s.type)).toEqual([
      "forget-password",
      "forget-password",
      "forget-password",
    ]);
    const reset = await post("/email-otp/reset-password", {
      email: EMAIL,
      otp: sent.at(-1)?.otp,
      password: "a new correct horse",
    });
    expect(reset.status).toBe(200);
    expect(await json(reset)).toEqual({ success: true });
    // The compat reset opens a session (a plan deviation): the cookie carries it.
    const cookie = /tempo_session=(ts_[^;]+)/.exec(reset.headers.get("set-cookie") ?? "")?.[1];
    expect(cookie).toMatch(/^ts_/);
    const me = await auth.api.getSession({
      headers: new Headers({ cookie: `tempo_session=${cookie}` }),
    });
    expect(me?.user.email).toBe(EMAIL);
    const signedIn = await auth.api.signInEmail({
      body: { email: EMAIL, password: "a new correct horse" },
    });
    expect(signedIn.user.email).toBe(EMAIL);
  });

  it("sends no reset code to an address with no user, and answers success, as Better Auth does", async () => {
    const { sent, post } = app();
    const res = await post("/forget-password/email-otp", { email: "nobody@example.com" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ success: true });
    expect(sent).toEqual([]);
  });

  it("answers 400 INVALID_EMAIL for a malformed address on send-verification-otp, as Better Auth does", async () => {
    const { sent, post } = app();
    const res = await post("/email-otp/send-verification-otp", {
      email: "not-an-email",
      type: "sign-in",
    });
    expect({ status: res.status, body: await json(res) }).toEqual({
      status: 400,
      body: { code: "INVALID_EMAIL", message: "Invalid email" },
    });
    expect(sent).toEqual([]);
  });

  it("answers PASSWORD_TOO_SHORT before the code check on /email-otp/reset-password, so the code stays usable", async () => {
    const { auth, sent, post } = app();
    await auth.api.signUpEmail({
      body: { email: EMAIL, password: "correct horse battery", name: "Pat" },
    });
    await post("/forget-password/email-otp", { email: EMAIL });
    const otp = sent.at(-1)?.otp;
    const short = await post("/email-otp/reset-password", { email: EMAIL, otp, password: "short" });
    expect({ status: short.status, body: await json(short) }).toEqual({
      status: 400,
      body: { code: "PASSWORD_TOO_SHORT", message: "Password too short" },
    });
    const res = await post("/email-otp/reset-password", {
      email: EMAIL,
      otp,
      password: "a new correct horse",
    });
    expect(res.status).toBe(200);
  });

  it("answers 501 NOT_SUPPORTED for the other paths, the other types, and a user field at sign-in", async () => {
    const { post } = app();
    for (const path of EMAIL_OTP_NOT_SUPPORTED) {
      const res = await post(path, { email: EMAIL, otp: "123456", newEmail: "b@example.com" });
      expect({ path, status: res.status, code: (await json(res)).code }).toEqual({
        path,
        status: 501,
        code: "NOT_SUPPORTED",
      });
    }
    for (const type of ["email-verification", "change-email"]) {
      const res = await post("/email-otp/send-verification-otp", { email: EMAIL, type });
      expect({ type, status: res.status }).toEqual({ type, status: 501 });
    }
    expect(
      (await post("/email-otp/send-verification-otp", { email: EMAIL, type: "other" })).status,
    ).toBe(400);
    const named = await post("/sign-in/email-otp", { email: EMAIL, otp: "123456", name: "Pat" });
    expect({ status: named.status, code: (await json(named)).code }).toEqual({
      status: 501,
      code: "NOT_SUPPORTED",
    });
    const imaged = await post("/sign-in/email-otp", {
      email: EMAIL,
      otp: "123456",
      image: "https://example.com/a.png",
    });
    expect({ status: imaged.status, body: await json(imaged) }).toEqual({
      status: 501,
      body: {
        code: "NOT_SUPPORTED",
        message: "core takes no image at the email code sign-in",
      },
    });
  });

  it("answers 404 on Better Auth's email OTP paths and core's code routes without the plugin", async () => {
    const auth = betterAuth({ ...options({}), plugins: [] });
    for (const path of [
      "/email-otp/send-verification-otp",
      "/sign-in/email-otp",
      "/email-otp/reset-password",
      "/otp/request",
    ]) {
      const res = await auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify({ email: EMAIL, type: "sign-in", otp: "123456" }),
        }),
      );
      // Core's router answers the 404, so the body is core's, not the shim's Better Auth body.
      expect({ path, status: res.status, body: await json(res) }).toEqual({
        path,
        status: 404,
        body: { error: "not_found" },
      });
    }
  });
});
