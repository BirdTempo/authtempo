import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { requestEmailOtp, verifyEmailOtp } from "../src/engine/email-otp.js";
import { requestReauthCode } from "../src/engine/reauth.js";
import { SETUP_PER_USER } from "../src/engine/second-factor.js";
import { enableTotp, setupTotp } from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { base32Decode } from "../src/primitives/totp.js";
import { makeAuth, post, recordCredential, sessionFor } from "./helpers.js";
import {
  type Auth,
  codeNow,
  EMAIL,
  PASSWORD,
  totpAuth,
  verifiedSession,
  wrongFor,
} from "./totp-helpers.js";

/** A deployment with no password: the email code signs in, and `totp` is set. */
const noPassword = () => makeAuth({ totp: {} });

/** The 6-digit code of the last mail. */
const mailed = (auth: Auth) =>
  recordCredential(/\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "");

/** A verified user with no password row, and a session of that user. */
async function staff(auth: Auth, email = EMAIL) {
  const user = await auth.seedUser(email);
  return sessionFor(auth.config, user);
}

const totpRows = (auth: Auth, userId: string) =>
  auth.storage.findMany("totp", [{ field: "userId", op: "eq", value: userId }]);

describe("the config of totp with no password", () => {
  const base = {
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: ["https://app.example.com"],
    storage: makeAuth().storage,
    mail: { send: async () => {} },
  };

  it("stays off when totp is absent, so an upgrade turns nothing on", () => {
    expect(resolveConfig(base).totp).toBeNull();
  });

  it("turns on when totp is set and the email code is on", () => {
    expect(resolveConfig({ ...base, totp: {} }).totp).not.toBeNull();
  });

  it("refuses totp with neither password nor emailOtp: no proof exists for the setup", () => {
    expect(() => resolveConfig({ ...base, totp: {}, emailOtp: false })).toThrowError(
      "totp needs password or emailOtp: the setup proves the person with the password or with an email code, and a session alone must not set up the factor",
    );
  });
});

describe("the setup of TOTP with an email code", () => {
  it("sets up and enables the factor with no password, and the email code sign-in then asks for the factor", async () => {
    const auth = noPassword();
    const session = await staff(auth);
    expect((await requestReauthCode(auth.config, { session })).ok).toBe(true);
    const setup = await setupTotp(auth.config, { session, emailCode: mailed(auth), ip: null });
    if (!setup.ok) throw new Error(setup.code);
    recordCredential(setup.value.secret);
    for (const code of setup.value.backupCodes) recordCredential(code);
    expect(setup.value.backupCodes).toHaveLength(10);
    const secret = base32Decode(setup.value.secret);
    const enabled = await enableTotp(auth.config, { session, code: await codeNow(auth, secret) });
    expect(enabled).toMatchObject({ ok: true, value: { enabled: true, methods: ["totp"] } });
    // The staff rule: the email code alone opens no session now.
    expect((await requestEmailOtp(auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
    const signIn = await verifyEmailOtp(auth.config, {
      email: EMAIL,
      code: mailed(auth),
      ip: null,
      userAgent: null,
    });
    if (!signIn.ok) throw new Error(signIn.code);
    expect("twoFactor" in signIn.value).toBe(true);
    expect("token" in signIn.value).toBe(false);
  });

  it("spends the code: a second setup with the same code answers invalid_code", async () => {
    const auth = noPassword();
    const session = await staff(auth);
    await requestReauthCode(auth.config, { session });
    const code = mailed(auth);
    expect((await setupTotp(auth.config, { session, emailCode: code, ip: null })).ok).toBe(true);
    expect(await setupTotp(auth.config, { session, emailCode: code, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_code",
    });
  });

  it("refuses a wrong code and a code that no request mailed, and writes no row", async () => {
    const auth = noPassword();
    const session = await staff(auth);
    // No code was mailed: a session alone sets up nothing.
    expect(await setupTotp(auth.config, { session, emailCode: "123456", ip: null })).toMatchObject({
      ok: false,
      code: "invalid_code",
    });
    await requestReauthCode(auth.config, { session });
    const wrong = wrongFor(mailed(auth));
    expect(await setupTotp(auth.config, { session, emailCode: wrong, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_code",
    });
    expect(await totpRows(auth, session.user.id)).toEqual([]);
  });

  it("answers invalid_body for no proof and for two proofs, and counts no try", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    for (let i = 0; i < SETUP_PER_USER.max + 1; i++) {
      // A session alone: the case that the rule exists for.
      expect(await setupTotp(auth.config, { session })).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
      expect(
        await setupTotp(auth.config, { session, password: PASSWORD, emailCode: "123456" }),
      ).toMatchObject({ ok: false, code: "invalid_body" });
    }
    expect(await totpRows(auth, session.user.id)).toEqual([]);
    expect((await setupTotp(auth.config, { session, password: PASSWORD })).ok).toBe(true);
  });

  it("refuses the code of another user", async () => {
    const auth = noPassword();
    const ada = await staff(auth);
    const bob = await staff(auth, "bob@example.com");
    await requestReauthCode(auth.config, { session: bob });
    const bobs = mailed(auth);
    expect(await setupTotp(auth.config, { session: ada, emailCode: bobs, ip: null })).toMatchObject(
      { ok: false, code: "invalid_code" },
    );
    expect(await totpRows(auth, ada.user.id)).toEqual([]);
  });

  it("answers not_found for the password proof with no password config, and counts no try", async () => {
    const auth = noPassword();
    const session = await staff(auth);
    for (let i = 0; i < SETUP_PER_USER.max + 1; i++)
      expect(await setupTotp(auth.config, { session, password: PASSWORD })).toMatchObject({
        ok: false,
        code: "not_found",
      });
    // The limit key is still empty: a right code passes.
    await requestReauthCode(auth.config, { session });
    expect((await setupTotp(auth.config, { session, emailCode: mailed(auth), ip: null })).ok).toBe(
      true,
    );
  });

  it("answers not_found for the email code with emailOtp off, and the password still passes", async () => {
    const auth = totpAuth({ emailOtp: false });
    const session = await verifiedSession(auth);
    expect(await setupTotp(auth.config, { session, emailCode: "123456", ip: null })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect((await setupTotp(auth.config, { session, password: PASSWORD })).ok).toBe(true);
  });

  it("takes the email code in a deployment with a password too", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    await requestReauthCode(auth.config, { session });
    expect((await setupTotp(auth.config, { session, emailCode: mailed(auth), ip: null })).ok).toBe(
      true,
    );
  });

  it("counts each wrong code on the setup key of the user, then answers rate_limited", async () => {
    const auth = noPassword();
    const session = await staff(auth);
    await requestReauthCode(auth.config, { session });
    const code = mailed(auth);
    // Each try has its own IP, so the per-IP verify key of a mailed code does not answer first.
    for (let i = 0; i < SETUP_PER_USER.max; i++)
      expect(
        await setupTotp(auth.config, { session, emailCode: wrongFor(code), ip: `10.0.0.${i}` }),
      ).toMatchObject({ ok: false });
    expect(
      await setupTotp(auth.config, { session, emailCode: code, ip: "10.0.1.1" }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await totpRows(auth, session.user.id)).toEqual([]);
  });

  it("refuses an unverified user after a right code", async () => {
    const auth = noPassword();
    const user = await auth.seedUser(EMAIL);
    await auth.storage.update("user", [{ field: "id", op: "eq", value: user.id }], {
      emailVerified: false,
    });
    const session = await sessionFor(auth.config, { ...user, emailVerified: false });
    await requestReauthCode(auth.config, { session });
    expect(
      await setupTotp(auth.config, { session, emailCode: mailed(auth), ip: null }),
    ).toMatchObject({ ok: false, code: "email_unverified" });
  });
});

describe("POST /totp/setup with one proof", () => {
  async function routed() {
    const auth = noPassword();
    const session = await staff(auth);
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const bearer = { authorization: `Bearer ${session.token}` };
    const call = async (path: string, body: unknown) => {
      const res = await handle(post(path, body, bearer));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { auth, session, call };
  }

  it("mails the code at POST /reauth/email and sets up the factor with it", async () => {
    const { auth, call } = await routed();
    expect(await call("/auth/reauth/email", {})).toEqual({ status: 200, body: { sent: true } });
    const setup = await call("/auth/totp/setup", { emailCode: mailed(auth) });
    expect(setup.status).toBe(200);
    expect(Object.keys(setup.body).sort()).toEqual(["backupCodes", "secret", "uri"]);
    recordCredential(setup.body.secret as string);
    for (const code of setup.body.backupCodes as string[]) recordCredential(code);
  });

  it("answers invalid_body for no proof and for two proofs, and counts no try", async () => {
    const { auth, session, call } = await routed();
    await call("/auth/reauth/email", {});
    const code = mailed(auth);
    for (let i = 0; i < SETUP_PER_USER.max + 1; i++) {
      expect(await call("/auth/totp/setup", {})).toEqual({
        status: 400,
        body: { error: "invalid_body" },
      });
      expect(await call("/auth/totp/setup", { password: PASSWORD, emailCode: code })).toEqual({
        status: 400,
        body: { error: "invalid_body" },
      });
    }
    expect(await totpRows(auth, session.user.id)).toEqual([]);
    expect((await call("/auth/totp/setup", { emailCode: code })).status).toBe(200);
  });

  it("answers too_many_attempts after the guesses of one code are spent", async () => {
    // With the default of 5 guesses the setup key (5 per 15 minutes) answers first.
    // A lower cap, or guesses at POST /reauth on the same code, reach this answer.
    const auth = makeAuth({ totp: {}, emailOtp: { maxAttempts: 3 } });
    const session = await staff(auth);
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const bearer = { authorization: `Bearer ${session.token}` };
    const call = async (path: string, body: unknown) => {
      const res = await handle(post(path, body, bearer));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    await call("/auth/reauth/email", {});
    const code = mailed(auth);
    for (let i = 0; i < 3; i++)
      expect((await call("/auth/totp/setup", { emailCode: wrongFor(code) })).status).toBe(400);
    // The right code comes too late: the cap spent the row.
    expect(await call("/auth/totp/setup", { emailCode: code })).toEqual({
      status: 400,
      body: { error: "too_many_attempts" },
    });
    expect(await totpRows(auth, session.user.id)).toEqual([]);
  });

  it("answers invalid_code for a wrong code", async () => {
    const { auth, call } = await routed();
    await call("/auth/reauth/email", {});
    expect(await call("/auth/totp/setup", { emailCode: wrongFor(mailed(auth)) })).toEqual({
      status: 400,
      body: { error: "invalid_code" },
    });
  });
});
