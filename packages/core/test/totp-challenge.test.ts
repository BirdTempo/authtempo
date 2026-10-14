import { describe, expect, it } from "vitest";
import {
  changePassword,
  type PasswordSignIn,
  passwordSignIn,
  requestPasswordReset,
  resetPassword,
  verifyPassword,
} from "../src/engine/password.js";
import { challengeMethods, challengeOrigin, writeChallenge } from "../src/engine/second-factor.js";
import { setupTotp, type TwoFactorVerify, verifyTwoFactor } from "../src/engine/totp.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { SecondFactorRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth, tokenFromMail } from "./helpers.js";
import {
  type Auth,
  codeNow,
  EMAIL,
  enrolled,
  PASSWORD,
  totpAuth,
  verifiedSession,
  wrongFor,
} from "./totp-helpers.js";

const signIn = (auth: Auth, over: Partial<PasswordSignIn> = {}) =>
  passwordSignIn(auth.config, {
    email: EMAIL,
    password: PASSWORD,
    ip: "2.2.2.2",
    userAgent: "Agent/2",
    ...over,
  });

async function challengeOf(auth: Auth, over: Partial<PasswordSignIn> = {}): Promise<string> {
  const r = await signIn(auth, over);
  if (!r.ok || !("twoFactor" in r.value)) throw new Error("the sign-in answered no challenge");
  return r.value.twoFactor.challenge;
}

const verify = (auth: Auth, input: Omit<TwoFactorVerify, "ip">) =>
  verifyTwoFactor(auth.config, { ip: "2.2.2.2", ...input });

const sessionCount = async (auth: Auth) => (await auth.storage.findMany("session", [])).length;

/**
 * Wraps the next `storage.transaction` call: `after` runs on the same
 * transaction just after its first create of `model`, as a statement of a
 * parallel flow that lands there.
 */
function afterCreate(
  storage: StorageAdapter,
  model: "verification" | "session",
  after: (tx: StorageAdapter) => Promise<unknown>,
): void {
  const original = storage.transaction.bind(storage);
  let armed = true;
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!armed) return original(fn);
    armed = false;
    return original((tx) =>
      fn({
        ...tx,
        create: async (m, d) => {
          const row = await tx.create(m, d);
          if (m === model) await after(tx);
          return row;
        },
      }),
    );
  };
}

describe("the gate (plan 9f)", () => {
  it("answers a challenge in place of a session for a user with the factor on, and opens no session", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    const before = await sessionCount(auth);
    const now = auth.clock.now();
    const r = await signIn(auth, { next: "/inbox" });
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("no challenge");
    const { challenge, expiresAt } = r.value.twoFactor;
    expect(challenge).toMatch(/^tf_[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toEqual(new Date(now.getTime() + 300_000));
    expect(await sessionCount(auth)).toBe(before);
    const rows = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "two-factor" },
    ]);
    expect(rows).toMatchObject([
      {
        identifier: user.id,
        valueHash: await sha256Hex(challenge),
        consumedAt: null,
        data: { via: "password", ip: "2.2.2.2", userAgent: "Agent/2", next: "/inbox", attempts: 0 },
      },
    ]);
  });

  it("answers the methods of the challenge in the order of preference: totp, then backup (plan 12c)", async () => {
    const auth = totpAuth();
    await enrolled(auth);
    const r = await signIn(auth);
    if (!r.ok || !("twoFactor" in r.value)) throw new Error("no challenge");
    expect(r.value.twoFactor.methods).toEqual(["totp", "backup"]);
    const [row] = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "two-factor" },
    ]);
    expect(row?.data).toMatchObject({ via: "password", from: "sign-in" });
  });

  it("opens a session at once for a user with an unconfirmed setup, and with totp: false", async () => {
    const auth = totpAuth();
    // A setup with no enable: the state a person leaves who never typed the first code.
    const { user } = await verifiedSession(auth);
    const setup = await setupTotp(auth.config, { userId: user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    expect(await auth.storage.findMany("totp", [])).toMatchObject([{ enabledAt: null }]);
    const r = await signIn(auth);
    expect(r.ok && "token" in r.value).toBe(true);
    const off = totpAuth({ totp: false });
    await verifiedSession(off);
    const s = await signIn(off);
    expect(s.ok && "token" in s.value).toBe(true);
  });

  it("deletes the challenge and answers invalid_credentials when a change lands between the password check and the challenge", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    afterCreate(auth.storage, "verification", (tx) =>
      tx.update("password", [{ field: "userId", op: "eq", value: user.id }], {
        hash: "written by a parallel change",
      }),
    );
    expect(await signIn(auth)).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(
      await auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "two-factor" },
      ]),
    ).toEqual([]);
  });
});

describe("the methods of a challenge (plan 12c)", () => {
  const at = new Date("2026-10-14T00:00:00.000Z");
  const row: SecondFactorRow = {
    id: "s1",
    userId: "u1",
    enabledAt: at,
    methods: ["email", "totp", "passkey"],
    backupCodes: ["h1"],
    backupCodesVersion: 2,
    createdAt: at,
    updatedAt: at,
  };
  const withPasskey = makeAuth({
    password: {},
    passkey: { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] },
  }).config;

  it("lists every method in the order passkey, totp, email, backup after a password sign-in", () => {
    expect(challengeMethods(withPasskey, row, { via: "password", from: "sign-in" })).toEqual([
      "passkey",
      "totp",
      "email",
      "backup",
    ]);
  });

  it("lists no email method after a mailbox proof, after social, or after a reset (owner decision 4)", () => {
    for (const via of ["magic_link", "email_otp", "social"] as const)
      expect(challengeMethods(withPasskey, row, { via, from: "sign-in" })).toEqual([
        "passkey",
        "totp",
        "backup",
      ]);
    expect(challengeMethods(withPasskey, row, { via: "password", from: "reset" })).toEqual([
      "passkey",
      "totp",
      "backup",
    ]);
  });

  it("lists no passkey without the passkey config, and no backup with no codes left", () => {
    const noPasskey = makeAuth({ password: {} }).config;
    expect(
      challengeMethods(
        noPasskey,
        { ...row, backupCodes: [] },
        { via: "password", from: "sign-in" },
      ),
    ).toEqual(["totp", "email"]);
  });

  it("reads the origin of a plan 9f row as a password sign-in, and an unknown via as password", () => {
    expect(challengeOrigin({ via: "password", ip: null })).toEqual({
      via: "password",
      from: "sign-in",
    });
    expect(challengeOrigin(null)).toEqual({ via: "password", from: "sign-in" });
    expect(challengeOrigin({ via: "handoff", from: "reset" })).toEqual({
      via: "password",
      from: "reset",
    });
    expect(challengeOrigin({ via: "social" })).toEqual({ via: "social", from: "sign-in" });
  });

  it("opens the session with the challenge's via, and session.afterCreate sees it", async () => {
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
    const { user, secret } = await enrolled(auth);
    const factor = await auth.storage.findOne("secondFactor", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    if (!factor) throw new Error("no factor row");
    const now = auth.clock.now();
    const { pending } = await writeChallenge(
      auth.config,
      auth.storage,
      factor,
      {
        userId: user.id,
        via: "magic_link",
        from: "sign-in",
        ip: "3.3.3.3",
        userAgent: "A",
        next: "/x",
      },
      now,
    );
    vias.length = 0;
    const v = await verify(auth, {
      challenge: pending.twoFactor.challenge,
      code: await codeNow(auth, secret),
    });
    expect(v).toMatchObject({ ok: true, value: { next: "/x" } });
    expect(vias).toEqual(["magic_link"]);
  });
});

describe("the verify (plan 9f)", () => {
  it("opens the session with a right code, with the challenge's IP and user agent, and spends the challenge", async () => {
    const auth = totpAuth();
    const { user, secret } = await enrolled(auth);
    const before = await sessionCount(auth);
    const challenge = await challengeOf(auth, { next: "/inbox" });
    const r = await verifyTwoFactor(auth.config, {
      challenge,
      code: await codeNow(auth, secret),
      ip: "7.7.7.7",
    });
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({
      user: { id: user.id },
      next: "/inbox",
      trustDevice: null,
      backupCodesLeft: 10,
    });
    expect(r.value.token).toMatch(/^ts_/);
    expect(await sessionCount(auth)).toBe(before + 1);
    expect(
      await auth.storage.findOne("session", [{ field: "id", op: "eq", value: r.value.session.id }]),
    ).toMatchObject({ ip: "2.2.2.2", userAgent: "Agent/2" });
    auth.clock.advance(30_000);
    expect(await verify(auth, { challenge, code: await codeNow(auth, secret) })).toEqual({
      ok: false,
      code: "invalid_token",
      status: 400,
    });
  });

  it("refuses the code of a step that a verify accepted, and accepts the next step's code (Review Focus 1)", async () => {
    const auth = totpAuth();
    const { secret } = await enrolled(auth);
    const code = await codeNow(auth, secret);
    expect((await verify(auth, { challenge: await challengeOf(auth), code })).ok).toBe(true);
    const second = await challengeOf(auth);
    expect(await verify(auth, { challenge: second, code })).toEqual({
      ok: false,
      code: "invalid_code",
      status: 400,
    });
    auth.clock.advance(30_000);
    expect((await verify(auth, { challenge: second, code: await codeNow(auth, secret) })).ok).toBe(
      true,
    );
  });

  it("answers invalid_token for a challenge five minutes old, also with a right code (Review Focus 2)", async () => {
    const auth = totpAuth();
    const { secret, user } = await enrolled(auth);
    const challenge = await challengeOf(auth);
    auth.clock.advance(300_000);
    const lastStep = async () =>
      (await auth.storage.findOne("totp", [{ field: "userId", op: "eq", value: user.id }]))
        ?.lastStep;
    const before = await lastStep();
    expect(await verify(auth, { challenge, code: await codeNow(auth, secret) })).toEqual({
      ok: false,
      code: "invalid_token",
      status: 400,
    });
    // The expired challenge checks no code, so the code's step stays unspent.
    expect(await lastStep()).toBe(before);
  });

  it("spends the challenge at the fifth wrong code, and answers too_many_attempts to every later try (Review Focus 2)", async () => {
    const auth = totpAuth();
    const { secret } = await enrolled(auth);
    const before = await sessionCount(auth);
    const challenge = await challengeOf(auth);
    const wrong = wrongFor(await codeNow(auth, secret));
    for (let i = 0; i < 4; i++)
      expect(await verify(auth, { challenge, code: wrong })).toEqual({
        ok: false,
        code: "invalid_code",
        status: 400,
      });
    expect(await verify(auth, { challenge, code: wrong })).toEqual({
      ok: false,
      code: "too_many_attempts",
      status: 400,
    });
    expect(await verify(auth, { challenge, code: wrong })).toMatchObject({
      code: "too_many_attempts",
    });
    expect(await verify(auth, { challenge, code: await codeNow(auth, secret) })).toMatchObject({
      code: "too_many_attempts",
    });
    expect(await sessionCount(auth)).toBe(before);
  });

  it("spends a backup code once: backupCodesLeft drops by one, and the second use answers invalid_code", async () => {
    const auth = totpAuth();
    const { backupCodes } = await enrolled(auth);
    const code = backupCodes[0] ?? "";
    const r = await verify(auth, { challenge: await challengeOf(auth), backupCode: code });
    expect(r.ok && r.value.backupCodesLeft).toBe(9);
    expect(await verify(auth, { challenge: await challengeOf(auth), backupCode: code })).toEqual({
      ok: false,
      code: "invalid_code",
      status: 400,
    });
  });

  it("refuses a malformed challenge, an unknown challenge, and a call with both or neither code", async () => {
    const auth = totpAuth();
    await enrolled(auth);
    const challenge = await challengeOf(auth);
    expect(await verify(auth, { challenge: "tf_short", code: "123456" })).toMatchObject({
      code: "invalid_token",
    });
    expect(await verify(auth, { challenge: `tf_${"A".repeat(43)}`, code: "123456" })).toMatchObject(
      { code: "invalid_token" },
    );
    expect(await verify(auth, { challenge })).toMatchObject({ code: "invalid_body" });
    expect(await verify(auth, { challenge, code: "123456", backupCode: "abc" })).toMatchObject({
      code: "invalid_body",
    });
  });

  it("bounds the codes of one user to 10 per 15 minutes over all challenges, with the enable's count", async () => {
    const auth = totpAuth();
    const { secret } = await enrolled(auth);
    // The enable counted one. A capped challenge spends only itself, so a new
    // challenge gives five more guesses: the per-user limit bounds them.
    const wrong = wrongFor(await codeNow(auth, secret));
    const first = await challengeOf(auth);
    for (let i = 0; i < 5; i++) await verify(auth, { challenge: first, code: wrong });
    const second = await challengeOf(auth);
    for (let i = 0; i < 4; i++)
      expect(await verify(auth, { challenge: second, code: wrong })).toMatchObject({
        code: "invalid_code",
      });
    expect(await verify(auth, { challenge: second, code: await codeNow(auth, secret) })).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
  });

  it("limits the verify to 30 per IP per 15 minutes", async () => {
    const auth = totpAuth();
    for (let i = 0; i < 30; i++)
      expect(await verify(auth, { challenge: "tf_x", code: "123456" })).toMatchObject({
        code: "invalid_token",
      });
    expect(await verify(auth, { challenge: "tf_x", code: "123456" })).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
  });
});

describe("the challenge and the flows that end sessions (plan 9f)", () => {
  it("leaves no session from the verify when a reset lands between the challenge and the verify", async () => {
    const auth = totpAuth();
    const { secret } = await enrolled(auth);
    const challenge = await challengeOf(auth);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const reset = await resetPassword(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      password: "a brand new long password",
      ip: null,
      userAgent: null,
    });
    if (!reset.ok) throw new Error(reset.code);
    expect(await verify(auth, { challenge, code: await codeNow(auth, secret) })).toMatchObject({
      code: "invalid_token",
    });
    expect((await auth.storage.findMany("session", [])).map((s) => s.id)).toEqual([
      reset.value.session.id,
    ]);
  });

  it("deletes the user's challenges at a password change", async () => {
    const auth = totpAuth();
    const { session, secret } = await enrolled(auth);
    const challenge = await challengeOf(auth);
    const changed = await changePassword(auth.config, {
      session,
      currentPassword: PASSWORD,
      newPassword: "a brand new long password",
    });
    expect(changed.ok).toBe(true);
    expect(await verify(auth, { challenge, code: await codeNow(auth, secret) })).toMatchObject({
      code: "invalid_token",
    });
  });

  it("deletes its own session and answers invalid_token when the challenge goes inside the verify", async () => {
    const auth = totpAuth();
    const { user, secret } = await enrolled(auth);
    const before = await sessionCount(auth);
    const challenge = await challengeOf(auth);
    // A reset deletes the user's challenges before it ends the sessions. Here
    // that delete lands after the verify wrote its session and before the spend.
    afterCreate(auth.storage, "session", (tx) =>
      tx.delete("verification", [
        { field: "purpose", op: "eq", value: "two-factor" },
        { field: "identifier", op: "eq", value: user.id },
      ]),
    );
    expect(await verify(auth, { challenge, code: await codeNow(auth, secret) })).toMatchObject({
      code: "invalid_token",
    });
    expect(await sessionCount(auth)).toBe(before);
  });
});

describe("the trusted device (plan 9f)", () => {
  it("writes a trusted device with trustDevice, and the next sign-in with its token skips the gate and moves lastSeenAt", async () => {
    const auth = totpAuth();
    const { secret, user } = await enrolled(auth);
    const now = auth.clock.now();
    const r = await verify(auth, {
      challenge: await challengeOf(auth),
      code: await codeNow(auth, secret),
      trustDevice: true,
    });
    if (!r.ok || !r.value.trustDevice) throw new Error("no trusted device");
    const { token, expiresAt } = r.value.trustDevice;
    expect(token).toMatch(/^td_[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toEqual(new Date(now.getTime() + 30 * 86_400_000));
    const [row] = await auth.storage.findMany("trustedDevice", []);
    expect(row).toMatchObject({ userId: user.id, tokenHash: await sha256Hex(token), expiresAt });
    auth.clock.advance(3_600_000);
    const s = await signIn(auth, { trustDevice: token });
    expect(s.ok && "token" in s.value).toBe(true);
    expect((await auth.storage.findMany("trustedDevice", []))[0]?.lastSeenAt).toEqual(
      auth.clock.now(),
    );
  });

  it("does not skip the gate for another user's trust token (Review Focus 3)", async () => {
    const auth = totpAuth();
    await enrolled(auth);
    const bea = await enrolled(auth, "bea@example.com");
    const r = await verify(auth, {
      challenge: await challengeOf(auth, { email: "bea@example.com" }),
      code: await codeNow(auth, bea.secret),
      trustDevice: true,
    });
    if (!r.ok || !r.value.trustDevice) throw new Error("no trusted device");
    const [before] = await auth.storage.findMany("trustedDevice", []);
    auth.clock.advance(3_600_000);
    const s = await signIn(auth, { trustDevice: r.value.trustDevice.token });
    expect(s.ok && "twoFactor" in s.value).toBe(true);
    expect(await auth.storage.findMany("trustedDevice", [])).toEqual([before]);
  });

  it("deletes an expired trusted device and asks for the factor", async () => {
    const auth = totpAuth({ totp: { trustDays: 1 } });
    const { secret } = await enrolled(auth);
    const r = await verify(auth, {
      challenge: await challengeOf(auth),
      code: await codeNow(auth, secret),
      trustDevice: true,
    });
    if (!r.ok || !r.value.trustDevice) throw new Error("no trusted device");
    auth.clock.advance(86_400_000);
    const s = await signIn(auth, { trustDevice: r.value.trustDevice.token });
    expect(s.ok && "twoFactor" in s.value).toBe(true);
    expect(await auth.storage.findMany("trustedDevice", [])).toEqual([]);
  });
});

describe("api.password.verify (plan 9f)", () => {
  it("answers verified for the right password, and invalid_credentials for a wrong one or an unknown user", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    expect(
      await verifyPassword(auth.config, { userId: user.id, password: PASSWORD, ip: null }),
    ).toEqual({ ok: true, value: { verified: true } });
    expect(
      await verifyPassword(auth.config, { userId: user.id, password: "wrong", ip: null }),
    ).toEqual({ ok: false, code: "invalid_credentials", status: 401 });
    expect(
      await verifyPassword(auth.config, { userId: "nobody", password: PASSWORD, ip: null }),
    ).toMatchObject({ code: "invalid_credentials" });
  });

  it("shares the sign-in's limit of 10 per address per 15 minutes", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    // enrolled signed in once.
    for (let i = 0; i < 9; i++)
      await verifyPassword(auth.config, { userId: user.id, password: "wrong", ip: `10.0.0.${i}` });
    expect(
      await verifyPassword(auth.config, { userId: user.id, password: PASSWORD, ip: "10.0.1.1" }),
    ).toEqual({ ok: false, code: "rate_limited", status: 429 });
  });
});
