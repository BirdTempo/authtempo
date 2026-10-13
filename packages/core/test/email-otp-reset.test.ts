import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { requestEmailOtp, requestResetOtp, resetPasswordWithOtp } from "../src/engine/email-otp.js";
import { hookRefusal } from "../src/engine/hooks.js";
import {
  changePassword,
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
} from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { makeAuth, tokenFromMail } from "./helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";

const EMAIL = "ada@example.com";
const OLD = "correct horse battery";
const NEW = "a new long password";
type Auth = ReturnType<typeof makeAuth>;

const resetAuth = (extra: Partial<AuthConfig> = {}) =>
  makeAuth({ password: { hash: FAST }, ...extra });

/** The code in the newest mail to `to`. */
function codeFrom(auth: Auth, to = EMAIL): string {
  const text = auth.mail.findLast((m) => m.to === to)?.text ?? "";
  const m = /\b(\d{8}|\d{6})\b/.exec(text);
  if (!m?.[1]) throw new Error(`no code in the mail to ${to}`);
  return m[1];
}

const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

async function requestReset(auth: Auth, email = EMAIL): Promise<string> {
  const r = await requestResetOtp(auth.config, { email, ip: null });
  if (!r.ok) throw new Error(r.code);
  return codeFrom(auth, email);
}

const reset = (auth: Auth, code: string, password = NEW, email = EMAIL) =>
  resetPasswordWithOtp(auth.config, { email, code, password, ip: null, userAgent: null });

const signIn = (auth: Auth, password: string, email = EMAIL) =>
  passwordSignIn(auth.config, { email, password, ip: null, userAgent: null });

const codeRows = (auth: Auth) =>
  auth.storage.findMany("verification", [
    { field: "purpose", op: "eq", value: "password-reset-otp" },
  ]);

const linkReset = (auth: Auth, token: string) =>
  resetPassword(auth.config, {
    token,
    password: "a third long password",
    ip: null,
    userAgent: null,
  });

describe("reset by code (plan 9e)", () => {
  it("mails a reset code to any address, with the reset text, and stores its keyed hash", async () => {
    const auth = resetAuth();
    expect(await requestResetOtp(auth.config, { email: "nobody@example.com", ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const code = codeFrom(auth, "nobody@example.com");
    expect(auth.mail).toEqual([
      {
        to: "nobody@example.com",
        subject: "Your password reset code for api.example.com",
        text: `Your password reset code for api.example.com is ${code}. It is valid for 10 minutes.`,
      },
    ]);
    expect(await codeRows(auth)).toEqual([
      expect.objectContaining({
        identifier: "nobody@example.com",
        consumedAt: null,
        data: { attempts: 0 },
      }),
    ]);
  });

  it("sets the password, ends every session, and opens one; the code is then spent", async () => {
    const auth = resetAuth();
    await signUpAndVerify(auth, EMAIL, OLD);
    const before = await signIn(auth, OLD);
    if (!before.ok) throw new Error(before.code);
    const code = await requestReset(auth);
    const r = await reset(auth, code);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.user).toMatchObject({ email: EMAIL, emailVerified: true });
    expect((await auth.storage.findMany("session", [])).map((s) => s.id)).toEqual([
      r.value.session.id,
    ]);
    expect(await resolveSession(auth.config, before.value.token)).toBeNull();
    expect((await signIn(auth, NEW)).ok).toBe(true);
    expect(await signIn(auth, OLD)).toMatchObject({ code: "invalid_credentials" });
    expect(await reset(auth, code)).toMatchObject({ ok: false, code: "invalid_code" });
  });

  it("creates the user and the password for an address with no user", async () => {
    const auth = resetAuth();
    const r = await reset(
      auth,
      await requestReset(auth, "new@example.com"),
      NEW,
      "new@example.com",
    );
    if (!r.ok) throw new Error(r.code);
    expect(r.value.user).toMatchObject({ email: "new@example.com", emailVerified: true });
    expect((await signIn(auth, NEW, "new@example.com")).ok).toBe(true);
  });

  it("counts a wrong code and spends the code at the cap", async () => {
    const auth = resetAuth();
    const code = await requestReset(auth);
    for (let i = 0; i < 4; i++)
      expect(await reset(auth, wrongFor(code))).toMatchObject({ code: "invalid_code" });
    expect(await reset(auth, wrongFor(code))).toEqual({
      ok: false,
      code: "too_many_attempts",
      status: 400,
    });
    expect(await reset(auth, code)).toMatchObject({ code: "too_many_attempts" });
    expect(await auth.storage.findMany("password", [])).toEqual([]);
  });

  it("checks the code before the password: a weak password with a wrong code answers invalid_code and counts", async () => {
    const auth = resetAuth();
    const code = await requestReset(auth);
    expect(await reset(auth, wrongFor(code), "short")).toMatchObject({ code: "invalid_code" });
    expect((await codeRows(auth))[0]).toMatchObject({ consumedAt: null, data: { attempts: 1 } });
  });

  it("spends the code on a password the policy refuses, and answers password_policy (Review Focus 4)", async () => {
    const auth = resetAuth();
    const code = await requestReset(auth);
    expect(await reset(auth, code, "short")).toEqual({
      ok: false,
      code: "password_policy",
      status: 400,
    });
    expect((await codeRows(auth))[0]?.consumedAt).not.toBeNull();
    expect(await reset(auth, code)).toMatchObject({ code: "invalid_code" });
    expect(await auth.storage.findMany("user", [])).toEqual([]);
  });

  it("spends the code on a breached password too, and answers password_breached", async () => {
    const auth = makeAuth({ password: { hash: FAST, breachCheck: async () => true } });
    const code = await requestReset(auth);
    expect(await reset(auth, code)).toMatchObject({ code: "password_breached" });
    expect(await reset(auth, code)).toMatchObject({ code: "invalid_code" });
  });

  it("applies the claim rule to an unverified claimant", async () => {
    const auth = resetAuth();
    const up = await passwordSignUp(auth.config, {
      email: EMAIL,
      password: OLD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const r = await reset(auth, await requestReset(auth));
    if (!r.ok) throw new Error(r.code);
    expect(r.value.user).toMatchObject({ id: up.value.user.id, emailVerified: true });
    expect((await auth.storage.findMany("session", [])).map((s) => s.id)).toEqual([
      r.value.session.id,
    ]);
    expect(await signIn(auth, OLD)).toMatchObject({ code: "invalid_credentials" });
    expect((await signIn(auth, NEW)).ok).toBe(true);
  });

  it("a reset by code spends the live reset links, and a reset by link spends the live codes", async () => {
    const auth = resetAuth();
    await signUpAndVerify(auth, EMAIL, OLD);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const link = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    expect((await reset(auth, await requestReset(auth))).ok).toBe(true);
    expect(await linkReset(auth, link)).toMatchObject({ ok: false, code: "invalid_token" });
    const code = await requestReset(auth);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const link2 = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    expect((await linkReset(auth, link2)).ok).toBe(true);
    expect(await reset(auth, code)).toMatchObject({ ok: false, code: "invalid_code" });
  });

  it("a password change spends the live reset codes", async () => {
    const auth = resetAuth();
    await signUpAndVerify(auth, EMAIL, OLD);
    const s = await signIn(auth, OLD);
    if (!s.ok) throw new Error(s.code);
    const code = await requestReset(auth);
    const session = await resolveSession(auth.config, s.value.token);
    if (!session) throw new Error("no session");
    expect(
      await changePassword(auth.config, { session, currentPassword: OLD, newPassword: NEW }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(await reset(auth, code, "a third long password")).toMatchObject({
      code: "invalid_code",
    });
  });

  it("shares the request budget with the sign-in code", async () => {
    const auth = resetAuth();
    await requestEmailOtp(auth.config, { email: EMAIL, ip: null });
    await requestEmailOtp(auth.config, { email: EMAIL, ip: null });
    expect((await requestResetOtp(auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
    expect(await requestResetOtp(auth.config, { email: EMAIL, ip: null })).toMatchObject({
      code: "rate_limited",
    });
  });

  it("lets one of two resets with one right code win", async () => {
    const auth = resetAuth();
    const code = await requestReset(auth);
    const [a, b] = await Promise.all([
      reset(auth, code),
      reset(auth, code, "another long password"),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(await auth.storage.findMany("password", [])).toHaveLength(1);
  });

  it("undoes the spend on a session hook refusal, so the code stays usable, as a refused reset link does", async () => {
    let refuse = true;
    const auth = resetAuth({
      hooks: {
        session: {
          beforeCreate() {
            if (refuse) throw hookRefusal("Not now.");
          },
        },
      },
    });
    const code = await requestReset(auth);
    expect(await reset(auth, code)).toMatchObject({
      ok: false,
      code: "hook_refused",
      message: "Not now.",
    });
    expect((await codeRows(auth))[0]?.consumedAt).toBeNull();
    refuse = false;
    expect((await reset(auth, code)).ok).toBe(true);
  });

  it("answers not_found without a password config", async () => {
    const auth = makeAuth();
    expect(await requestResetOtp(auth.config, { email: EMAIL, ip: null })).toMatchObject({
      code: "not_found",
    });
    expect(await reset(auth, "123456")).toMatchObject({ code: "not_found" });
  });
});
