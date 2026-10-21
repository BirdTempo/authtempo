import { describe, expect, it, vi } from "vitest";
import { passwordSignIn, passwordSignUp } from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import {
  disableTotp,
  disableTotpWithCode,
  enableTotp,
  regenerateBackupCodes,
  regenerateBackupCodesWithCode,
  revokeTrustedDevices,
  setupTotp,
  totpStatus,
  totpUri,
  verifyTwoFactor,
} from "../src/engine/totp.js";
import { countAttempt } from "../src/engine/verification.js";
import { openSealed } from "../src/primitives/aead.js";
import { hmacSha256Hex } from "../src/primitives/crypto.js";
import { currentSecret } from "../src/primitives/keyring.js";
import { base32Decode, normalizeBackupCode, otpauthUri, totpCode } from "../src/primitives/totp.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { DEFAULT_OBSERVE, makeAuth } from "./helpers.js";
import { upSession } from "./password-helpers.js";
import {
  codeNow,
  EMAIL,
  enrolled,
  PASSWORD,
  totpAuth,
  verifiedSession,
  wrongFor,
} from "./totp-helpers.js";

describe("the setup (plan 9f)", () => {
  it("answers the secret, the key URI, and ten backup codes, and stores the secret sealed and the codes as keyed hashes (Review Focus 5)", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    const r = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!r.ok) throw new Error(r.code);
    const { secret, uri, backupCodes } = r.value;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri).toBe(
      otpauthUri({ secret: base32Decode(secret), issuer: "api.example.com", account: EMAIL }),
    );
    expect(backupCodes).toHaveLength(10);
    for (const c of backupCodes)
      expect(normalizeBackupCode(c)).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{23}$/);
    const [row] = await auth.storage.findMany("totp", []);
    expect(row).toMatchObject({ userId: session.user.id, enabledAt: null, lastStep: 0 });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(secret);
    for (const c of backupCodes) expect(stored).not.toContain(c);
    expect(row?.backupCodes).toEqual(
      await Promise.all(
        backupCodes.map((c) =>
          hmacSha256Hex(currentSecret(auth.config.keyring), `${row?.id}:${normalizeBackupCode(c)}`),
        ),
      ),
    );
    expect(
      await openSealed(
        currentSecret(auth.config.keyring),
        "tempo-auth totp",
        row?.secret ?? "",
        session.user.id,
      ),
    ).toEqual(base32Decode(secret));
    expect(
      await openSealed(
        "another secret of 32 characters!",
        "tempo-auth totp",
        row?.secret ?? "",
        session.user.id,
      ),
    ).toBeNull();
  });

  it("refuses a wrong password with invalid_credentials and writes no row: a session alone sets up no factor (review I-1)", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    expect(
      await setupTotp(auth.config, { userId: session.user.id, password: "not the password" }),
    ).toEqual({ ok: false, code: "invalid_credentials", status: 401 });
    expect(await auth.storage.findMany("totp", [])).toEqual([]);
    expect(
      await setupTotp(auth.config, { userId: "no such user", password: PASSWORD }),
    ).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(await auth.storage.findMany("totp", [])).toEqual([]);
  });

  it("counts a wrong setup password on its own key, 5 per user per 15 minutes, and not on the sign-in's limits (plan 9h, owner decision 3a)", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    const setup = (password: string) =>
      setupTotp(auth.config, { userId: session.user.id, password, ip: "6.6.6.6" });
    for (let i = 0; i < 5; i++)
      expect(await setup("not the password")).toMatchObject({ code: "invalid_credentials" });
    expect(await setup(PASSWORD)).toEqual({ ok: false, code: "rate_limited", status: 429 });
    expect(await auth.storage.findMany("totp", [])).toEqual([]);
    // The owner's sign-in keeps its whole budget of 10 per address: verifiedSession
    // took 1, and 8 wrong and 1 right make 10. Before plan 9h the five setup misses
    // counted on password:email too, and the right sign-in answered rate_limited.
    const signIn = (password: string) =>
      passwordSignIn(auth.config, { email: EMAIL, password, ip: "5.5.5.5", userAgent: null });
    for (let i = 0; i < 8; i++)
      expect(await signIn("not the password")).toMatchObject({ code: "invalid_credentials" });
    expect((await signIn(PASSWORD)).ok).toBe(true);
    auth.clock.advance(15 * 60_000);
    expect((await setup(PASSWORD)).ok).toBe(true);
  });

  it("takes the issuer, the count, and the length from the config, and an issuer from the call", async () => {
    const auth = totpAuth({ totp: { issuer: "Acme", backupCodes: 5, backupCodeLength: 30 } });
    const session = await verifiedSession(auth);
    const r = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.uri.startsWith("otpauth://totp/Acme:ada%40example.com?")).toBe(true);
    expect(r.value.backupCodes).toHaveLength(5);
    expect(normalizeBackupCode(r.value.backupCodes[0] ?? "")).toHaveLength(30);
    const custom = await setupTotp(auth.config, {
      userId: session.user.id,
      password: PASSWORD,
      issuer: "Other",
    });
    expect(custom.ok && custom.value.uri).toContain("&issuer=Other&");
  });

  it("refuses an unverified user with email_unverified, and a user whose factor is on with totp_enabled", async () => {
    const auth = totpAuth();
    const up = await passwordSignUp(auth.config, {
      email: "bea@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    expect(
      await setupTotp(auth.config, { userId: upSession(up.value).user.id, password: PASSWORD }),
    ).toEqual({
      ok: false,
      code: "email_unverified",
      status: 403,
    });
    const { user } = await enrolled(auth);
    expect(await setupTotp(auth.config, { userId: user.id, password: PASSWORD })).toEqual({
      ok: false,
      code: "totp_enabled",
      status: 409,
    });
  });

  it("replaces an unconfirmed setup, so the code of the first secret no longer enables", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    const first = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    const second = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!first.ok || !second.ok) throw new Error("setup");
    expect(await auth.storage.findMany("totp", [])).toHaveLength(1);
    const a = await codeNow(auth, base32Decode(first.value.secret));
    const b = await codeNow(auth, base32Decode(second.value.secret));
    // One time in a million the two codes are equal.
    if (a !== b)
      expect(await enableTotp(auth.config, { session, code: a })).toMatchObject({
        code: "invalid_code",
      });
    expect((await enableTotp(auth.config, { session, code: b })).ok).toBe(true);
  });

  it("confirms only within 15 minutes of the setup, and answers totp_not_enabled with no setup", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    const r = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!r.ok) throw new Error(r.code);
    auth.clock.advance(15 * 60_000);
    const code = await codeNow(auth, base32Decode(r.value.secret));
    expect(await enableTotp(auth.config, { session, code })).toEqual({
      ok: false,
      code: "totp_not_enabled",
      status: 400,
    });
    const other = await verifiedSession(auth, "bea@example.com");
    expect(await enableTotp(auth.config, { session: other, code: "123456" })).toMatchObject({
      code: "totp_not_enabled",
    });
  });
});

describe("the enable (plan 9f)", () => {
  it("refuses a wrong code and a code two steps old, enables with a code of the window, and answers the status", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    const r = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!r.ok) throw new Error(r.code);
    const secret = base32Decode(r.value.secret);
    const now = auth.clock.now();
    expect(
      await enableTotp(auth.config, { session, code: wrongFor(await codeNow(auth, secret)) }),
    ).toEqual({ ok: false, code: "invalid_code", status: 400 });
    const old = await totpCode(secret, new Date(now.getTime() - 60_000));
    const previous = await totpCode(secret, new Date(now.getTime() - 30_000));
    const window = [
      previous,
      await codeNow(auth, secret),
      await totpCode(secret, new Date(now.getTime() + 30_000)),
    ];
    // About three times in a million the old code equals a code of the window.
    if (!window.includes(old))
      expect(await enableTotp(auth.config, { session, code: old })).toMatchObject({
        code: "invalid_code",
      });
    expect(await enableTotp(auth.config, { session, code: previous })).toEqual({
      ok: true,
      value: {
        enabled: true,
        enabledAt: now,
        backupCodesLeft: 10,
        trustedDevices: 0,
        methods: ["totp"],
        backupCodesVersion: 2,
      },
    });
    const [row] = await auth.storage.findMany("totp", []);
    expect(row?.lastStep).toBe(Math.floor(now.getTime() / 30_000) - 1);
  });

  it("ends every other session with two_factor, keeps the enabler's, and deletes the trusted devices (Review Focus 4)", async () => {
    const ended: { id: string; reason: string }[] = [];
    const auth = totpAuth({
      hooks: {
        session: {
          afterEnd(e) {
            ended.push({ id: e.session.id, reason: e.reason });
          },
        },
      },
    });
    const mine = await verifiedSession(auth, EMAIL, "1.1.1.1");
    const thief = await verifiedSession(auth, EMAIL, "6.6.6.6");
    const now = auth.clock.now();
    await auth.storage.create("trustedDevice", {
      id: "d1",
      userId: mine.user.id,
      tokenHash: "h1",
      expiresAt: new Date(now.getTime() + 86_400_000),
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const r = await setupTotp(auth.config, { userId: mine.user.id, password: PASSWORD });
    if (!r.ok) throw new Error(r.code);
    const code = await codeNow(auth, base32Decode(r.value.secret));
    // The verify link of the sign-up also opened a session: it is another device too.
    const others = (
      await auth.storage.findMany("session", [{ field: "userId", op: "eq", value: mine.user.id }])
    )
      .filter((s) => s.id !== mine.session.id)
      .map((s) => s.id);
    expect(others).toContain(thief.session.id);
    ended.length = 0;
    expect((await enableTotp(auth.config, { session: mine, code })).ok).toBe(true);
    expect(ended.map((e) => e.id).sort()).toEqual([...others].sort());
    for (const e of ended) expect(e.reason).toBe("two_factor");
    expect(
      await auth.storage.findMany("session", [{ field: "userId", op: "eq", value: mine.user.id }]),
    ).toHaveLength(1);
    expect(await resolveSession(auth.config, thief.token)).toBeNull();
    expect((await resolveSession(auth.config, mine.token))?.session.id).toBe(mine.session.id);
    expect(await auth.storage.findMany("trustedDevice", [])).toEqual([]);
  });

  it("refuses an enable whose row a parallel setup replaced after the read: no unchecked secret turns on", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    const r = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!r.ok) throw new Error(r.code);
    const code = await codeNow(auth, base32Decode(r.value.secret));
    let replaced = false;
    // The enable reads the row and checks the code, then opens its transaction:
    // a second setup runs in that gap and writes another secret.
    const storage: StorageAdapter = {
      ...auth.storage,
      transaction: async (fn) => {
        if (!replaced) {
          replaced = true;
          const again = await setupTotp(auth.config, {
            userId: session.user.id,
            password: PASSWORD,
          });
          if (!again.ok) throw new Error(again.code);
        }
        return auth.storage.transaction(fn);
      },
    };
    expect(await enableTotp({ ...auth.config, storage }, { session, code })).toEqual({
      ok: false,
      code: "invalid_code",
      status: 400,
    });
    expect(replaced).toBe(true);
    const rows = await auth.storage.findMany("totp", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabledAt).toBeNull();
  });

  it("answers totp_enabled for a second enable", async () => {
    const auth = totpAuth();
    const { session, secret } = await enrolled(auth);
    expect(await enableTotp(auth.config, { session, code: await codeNow(auth, secret) })).toEqual({
      ok: false,
      code: "totp_enabled",
      status: 409,
    });
  });
});

describe("disable, backup codes, status, and devices (plan 9f)", () => {
  it("disables with a current code; a wrong code keeps the factor", async () => {
    const auth = totpAuth();
    const { user, secret } = await enrolled(auth);
    expect(
      await disableTotpWithCode(auth.config, { user, code: wrongFor(await codeNow(auth, secret)) }),
    ).toEqual({ ok: false, code: "invalid_code", status: 400 });
    expect(await auth.storage.findMany("totp", [])).toHaveLength(1);
    expect(
      await disableTotpWithCode(auth.config, { user, code: await codeNow(auth, secret) }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(await auth.storage.findMany("totp", [])).toEqual([]);
    expect(await totpStatus(auth.config, { userId: user.id })).toMatchObject({
      ok: true,
      value: { enabled: false },
    });
  });

  it("disables with a backup code, typed in upper case and with a dash", async () => {
    const auth = totpAuth();
    const { user, backupCodes } = await enrolled(auth);
    const code = backupCodes[0] ?? "";
    const typed = `${code.slice(0, 4).toUpperCase()}-${code.slice(4)}`;
    expect((await disableTotpWithCode(auth.config, { user, code: typed })).ok).toBe(true);
  });

  it("refuses a replayed step on a code route and accepts the next one (Review Focus 1)", async () => {
    const auth = totpAuth();
    const { user, secret } = await enrolled(auth);
    const code = await codeNow(auth, secret);
    expect((await regenerateBackupCodesWithCode(auth.config, { user, code })).ok).toBe(true);
    expect(await regenerateBackupCodesWithCode(auth.config, { user, code })).toEqual({
      ok: false,
      code: "invalid_code",
      status: 400,
    });
    auth.clock.advance(30_000);
    const next = await codeNow(auth, secret);
    expect((await regenerateBackupCodesWithCode(auth.config, { user, code: next })).ok).toBe(true);
  });

  it("regenerates the backup codes: an old code fails and a new code works", async () => {
    const auth = totpAuth();
    const { user, secret, backupCodes } = await enrolled(auth);
    const r = await regenerateBackupCodesWithCode(auth.config, {
      user,
      code: await codeNow(auth, secret),
    });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.backupCodes).toHaveLength(10);
    expect(r.value.backupCodes).not.toContain(backupCodes[0]);
    expect(
      await disableTotpWithCode(auth.config, { user, code: backupCodes[0] ?? "" }),
    ).toMatchObject({ code: "invalid_code" });
    expect(
      (await disableTotpWithCode(auth.config, { user, code: r.value.backupCodes[0] ?? "" })).ok,
    ).toBe(true);
  });

  it("answers the status: off, unconfirmed, on, and the live trusted devices only", async () => {
    const auth = totpAuth();
    const session = await verifiedSession(auth);
    const off = {
      enabled: false,
      enabledAt: null,
      backupCodesLeft: 0,
      trustedDevices: 0,
      methods: [],
      backupCodesVersion: null,
    };
    expect(await totpStatus(auth.config, { userId: session.user.id })).toEqual({
      ok: true,
      value: off,
    });
    const r = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
    if (!r.ok) throw new Error(r.code);
    expect(await totpStatus(auth.config, { userId: session.user.id })).toEqual({
      ok: true,
      value: off,
    });
    const at = auth.clock.now();
    const code = await codeNow(auth, base32Decode(r.value.secret));
    expect((await enableTotp(auth.config, { session, code })).ok).toBe(true);
    const device = (id: string, expiresAt: Date) =>
      auth.storage.create("trustedDevice", {
        id,
        userId: session.user.id,
        tokenHash: `h-${id}`,
        expiresAt,
        lastSeenAt: at,
        createdAt: at,
        updatedAt: at,
      });
    await device("live", new Date(at.getTime() + 60_000));
    await device("old", new Date(at.getTime() - 60_000));
    expect(await totpStatus(auth.config, { userId: session.user.id })).toEqual({
      ok: true,
      value: {
        enabled: true,
        enabledAt: at,
        backupCodesLeft: 10,
        trustedDevices: 1,
        methods: ["totp"],
        backupCodesVersion: 2,
      },
    });
  });

  it("revokes every trusted device of the user, and no other user's", async () => {
    const auth = totpAuth();
    const at = auth.clock.now();
    const device = (id: string, userId: string) =>
      auth.storage.create("trustedDevice", {
        id,
        userId,
        tokenHash: `h-${id}`,
        expiresAt: new Date(at.getTime() + 60_000),
        lastSeenAt: at,
        createdAt: at,
        updatedAt: at,
      });
    await device("a1", "ua");
    await device("a2", "ua");
    await device("b1", "ub");
    expect(await revokeTrustedDevices(auth.config, { userId: "ua" })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect((await auth.storage.findMany("trustedDevice", [])).map((r) => r.id)).toEqual(["b1"]);
  });

  it("limits the code routes to 10 per user per 15 minutes", async () => {
    const auth = totpAuth();
    const { user, secret } = await enrolled(auth);
    const wrong = wrongFor(await codeNow(auth, secret));
    // The enable of `enrolled` took the first of the 10.
    for (let i = 0; i < 9; i++)
      expect(await disableTotpWithCode(auth.config, { user, code: wrong })).toMatchObject({
        code: "invalid_code",
      });
    expect(
      await disableTotpWithCode(auth.config, { user, code: await codeNow(auth, secret) }),
    ).toEqual({ ok: false, code: "rate_limited", status: 429 });
  });

  it("limits the code checks to 30 per user per 24 hours over every operation: the thirty-first answers rate_limited, and a check 24 hours on is allowed", async () => {
    const auth = totpAuth();
    const { user, secret, session } = await enrolled(auth);
    // The enable of `enrolled` took the first of the 30, 30 seconds ago.
    const start = auth.clock.now().getTime() - 30_000;
    const wrong = async () => wrongFor(await codeNow(auth, secret));
    // Each 15-minute window takes 10: 1 + 9, then 10, then 10 in three windows.
    for (let i = 0; i < 9; i++)
      expect(await disableTotpWithCode(auth.config, { user, code: await wrong() })).toMatchObject({
        code: "invalid_code",
      });
    auth.clock.advance(15 * 60_000);
    for (let i = 0; i < 10; i++)
      expect(
        await regenerateBackupCodesWithCode(auth.config, { user, code: await wrong() }),
      ).toMatchObject({ code: "invalid_code" });
    auth.clock.advance(15 * 60_000);
    const challenge = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: "2.2.2.2",
      userAgent: null,
    });
    if (!challenge.ok || !("twoFactor" in challenge.value)) throw new Error("no challenge");
    const tf = challenge.value.twoFactor.challenge;
    for (let i = 0; i < 5; i++)
      await verifyTwoFactor(auth.config, { challenge: tf, code: await wrong(), ip: "2.2.2.2" });
    for (let i = 0; i < 5; i++)
      expect(await disableTotpWithCode(auth.config, { user, code: await wrong() })).toMatchObject({
        code: "invalid_code",
      });
    // A new 15-minute window: only the daily limit refuses now, on each operation.
    auth.clock.advance(15 * 60_000);
    const limited = { ok: false, code: "rate_limited", status: 429 };
    const fresh = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: "2.2.2.2",
      userAgent: null,
    });
    if (!fresh.ok || !("twoFactor" in fresh.value)) throw new Error("no challenge");
    const right = await codeNow(auth, secret);
    expect(
      await verifyTwoFactor(auth.config, {
        challenge: fresh.value.twoFactor.challenge,
        code: right,
        ip: "2.2.2.2",
      }),
    ).toEqual(limited);
    expect(await disableTotpWithCode(auth.config, { user, code: right })).toEqual(limited);
    expect(await regenerateBackupCodesWithCode(auth.config, { user, code: right })).toEqual(
      limited,
    );
    expect(await enableTotp(auth.config, { session, code: right })).toEqual(limited);
    // 24 hours after the first check the daily window ends.
    auth.clock.advance(start + 86_400_000 - auth.clock.now().getTime());
    expect(
      await disableTotpWithCode(auth.config, { user, code: await codeNow(auth, secret) }),
    ).toEqual({ ok: true, value: { ok: true } });
  });

  it("takes a user id and no code in the in-process forms: uri, regenerate, and disable", async () => {
    const auth = totpAuth();
    const { user, secret } = await enrolled(auth);
    expect(await totpUri(auth.config, { userId: user.id })).toEqual({
      ok: true,
      value: { uri: otpauthUri({ secret, issuer: "api.example.com", account: EMAIL }) },
    });
    const r = await regenerateBackupCodes(auth.config, { userId: user.id });
    expect(r.ok && r.value.backupCodes).toHaveLength(10);
    expect(await disableTotp(auth.config, { userId: user.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    for (const call of [totpUri, regenerateBackupCodes, disableTotp])
      expect(await call(auth.config, { userId: user.id })).toMatchObject({
        code: "totp_not_enabled",
      });
  });

  it("answers not_found with totp: false, and resolves no factor without a password config", async () => {
    const off = totpAuth({ totp: false });
    const session = await verifiedSession(off);
    expect(
      await setupTotp(off.config, { userId: session.user.id, password: PASSWORD }),
    ).toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(await totpStatus(off.config, { userId: session.user.id })).toMatchObject({
      code: "not_found",
    });
    expect(makeAuth().config.totp).toBeNull();
  });

  it("bounds the backup code spend to the codes + 1 rounds when an update never matches, and logs", async () => {
    const auth = totpAuth();
    const { user, backupCodes } = await enrolled(auth);
    let updates = 0;
    const storage: StorageAdapter = {
      ...auth.storage,
      update: async () => {
        updates += 1;
        // A guard: without the bound the loop never ends; fail instead of hanging.
        if (updates > 100) throw new Error("the backup code spend did not stop");
        return 0;
      },
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await disableTotpWithCode(
          { ...auth.config, storage },
          { user, code: backupCodes[0] ?? "" },
        ),
      ).toEqual({ ok: false, code: "invalid_code", status: 400 });
      expect(updates).toBe(backupCodes.length + 1);
      const [row] = await auth.storage.findMany("totp", []);
      expect(errors).toHaveBeenCalledWith("authtempo: backup code spend gave up", row?.id);
    } finally {
      errors.mockRestore();
    }
  });

  it("bounds the backup code replacement to 5 rounds when an update never matches, and logs", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    let updates = 0;
    const storage: StorageAdapter = {
      ...auth.storage,
      update: async () => {
        updates += 1;
        if (updates > 100) throw new Error("the backup code replacement did not stop");
        return 0;
      },
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await regenerateBackupCodes({ ...auth.config, storage }, { userId: user.id })).toEqual(
        { ok: false, code: "conflict", status: 409 },
      );
      expect(updates).toBe(5);
      const [row] = await auth.storage.findMany("totp", []);
      expect(errors).toHaveBeenCalledWith("authtempo: backup code replacement gave up", row?.id);
    } finally {
      errors.mockRestore();
    }
  });

  it("counts an attempt and keeps the other keys of data (countAttempt)", async () => {
    const auth = totpAuth();
    const now = auth.clock.now();
    const row = await auth.storage.create("verification", {
      id: "v1",
      purpose: "two-factor",
      identifier: "u1",
      valueHash: "h1",
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
      data: { next: "/x", attempts: 0 },
      createdAt: now,
      updatedAt: now,
      secretVersion: 1,
    });
    expect(await countAttempt(DEFAULT_OBSERVE, auth.storage, row, 5, now)).toBe("invalid_code");
    expect(
      (await auth.storage.findOne("verification", [{ field: "id", op: "eq", value: "v1" }]))?.data,
    ).toEqual({ next: "/x", attempts: 1 });
  });

  it("spends only the capped challenge at the cap, not another challenge of the same user (countAttempt)", async () => {
    const auth = totpAuth();
    const now = auth.clock.now();
    const challenge = (id: string) =>
      auth.storage.create("verification", {
        id,
        purpose: "two-factor",
        identifier: "u1",
        valueHash: `h-${id}`,
        expiresAt: new Date(now.getTime() + 60_000),
        consumedAt: null,
        data: { attempts: 4 },
        createdAt: now,
        updatedAt: now,
        secretVersion: 1,
      });
    await challenge("other");
    const capped = await challenge("capped");
    expect(await countAttempt(DEFAULT_OBSERVE, auth.storage, capped, 5, now)).toBe(
      "too_many_attempts",
    );
    const rows = await auth.storage.findMany("verification", []);
    expect(rows.find((r) => r.id === "capped")?.consumedAt).toEqual(now);
    expect(rows.find((r) => r.id === "other")?.consumedAt).toBeNull();
  });
});
