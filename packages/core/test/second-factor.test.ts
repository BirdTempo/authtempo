import { describe, expect, it } from "vitest";
import { requestEmailOtp } from "../src/engine/email-otp.js";
import { defaultSecondFactorMail } from "../src/engine/email-otp-mail.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { passwordSignIn, passwordSignUp } from "../src/engine/password.js";
import { factorRow } from "../src/engine/second-factor.js";
import {
  disableMethod,
  enableEmailMethod,
  enableMethod,
  enablePasskeyMethod,
  passkeyChallengeOptions,
  sendSecondFactorEmail,
} from "../src/engine/second-factor-methods.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import {
  disableTotp,
  disableTotpWithCode,
  enableTotp,
  regenerateBackupCodesWithCode,
  setupTotp,
  totpStatus,
  verifyTwoFactor,
} from "../src/engine/totp.js";
import { MAILED_CODES_PER_EMAIL_DAY } from "../src/engine/verification.js";
import { hmacSha256Hex } from "../src/primitives/crypto.js";
import { currentSecret } from "../src/primitives/keyring.js";
import { base32Decode, normalizeBackupCode } from "../src/primitives/totp.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { tokenFromMail } from "./helpers.js";
import { upSession } from "./password-helpers.js";
import {
  type Auth,
  codeNow,
  EMAIL,
  enrolled,
  PASSWORD,
  totpAuth,
  verifiedSession,
} from "./totp-helpers.js";

/** A backup code of 23 characters of core's alphabet, shown as 5-5-5-4-4. */
const GROUPED =
  /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/;

describe("the factor row (plan 12c)", () => {
  it("writes the row at the first enable with the totp row's id, version 2, and the hashes of the codes with no dash", async () => {
    const auth = totpAuth();
    const { user, backupCodes } = await enrolled(auth);
    expect(backupCodes).toHaveLength(10);
    for (const c of backupCodes) expect(c).toMatch(GROUPED);
    const [totp] = await auth.storage.findMany("totp", []);
    const [factor] = await auth.storage.findMany("secondFactor", []);
    expect(factor).toMatchObject({
      id: totp?.id,
      userId: user.id,
      methods: ["totp"],
      backupCodesVersion: 2,
    });
    expect(factor?.backupCodes).toEqual(
      await Promise.all(
        backupCodes.map((c) =>
          hmacSha256Hex(
            currentSecret(auth.config.keyring),
            `${factor?.id}:${normalizeBackupCode(c)}`,
          ),
        ),
      ),
    );
    // The totp row keeps the secret only. Its backup code column is unread from version 8 on.
    expect(totp?.backupCodes).toEqual([]);
  });

  it("lets a version 1 list of 8 characters pass until it is replaced, and the replacement writes version 2", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    const [factor] = await auth.storage.findMany("secondFactor", []);
    if (!factor) throw new Error("no factor row");
    // The list that migration 0008 copies from a plan 9f row: 8 characters, version 1.
    const old = "abcd2345";
    await auth.storage.update("secondFactor", [{ field: "id", op: "eq", value: factor.id }], {
      backupCodes: [await hmacSha256Hex(currentSecret(auth.config.keyring), `${factor.id}:${old}`)],
      backupCodesVersion: 1,
    });
    expect(await totpStatus(auth.config, { userId: user.id })).toMatchObject({
      ok: true,
      value: { backupCodesLeft: 1, backupCodesVersion: 1 },
    });
    const r = await regenerateBackupCodesWithCode(auth.config, { user, code: old });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.backupCodes[0]).toMatch(GROUPED);
    expect(await totpStatus(auth.config, { userId: user.id })).toMatchObject({
      ok: true,
      value: { backupCodesLeft: 10, backupCodesVersion: 2 },
    });
    expect(await regenerateBackupCodesWithCode(auth.config, { user, code: old })).toMatchObject({
      code: "invalid_code",
    });
  });

  it("turns every method off at the in-process disable: the rows, the trusted devices, and the challenges go", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    const at = auth.clock.now();
    await auth.storage.create("trustedDevice", {
      id: "d1",
      userId: user.id,
      tokenHash: "h-d1",
      expiresAt: new Date(at.getTime() + 60_000),
      lastSeenAt: at,
      createdAt: at,
      updatedAt: at,
    });
    await auth.storage.create("verification", {
      id: "c1",
      purpose: "two-factor",
      identifier: user.id,
      valueHash: "h-c1",
      expiresAt: new Date(at.getTime() + 60_000),
      consumedAt: null,
      data: { attempts: 0 },
      createdAt: at,
      updatedAt: at,
      secretVersion: 1,
    });
    expect(await disableTotp(auth.config, { userId: user.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    for (const model of ["totp", "secondFactor", "trustedDevice"] as const)
      expect(
        await auth.storage.findMany(model, [{ field: "userId", op: "eq", value: user.id }]),
      ).toEqual([]);
    expect(
      await auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "two-factor" },
      ]),
    ).toEqual([]);
  });

  it("keeps a setup that is not confirmed when the in-process disable finds the factor off, and writes nothing", async () => {
    const auth = totpAuth();
    const { user } = await verifiedSession(auth);
    const setup = await setupTotp(auth.config, { userId: user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    const [before] = await auth.storage.findMany("totp", []);
    expect(await disableTotp(auth.config, { userId: user.id })).toMatchObject({
      code: "totp_not_enabled",
    });
    expect(await auth.storage.findMany("totp", [])).toEqual([before]);
  });
});

const RP = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };

/** A verified user with a password and one registered passkey. */
async function withPasskey(auth: Auth, email = EMAIL) {
  const session = await verifiedSession(auth, email);
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
  const options = await passkeyRegistrationOptions(auth.config, { user: session.user });
  if (!options.ok) throw new Error(options.code);
  const registered = await verifyPasskeyRegistration(auth.config, {
    user: session.user,
    response: await soft.register(
      options.value.challenge,
      new TextEncoder().encode(session.user.id),
    ),
  });
  if (!registered.ok) throw new Error(registered.code);
  return { session, soft };
}

/** A sign-in assertion of `soft`: the enable's proof that the person holds the passkey now. */
async function signInAssertion(auth: Auth, soft: SoftAuthenticator) {
  const options = await passkeyAuthenticationOptions(auth.config, { ip: null });
  if (!options.ok) throw new Error(options.code);
  return soft.authenticate(options.value.challenge);
}

describe("a passkey as a second-factor method (plan 12c)", () => {
  it("turns the method on with the password and a sign-in assertion; as the first method it makes the codes and ends the other sessions", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, soft } = await withPasskey(auth);
    const other = await verifiedSession(auth);
    const r = await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.methods).toEqual(["passkey"]);
    expect(r.value.backupCodes).toHaveLength(10);
    for (const c of r.value.backupCodes) expect(c).toMatch(GROUPED);
    expect(
      await auth.storage.findOne("session", [{ field: "id", op: "eq", value: other.session.id }]),
    ).toBeNull();
    expect(
      await auth.storage.findOne("session", [{ field: "id", op: "eq", value: session.session.id }]),
    ).not.toBeNull();
  });

  it("refuses a wrong password and an assertion of another user's passkey, and writes no row", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, soft } = await withPasskey(auth);
    expect(
      await enablePasskeyMethod(auth.config, {
        session,
        password: "not the password",
        response: await signInAssertion(auth, soft),
      }),
    ).toMatchObject({ code: "invalid_credentials" });
    // Bea holds a passkey of her own, so only the owner check of the
    // assertion refuses Ada's passkey here, not the count of Bea's passkeys.
    const { session: other } = await withPasskey(auth, "bea@example.com");
    expect(
      await enablePasskeyMethod(auth.config, {
        session: other,
        password: PASSWORD,
        response: await signInAssertion(auth, soft),
      }),
    ).toMatchObject({ code: "passkey_failed" });
    expect(await auth.storage.findMany("secondFactor", [])).toEqual([]);
  });

  it("lists passkey first at the sign-in, and the verify with an assertion of the bound options opens the session", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, soft } = await withPasskey(auth);
    const on = await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    if (!on.ok) throw new Error(on.code);
    const first = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    expect(first.value.twoFactor.methods).toEqual(["passkey", "backup"]);
    const options = await passkeyChallengeOptions(auth.config, {
      challenge: first.value.twoFactor.challenge,
      ip: null,
    });
    if (!options.ok) throw new Error(options.code);
    expect(options.value.allowCredentials?.map((c) => c.id)).toEqual([soft.credentialId]);
    expect(options.value.userVerification).toBe("required");
    const v = await verifyTwoFactor(auth.config, {
      challenge: first.value.twoFactor.challenge,
      passkey: await soft.authenticate(options.value.challenge),
      ip: null,
    });
    expect(v.ok).toBe(true);
  });

  it("a passkey verify passes after the user's code budget is spent", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, soft } = await withPasskey(auth);
    const on = await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    if (!on.ok) throw new Error(on.code);
    const first = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    // Spend the per-user code budget of 15 minutes: a code check now answers rate_limited.
    const key = `totp-code:user:${session.user.id}`;
    let spent = 0;
    while (spent < 100 && (await auth.config.limiter.allow(key, { seconds: 900, max: 10 })))
      spent++;
    expect(spent).toBeLessThan(100);
    expect(
      await verifyTwoFactor(auth.config, {
        challenge: first.value.twoFactor.challenge,
        backupCode: on.value.backupCodes[0] ?? "",
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    // A passkey assertion is no guess: it counts on the challenge only (spec 8.14 item 2).
    const options = await passkeyChallengeOptions(auth.config, {
      challenge: first.value.twoFactor.challenge,
      ip: null,
    });
    if (!options.ok) throw new Error(options.code);
    const v = await verifyTwoFactor(auth.config, {
      challenge: first.value.twoFactor.challenge,
      passkey: await soft.authenticate(options.value.challenge),
      ip: null,
    });
    expect(v.ok).toBe(true);
  });

  it("refuses at one challenge an assertion of another challenge's options, and counts it on the challenge", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, soft } = await withPasskey(auth);
    await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    const challengeOf = async () => {
      const r = await passwordSignIn(auth.config, {
        email: EMAIL,
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });
      if (!r.ok || !("twoFactor" in r.value)) throw new Error("no challenge");
      return r.value.twoFactor.challenge;
    };
    const a = await challengeOf();
    const b = await challengeOf();
    const options = await passkeyChallengeOptions(auth.config, { challenge: a, ip: null });
    if (!options.ok) throw new Error(options.code);
    const v = await verifyTwoFactor(auth.config, {
      challenge: b,
      passkey: await soft.authenticate(options.value.challenge),
      ip: null,
    });
    expect(v).toMatchObject({ ok: false, code: "invalid_code" });
    const rows = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "two-factor" },
    ]);
    expect(rows.map((r) => (r.data as { attempts?: number } | null)?.attempts).sort()).toEqual([
      0, 1,
    ]);
  });

  it("refuses a proof of a method that the challenge does not offer with invalid_body, and counts nothing", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, soft } = await withPasskey(auth);
    await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    const first = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    // The TOTP method is off for this user, so a 6-digit code is no proof here.
    expect(
      await verifyTwoFactor(auth.config, {
        challenge: first.value.twoFactor.challenge,
        code: "123456",
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    const [row] = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "two-factor" },
    ]);
    expect((row?.data as { attempts?: number } | null)?.attempts).toBe(0);
  });

  it("disables the method with the password; the last method turns the factor off", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, soft } = await withPasskey(auth);
    await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    expect(
      await disableMethod(auth.config, {
        user: session.user,
        method: "passkey",
        password: "not the password",
      }),
    ).toMatchObject({ code: "invalid_credentials" });
    expect(
      await disableMethod(auth.config, {
        user: session.user,
        method: "passkey",
        password: PASSWORD,
      }),
    ).toEqual({ ok: true, value: { ok: true, methods: [] } });
    expect(await auth.storage.findMany("secondFactor", [])).toEqual([]);
    expect(
      await disableMethod(auth.config, {
        user: session.user,
        method: "passkey",
        password: PASSWORD,
      }),
    ).toMatchObject({ code: "totp_not_enabled" });
  });

  it("refuses at the verify an assertion by another user's passkey over this challenge's options, and counts it on the challenge", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, soft } = await withPasskey(auth);
    const on = await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    if (!on.ok) throw new Error(on.code);
    // Bea holds a registered passkey at the same relying party.
    const { soft: beaSoft } = await withPasskey(auth, "bea@example.com");
    const first = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    const options = await passkeyChallengeOptions(auth.config, {
      challenge: first.value.twoFactor.challenge,
      ip: null,
    });
    if (!options.ok) throw new Error(options.code);
    const sessionsBefore = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: session.user.id },
    ]);
    expect(
      await verifyTwoFactor(auth.config, {
        challenge: first.value.twoFactor.challenge,
        passkey: await beaSoft.authenticate(options.value.challenge),
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_code" });
    const [row] = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "two-factor" },
    ]);
    expect((row?.data as { attempts?: number } | null)?.attempts).toBe(1);
    expect(
      await auth.storage.findMany("session", [
        { field: "userId", op: "eq", value: session.user.id },
      ]),
    ).toHaveLength(sessionsBefore.length);
  });

  it("refuses an unverified user with email_unverified before the password and the assertion, and writes no row", async () => {
    const auth = totpAuth({ passkey: RP });
    // An unverified user cannot register a passkey, so Ada's assertion stands
    // in. Without the check, the enable answers passkey_failed instead.
    const { soft } = await withPasskey(auth);
    const up = await passwordSignUp(auth.config, {
      email: "bea@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const bea = await resolveSession(auth.config, upSession(up.value).token);
    if (!bea) throw new Error("no session");
    expect(bea.user.emailVerified).toBe(false);
    expect(
      await enablePasskeyMethod(auth.config, {
        session: bea,
        password: PASSWORD,
        response: await signInAssertion(auth, soft),
      }),
    ).toEqual({ ok: false, code: "email_unverified", status: 403 });
    expect(await auth.storage.findMany("secondFactor", [])).toEqual([]);
  });

  it("refuses the passkey method for a user with no passkey, and writes no row", async () => {
    const auth = totpAuth({ passkey: RP });
    const session = await verifiedSession(auth);
    expect(await enableMethod(auth.config, session, "passkey")).toEqual({
      ok: false,
      code: "passkey_failed",
      status: 400,
    });
    expect(await auth.storage.findMany("secondFactor", [])).toEqual([]);
  });

  it("answers invalid_token at the options of an expired challenge, and invalid_body at a challenge with no passkey method", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, soft } = await withPasskey(auth);
    const on = await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    if (!on.ok) throw new Error(on.code);
    const first = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!first.ok || !("twoFactor" in first.value)) throw new Error("no challenge");
    auth.clock.advance(300_001);
    expect(
      await passkeyChallengeOptions(auth.config, {
        challenge: first.value.twoFactor.challenge,
        ip: null,
      }),
    ).toEqual({ ok: false, code: "invalid_token", status: 400 });
    // Bea has the TOTP method only.
    await enrolled(auth, "bea@example.com");
    const bea = await passwordSignIn(auth.config, {
      email: "bea@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!bea.ok || !("twoFactor" in bea.value)) throw new Error("no challenge");
    expect(bea.value.twoFactor.methods).toEqual(["totp", "backup"]);
    expect(
      await passkeyChallengeOptions(auth.config, {
        challenge: bea.value.twoFactor.challenge,
        ip: null,
      }),
    ).toEqual({ ok: false, code: "invalid_body", status: 400 });
  });
});

describe("a TOTP setup while another method is on (plan 12c, Task 2 review note 1)", () => {
  /** A user with the passkey method on, and the factor row that its enable wrote. */
  async function passkeyOn(auth: Auth) {
    const { session, soft } = await withPasskey(auth);
    const on = await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    if (!on.ok) throw new Error(on.code);
    const factor = await factorRow(auth.storage, session.user.id);
    if (!factor) throw new Error("no factor row");
    return { session, factor };
  }

  it("answers no backup codes at the TOTP setup when the passkey method is on, and the enable keeps the factor's list", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, factor } = await passkeyOn(auth);
    const setup = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    expect(setup.value.backupCodes).toEqual([]);
    const enabled = await enableTotp(auth.config, {
      session,
      code: await codeNow(auth, base32Decode(setup.value.secret)),
    });
    if (!enabled.ok) throw new Error(enabled.code);
    expect(enabled.value.methods).toEqual(["passkey", "totp"]);
    const after = await factorRow(auth.storage, session.user.id);
    expect(after?.id).toBe(factor.id);
    expect(after?.backupCodes).toEqual(factor.backupCodes);
  });

  it("refuses the TOTP enable with totp_not_enabled when the passkey method went off after the setup, and writes no factor row with no backup codes", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session } = await passkeyOn(auth);
    const setup = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    expect(setup.value.backupCodes).toEqual([]);
    const off = await disableMethod(auth.config, {
      user: session.user,
      method: "passkey",
      password: PASSWORD,
    });
    expect(off).toEqual({ ok: true, value: { ok: true, methods: [] } });
    expect(
      await enableTotp(auth.config, {
        session,
        code: await codeNow(auth, base32Decode(setup.value.secret)),
      }),
    ).toEqual({ ok: false, code: "totp_not_enabled", status: 400 });
    expect(await factorRow(auth.storage, session.user.id)).toBeNull();
    const totp = await auth.storage.findOne("totp", [
      { field: "userId", op: "eq", value: session.user.id },
    ]);
    expect(totp?.enabledAt).toBeNull();
    // A new setup with the factor off makes the codes, and its enable writes them.
    const again = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!again.ok) throw new Error(again.code);
    expect(again.value.backupCodes).toHaveLength(10);
    auth.clock.advance(30_000);
    const enabled = await enableTotp(auth.config, {
      session,
      code: await codeNow(auth, base32Decode(again.value.secret)),
    });
    if (!enabled.ok) throw new Error(enabled.code);
    expect((await factorRow(auth.storage, session.user.id))?.backupCodes).toHaveLength(10);
  });

  it("refuses the TOTP enable with totp_not_enabled when the passkey method turned on after the setup, and a new setup answers no codes", async () => {
    const auth = totpAuth({ passkey: RP });
    const { session, soft } = await withPasskey(auth);
    const setup = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    expect(setup.value.backupCodes).toHaveLength(10);
    const on = await enablePasskeyMethod(auth.config, {
      session,
      password: PASSWORD,
      response: await signInAssertion(auth, soft),
    });
    if (!on.ok) throw new Error(on.code);
    const factor = await factorRow(auth.storage, session.user.id);
    expect(
      await enableTotp(auth.config, {
        session,
        code: await codeNow(auth, base32Decode(setup.value.secret)),
      }),
    ).toEqual({ ok: false, code: "totp_not_enabled", status: 400 });
    expect(await factorRow(auth.storage, session.user.id)).toEqual(factor);
    const totp = await auth.storage.findOne("totp", [
      { field: "userId", op: "eq", value: session.user.id },
    ]);
    expect(totp?.enabledAt).toBeNull();
    const again = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!again.ok) throw new Error(again.code);
    expect(again.value.backupCodes).toEqual([]);
    auth.clock.advance(30_000);
    const enabled = await enableTotp(auth.config, {
      session,
      code: await codeNow(auth, base32Decode(again.value.secret)),
    });
    if (!enabled.ok) throw new Error(enabled.code);
    expect(enabled.value.methods).toEqual(["passkey", "totp"]);
    expect((await factorRow(auth.storage, session.user.id))?.backupCodes).toEqual(
      factor?.backupCodes,
    );
  });
});

/** The 6-digit code of the newest mail to the user. */
function mailedCode(auth: Auth): string {
  const m = /\b(\d{6})\b/.exec(auth.mail.findLast((x) => x.to === EMAIL)?.text ?? "");
  if (!m?.[1]) throw new Error("no code in the mail");
  return m[1];
}

/** A user with the TOTP method and then the email method on. */
async function withEmail(auth: Auth) {
  const enrolledUser = await enrolled(auth);
  const r = await enableEmailMethod(auth.config, {
    session: enrolledUser.session,
    password: PASSWORD,
  });
  if (!r.ok) throw new Error(r.code);
  return { ...enrolledUser, enabled: r.value };
}

async function passwordChallenge(auth: Auth): Promise<string> {
  const r = await passwordSignIn(auth.config, {
    email: EMAIL,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!r.ok || !("twoFactor" in r.value)) throw new Error("no challenge");
  return r.value.twoFactor.challenge;
}

describe("an email code as a second-factor method (plan 12c)", () => {
  it("turns the method on as a later method: it keeps the list and ends no session", async () => {
    const auth = totpAuth();
    // The enable of the first method kept the enabler's session, so it is still live.
    const { user, session } = await enrolled(auth);
    const other = await createSession(auth.config, { userId: user.id, ip: null, userAgent: null });
    const before = await auth.storage.findOne("secondFactor", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    const r = await enableEmailMethod(auth.config, { session, password: PASSWORD });
    expect(r).toEqual({ ok: true, value: { methods: ["totp", "email"], backupCodes: [] } });
    expect(
      await auth.storage.findOne("session", [{ field: "id", op: "eq", value: other.session.id }]),
    ).not.toBeNull();
    const after = await auth.storage.findOne("secondFactor", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(after?.backupCodes).toEqual(before?.backupCodes);
  });

  it("keeps the factor and its list when the TOTP method goes and the email method stays", async () => {
    const auth = totpAuth();
    const { user, secret } = await withEmail(auth);
    expect(
      (await disableTotpWithCode(auth.config, { user, code: await codeNow(auth, secret) })).ok,
    ).toBe(true);
    expect(await auth.storage.findMany("totp", [])).toEqual([]);
    expect(
      await auth.storage.findOne("secondFactor", [{ field: "userId", op: "eq", value: user.id }]),
    ).toMatchObject({ methods: ["email"] });
    expect(
      await passwordSignIn(auth.config, {
        email: EMAIL,
        password: PASSWORD,
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({
      ok: true,
      value: { twoFactor: { methods: ["email", "backup"] } },
    });
  });

  it("sends a code bound to the challenge: the verify with it opens the session, and the code fails at another challenge", async () => {
    const auth = totpAuth();
    await withEmail(auth);
    const a = await passwordChallenge(auth);
    const b = await passwordChallenge(auth);
    expect(await sendSecondFactorEmail(auth.config, { challenge: a })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const code = mailedCode(auth);
    expect(
      await verifyTwoFactor(auth.config, { challenge: b, emailCode: code, ip: null }),
    ).toMatchObject({ ok: false, code: "invalid_code" });
    expect(
      (await verifyTwoFactor(auth.config, { challenge: a, emailCode: code, ip: null })).ok,
    ).toBe(true);
  });

  it("replaces the code at a new send: the first code fails", async () => {
    const auth = totpAuth();
    await withEmail(auth);
    const a = await passwordChallenge(auth);
    await sendSecondFactorEmail(auth.config, { challenge: a });
    const first = mailedCode(auth);
    await sendSecondFactorEmail(auth.config, { challenge: a });
    const second = mailedCode(auth);
    // About once in a million the two codes are the same.
    if (first !== second)
      expect(
        await verifyTwoFactor(auth.config, { challenge: a, emailCode: first, ip: null }),
      ).toMatchObject({ code: "invalid_code" });
    expect(
      (await verifyTwoFactor(auth.config, { challenge: a, emailCode: second, ip: null })).ok,
    ).toBe(true);
  });

  it("offers no email after a magic link: the send and the verify answer invalid_body (owner decision 4)", async () => {
    const auth = totpAuth();
    await withEmail(auth);
    await requestMagicLink(auth.config, { email: EMAIL, ip: null });
    const r = await verifyMagicLink(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("no challenge");
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    const challenge = r.value.twoFactor.challenge;
    expect(await sendSecondFactorEmail(auth.config, { challenge })).toMatchObject({
      code: "invalid_body",
    });
    expect(
      await verifyTwoFactor(auth.config, { challenge, emailCode: "123456", ip: null }),
    ).toMatchObject({ code: "invalid_body" });
  });

  it("limits the sends: 3 per challenge, and 5 per user per 15 minutes over all challenges", async () => {
    const auth = totpAuth();
    await withEmail(auth);
    const a = await passwordChallenge(auth);
    for (let i = 0; i < 3; i++)
      expect((await sendSecondFactorEmail(auth.config, { challenge: a })).ok).toBe(true);
    expect(await sendSecondFactorEmail(auth.config, { challenge: a })).toMatchObject({
      code: "rate_limited",
    });
    const b = await passwordChallenge(auth);
    // The fourth try on `a` was refused before the per-user key, so the key holds 3.
    expect((await sendSecondFactorEmail(auth.config, { challenge: b })).ok).toBe(true);
    expect((await sendSecondFactorEmail(auth.config, { challenge: b })).ok).toBe(true);
    expect(await sendSecondFactorEmail(auth.config, { challenge: b })).toMatchObject({
      code: "rate_limited",
    });
  });

  it("sends to the user's address whatever the mail builder answers", async () => {
    const auth = totpAuth({
      totp: {
        emailMail: ({ code }) => ({
          to: "evil@example.com",
          subject: "Code",
          text: `Code ${code}`,
        }),
      },
    });
    await withEmail(auth);
    await sendSecondFactorEmail(auth.config, { challenge: await passwordChallenge(auth) });
    expect(auth.mail.at(-1)).toMatchObject({ to: EMAIL, subject: "Code" });
  });
});

describe("the bounds and the guards of the email method (plan 12c, Task 7 review)", () => {
  /** A 6-digit code that is not `code`. */
  const other = (code: string) => (code === "000000" ? "111111" : "000000");

  it("counts a wrong email code on the challenge: the fifth spends it", async () => {
    const auth = totpAuth();
    await withEmail(auth);
    const a = await passwordChallenge(auth);
    await sendSecondFactorEmail(auth.config, { challenge: a });
    const code = mailedCode(auth);
    for (let i = 0; i < 4; i++)
      expect(
        await verifyTwoFactor(auth.config, { challenge: a, emailCode: other(code), ip: null }),
      ).toMatchObject({ ok: false, code: "invalid_code" });
    expect(
      await verifyTwoFactor(auth.config, { challenge: a, emailCode: other(code), ip: null }),
    ).toMatchObject({ ok: false, code: "too_many_attempts" });
    expect(
      await verifyTwoFactor(auth.config, { challenge: a, emailCode: code, ip: null }),
    ).toMatchObject({ ok: false, code: "too_many_attempts" });
  });

  it("counts an email code on the per-user code keys", async () => {
    const auth = totpAuth();
    await withEmail(auth);
    // A new 15-minute window: the TOTP enable of `enrolled` counted one code check.
    auth.clock.advance(901_000);
    // No send: a challenge with no stored code answers each guess as a miss.
    for (const challenge of [await passwordChallenge(auth), await passwordChallenge(auth)])
      for (let i = 0; i < 5; i++)
        expect(
          (await verifyTwoFactor(auth.config, { challenge, emailCode: "123456", ip: null })).ok,
        ).toBe(false);
    expect(
      await verifyTwoFactor(auth.config, {
        challenge: await passwordChallenge(auth),
        emailCode: "123456",
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("refuses the email enable with a wrong password: invalid_credentials, and the factor stays as it was", async () => {
    const auth = totpAuth();
    const { user, session } = await enrolled(auth);
    const before = await factorRow(auth.storage, user.id);
    expect(
      await enableEmailMethod(auth.config, { session, password: "not the password" }),
    ).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(await factorRow(auth.storage, user.id)).toEqual(before);
  });

  it("refuses the email enable for an address that is not verified: email_unverified", async () => {
    const auth = totpAuth();
    const s = await verifiedSession(auth);
    await auth.storage.update("user", [{ field: "id", op: "eq", value: s.user.id }], {
      emailVerified: false,
    });
    const session = await resolveSession(auth.config, s.token);
    if (!session) throw new Error("no session");
    expect(await enableEmailMethod(auth.config, { session, password: PASSWORD })).toMatchObject({
      ok: false,
      code: "email_unverified",
    });
    expect(await auth.storage.findMany("secondFactor", [])).toEqual([]);
  });

  it("counts the send on its own daily key of the address, apart from the email code sign-in (owner decision 2026-10-14)", async () => {
    const auth = totpAuth();
    await withEmail(auth);
    const a = await passwordChallenge(auth);
    // A person who knows the address spends the sign-in's daily key.
    for (let i = 0; i < MAILED_CODES_PER_EMAIL_DAY.max; i++)
      await auth.config.limiter.allow(`otp:email-day:${EMAIL}`, MAILED_CODES_PER_EMAIL_DAY);
    expect(await requestEmailOtp(auth.config, { email: EMAIL, ip: null })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(await sendSecondFactorEmail(auth.config, { challenge: a })).toEqual({
      ok: true,
      value: { sent: true },
    });
    // The send's own key now holds 1; 19 more spend it.
    for (let i = 0; i < MAILED_CODES_PER_EMAIL_DAY.max - 1; i++)
      await auth.config.limiter.allow(`totp:email-day:${EMAIL}`, MAILED_CODES_PER_EMAIL_DAY);
    expect(await sendSecondFactorEmail(auth.config, { challenge: a })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
  });

  it("answers conflict and sends no mail when the challenge row changed under the send", async () => {
    const auth = totpAuth();
    await withEmail(auth);
    const a = await passwordChallenge(auth);
    const inner = auth.config.storage;
    // A parallel send or a counted guess writes the row between the read and the write.
    const racing: StorageAdapter = {
      create: (m, d) => inner.create(m, d),
      findOne: (m, w) => inner.findOne(m, w),
      findMany: (m, w, o) => inner.findMany(m, w, o),
      update: async (m, w, d) => {
        if (m === "verification") {
          const id = String(w.find((c) => c.field === "id")?.value);
          await inner.update("verification", [{ field: "id", op: "eq", value: id }], {
            updatedAt: new Date(auth.clock.now().getTime() + 5_000),
          });
        }
        return inner.update(m, w, d);
      },
      delete: (m, w) => inner.delete(m, w),
      transaction: (fn) => inner.transaction(fn),
    };
    const mails = auth.mail.length;
    expect(
      await sendSecondFactorEmail({ ...auth.config, storage: racing }, { challenge: a }),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(auth.mail).toHaveLength(mails);
  });

  it("states the challenge's time left in the mail: 5 minutes at once, 3 after 150 seconds", async () => {
    const ttls: number[] = [];
    const auth = totpAuth({
      totp: {
        emailMail: (input) => {
          ttls.push(input.ttlMinutes);
          return defaultSecondFactorMail(input);
        },
      },
    });
    await withEmail(auth);
    const a = await passwordChallenge(auth);
    await sendSecondFactorEmail(auth.config, { challenge: a });
    auth.clock.advance(150_000);
    await sendSecondFactorEmail(auth.config, { challenge: a });
    expect(ttls).toEqual([5, 3]);
  });

  it("refuses the TOTP enable with totp_not_enabled when the email method turned on after the setup, and the factor keeps its list", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    const setup = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    expect(setup.value.backupCodes).toHaveLength(10);
    const on = await enableEmailMethod(auth.config, { session, password: PASSWORD });
    if (!on.ok) throw new Error(on.code);
    expect(on.value.backupCodes).toHaveLength(10);
    const factor = await factorRow(auth.storage, session.user.id);
    expect(
      await enableTotp(auth.config, {
        session,
        code: await codeNow(auth, base32Decode(setup.value.secret)),
      }),
    ).toMatchObject({ ok: false, code: "totp_not_enabled" });
    expect(await factorRow(auth.storage, session.user.id)).toEqual(factor);
  });
});
