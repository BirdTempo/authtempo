import { describe, expect, it } from "vitest";
import { requestResetOtp, resetPasswordWithOtp } from "../src/engine/email-otp.js";
import {
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
} from "../src/engine/password.js";
import { verifyTwoFactor } from "../src/engine/totp.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { tokenFromMail } from "./helpers.js";
import { type Auth, codeNow, EMAIL, enrolled, PASSWORD, totpAuth } from "./totp-helpers.js";

const NEW = "a brand new long password";

/** A reset link for `email` with `next`, then the reset with a new password. */
async function resetByLink(auth: Auth, over: { email?: string; trustDevice?: string } = {}) {
  const email = over.email ?? EMAIL;
  await requestPasswordReset(auth.config, { email, next: "/after", ip: null });
  return resetPassword(auth.config, {
    token: tokenFromMail(auth.mail.findLast((m) => m.to === email)?.text ?? ""),
    password: NEW,
    ip: "4.4.4.4",
    userAgent: "Agent/4",
    ...(over.trustDevice !== undefined ? { trustDevice: over.trustDevice } : {}),
  });
}

const sessionsOf = (auth: Auth, userId: string) =>
  auth.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }]);

/** A test auth that records the `via` of each opened session. */
function recording() {
  const vias: string[] = [];
  const auth = totpAuth({
    hooks: {
      session: {
        afterCreate: (e) => {
          vias.push(e.via);
        },
      },
    },
  });
  return { auth, vias };
}

describe("the reset gate (plan 12c, ASVS 5.0 6.4.3)", () => {
  it("a gated reset sets the password, ends the sessions, opens no session, and answers the challenge", async () => {
    const { auth, vias } = recording();
    const { user, secret } = await enrolled(auth);
    expect((await sessionsOf(auth, user.id)).length).toBeGreaterThan(0);
    vias.length = 0;
    const r = await resetByLink(auth);
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("the reset answered no challenge");
    expect(r.value.next).toBe("/after");
    expect(r.value.user.id).toBe(user.id);
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    expect(await sessionsOf(auth, user.id)).toEqual([]);
    expect(vias).toEqual([]);
    expect(
      await passwordSignIn(auth.config, {
        email: EMAIL,
        password: PASSWORD,
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ code: "invalid_credentials" });
    const [row] = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "two-factor" },
      { field: "valueHash", op: "eq", value: await sha256Hex(r.value.twoFactor.challenge) },
    ]);
    expect(row?.data).toMatchObject({
      via: "password",
      from: "reset",
      ip: "4.4.4.4",
      userAgent: "Agent/4",
      next: "/after",
    });
    const v = await verifyTwoFactor(auth.config, {
      challenge: r.value.twoFactor.challenge,
      code: await codeNow(auth, secret),
      ip: null,
    });
    expect(v).toMatchObject({ ok: true, value: { next: "/after" } });
    expect(vias).toEqual(["password"]);
  });

  it("opens a session on a trusted device and moves its lastSeenAt; the reset keeps the device", async () => {
    const auth = totpAuth();
    const { user, secret } = await enrolled(auth);
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
    const r = await resetByLink(auth, { trustDevice: v.value.trustDevice.token });
    expect(r.ok && "token" in r.value).toBe(true);
    expect(await sessionsOf(auth, user.id)).toHaveLength(1);
    const [device] = await auth.storage.findMany("trustedDevice", []);
    expect(device?.lastSeenAt).toEqual(auth.clock.now());
  });

  it("opens a session for a minted user and for a claimant: neither has a factor", async () => {
    const auth = totpAuth();
    const minted = await resetByLink(auth, { email: "new@example.com" });
    expect(minted.ok && "token" in minted.value).toBe(true);
    const up = await passwordSignUp(auth.config, {
      email: "claim@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const claimed = await resetByLink(auth, { email: "claim@example.com" });
    expect(claimed.ok && "token" in claimed.value).toBe(true);
  });

  it("a second reset deletes the first reset's challenge: the newer password owns the challenge", async () => {
    const auth = totpAuth();
    const { secret } = await enrolled(auth);
    const one = await resetByLink(auth);
    const two = await resetByLink(auth);
    if (!one.ok || !("twoFactor" in one.value) || !two.ok || !("twoFactor" in two.value))
      throw new Error("a reset answered no challenge");
    expect(
      await verifyTwoFactor(auth.config, {
        challenge: one.value.twoFactor.challenge,
        code: await codeNow(auth, secret),
        ip: null,
      }),
    ).toMatchObject({ code: "invalid_token" });
    expect(
      (
        await verifyTwoFactor(auth.config, {
          challenge: two.value.twoFactor.challenge,
          code: await codeNow(auth, secret),
          ip: null,
        })
      ).ok,
    ).toBe(true);
  });

  it("a gated reset by code answers the challenge and opens no session", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    expect((await requestResetOtp(auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
    const code = /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const r = await resetPasswordWithOtp(auth.config, {
      email: EMAIL,
      code,
      password: NEW,
      ip: null,
      userAgent: null,
    });
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("the reset answered no challenge");
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    expect(await sessionsOf(auth, user.id)).toEqual([]);
  });
});
