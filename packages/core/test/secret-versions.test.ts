import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { type Auth, createAuth } from "../src/create-auth.js";
import { passwordSignIn } from "../src/engine/password.js";
import { spendBackupCode } from "../src/engine/second-factor.js";
import { sendSecondFactorEmail } from "../src/engine/second-factor-methods.js";
import { resolveSession } from "../src/engine/sessions.js";
import { enableTotp, rewrapTotpRow, setupTotp } from "../src/engine/totp.js";
import { decodeJws } from "../src/primitives/jwk.js";
import type { SecretVersion } from "../src/primitives/keyring.js";
import { base32Decode, totpCode } from "../src/primitives/totp.js";
import { createPbkdf2PasswordHash } from "../src/seams/password-hash.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";

// Plan 12b, spec 22: each sealed value and keyed hash opens only under the
// secret version its row names. The constants are today's format: sealed
// and keyed under S1 by the script of Task 3 Step 1 (2026-10-14).
const S1 = "0123456789abcdef0123456789abcdef";
const S2 = "q8JxVd3m0Yv2sZ7rKpT4wN1hLc9eFgAuBiOjQyRtSxM";
const FIXTURE = {
  USER: "01JA0000000000000000000U01",
  TOTP_ROW: "01JA0000000000000000000F01",
  CODE_ROW: "01JA0000000000000000000V01",
  KID: "01JA0000000000000000000K01",
  SEED: new TextEncoder().encode("12345678901234567890"),
  BACKUP_CODE: "abcdefghjkmnpqrstuvwxyz",
  totpSecret: "SWin9Y1RRRj6YkkVfy5-luxKZF4vxNeSG6Mt17ObL_-He9p2A59cbqENi8p6VdfG",
  backup: "c8c0349d14dfc018ebe38ded2bfa48f86b73243591477e6078db848857648bc2",
  emailCode: "bb1d22ea66c7bf224c0330cb72a21197b848f5b36de041155f04458ea85954e6",
  sealedKey:
    "6u5VaH28W20j98N_jHLVXlOCxpiON3uiriz3ztv6Ungoti3rQeX1QpUQHih4CC0vZ3rHWMkdMqSgG8JF4J7q9qObO_HoVMRCKGeyRg",
  publicX: "kXYZaBTU_U5cuAlObolJDssrWSRQ76yGOJv5qSdbTnU",
};
const EMAIL = "ada@example.com";
// The email code's address has no account and no factor: plan 12c gates the
// email code sign-in of a user with the factor on.
const CODE_EMAIL = "bo@example.com";
const PW = "correct horse battery";
const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const ONE: SecretVersion[] = [{ version: 1, value: S1 }];
const PHASE_1: SecretVersion[] = [
  { version: 1, value: S1 },
  { version: 2, value: S2 },
];
const PHASE_2: SecretVersion[] = [
  { version: 2, value: S2 },
  { version: 1, value: S1 },
];

function world() {
  let current = new Date("2026-10-14T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const storage = createMemoryAdapter();
  const mail: Array<{ to: string; text: string }> = [];
  const input = (secrets: SecretVersion[]): AuthConfig => ({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    storage,
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock,
    secrets,
    password: { hash: FAST },
  });
  const auth = (secrets: SecretVersion[]): Auth => createAuth(input(secrets));
  // The engine view of the same storage and clock, for the calls that `api` does not name.
  const config = (secrets: SecretVersion[]) => resolveConfig(input(secrets));
  return { clock, storage, mail, auth, config };
}

/** The rows of a database of today: every value sealed or keyed under S1, every row at version 1. */
async function seedToday(storage: StorageAdapter, at: Date): Promise<void> {
  const base = { createdAt: at, updatedAt: at };
  await storage.create("user", {
    id: FIXTURE.USER,
    email: EMAIL,
    emailVerified: true,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    ...base,
  });
  await storage.create("password", {
    id: "01JA0000000000000000000P01",
    userId: FIXTURE.USER,
    hash: await FAST.hash(PW),
    ...base,
  });
  await storage.create("totp", {
    id: FIXTURE.TOTP_ROW,
    userId: FIXTURE.USER,
    secret: FIXTURE.totpSecret,
    enabledAt: at,
    lastStep: 0,
    backupCodes: [FIXTURE.backup],
    secretVersion: 1,
    ...base,
  });
  // Plan 12c's factor row, copied from totp with the same id, so the backup code hash holds.
  await storage.create("secondFactor", {
    id: FIXTURE.TOTP_ROW,
    userId: FIXTURE.USER,
    enabledAt: at,
    methods: ["totp"],
    backupCodes: [FIXTURE.backup],
    backupCodesVersion: 2,
    secretVersion: 1,
    ...base,
  });
  await storage.create("verification", {
    id: FIXTURE.CODE_ROW,
    purpose: "email-otp",
    identifier: CODE_EMAIL,
    valueHash: FIXTURE.emailCode,
    expiresAt: new Date(at.getTime() + 600_000),
    consumedAt: null,
    data: { attempts: 0 },
    secretVersion: 1,
    ...base,
  });
  await storage.create("jwk", {
    id: FIXTURE.KID,
    publicJwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: FIXTURE.publicX,
      kid: FIXTURE.KID,
      alg: "EdDSA",
      use: "sig",
    },
    privateKey: FIXTURE.sealedKey,
    slot: "signing",
    retiredAt: null,
    secretVersion: 1,
    ...base,
  });
}

/** The password sign-in, then the challenge verify with a code of the seed. */
async function passFactor(auth: Auth, at: Date): Promise<boolean> {
  const signIn = await auth.api.password?.signIn({
    email: EMAIL,
    password: PW,
    ip: null,
    userAgent: null,
  });
  if (!signIn?.ok || !("twoFactor" in signIn.value)) return false;
  const verified = await auth.api.totp?.verify({
    challenge: signIn.value.twoFactor.challenge,
    code: await totpCode(FIXTURE.SEED, at),
    ip: null,
  });
  return verified?.ok === true;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secret versions on read and write (plan 12b)", () => {
  it("opens the values of today's format under version 1 after version 2 is added", async () => {
    for (const secrets of [ONE, PHASE_1, PHASE_2]) {
      const w = world();
      await seedToday(w.storage, w.clock.now());
      const auth = w.auth(secrets);
      w.clock.advance(30_000);
      expect({ secrets: secrets.length, totp: await passFactor(auth, w.clock.now()) }).toEqual({
        secrets: secrets.length,
        totp: true,
      });
      const code = await auth.api.emailOtp?.verify({
        email: CODE_EMAIL,
        code: "123456",
        ip: null,
        userAgent: null,
      });
      expect(code?.ok).toBe(true);
      // The address has no factor, so the answer is a session, never a challenge.
      if (!code?.ok || !("session" in code.value)) throw new Error("no session");
      const minted = await auth.api.jwt?.mint({
        userId: code.value.user.id,
        sessionId: code.value.session.id,
      });
      expect(minted?.ok).toBe(true);
      if (!minted?.ok) throw new Error("no token");
      expect(decodeJws(minted.value.token)?.header.kid).toBe(FIXTURE.KID);
      expect(await auth.api.jwt?.verify(minted.value.token)).not.toBeNull();
    }
  });

  it("passes a backup code of today's format under version 2", async () => {
    const w = world();
    await seedToday(w.storage, w.clock.now());
    const auth = w.auth(PHASE_2);
    const signIn = await auth.api.password?.signIn({
      email: EMAIL,
      password: PW,
      ip: null,
      userAgent: null,
    });
    if (!signIn?.ok || !("twoFactor" in signIn.value)) throw new Error("no challenge");
    const verified = await auth.api.totp?.verify({
      challenge: signIn.value.twoFactor.challenge,
      backupCode: FIXTURE.BACKUP_CODE,
      ip: null,
    });
    expect(verified?.ok).toBe(true);
  });

  it("reseals the TOTP secret and the signing key under the current version at their next use", async () => {
    const w = world();
    await seedToday(w.storage, w.clock.now());
    const auth = w.auth(PHASE_2);
    w.clock.advance(30_000);
    expect(await passFactor(auth, w.clock.now())).toBe(true);
    const totp = await w.storage.findOne("totp", [
      { field: "id", op: "eq", value: FIXTURE.TOTP_ROW },
    ]);
    expect(totp?.secretVersion).toBe(2);
    expect(totp?.secret).not.toBe(FIXTURE.totpSecret);
    const session = (await w.storage.findMany("session", []))[0];
    if (!session) throw new Error("no session");
    expect((await auth.api.jwt?.mint({ userId: FIXTURE.USER, sessionId: session.id }))?.ok).toBe(
      true,
    );
    const key = await w.storage.findOne("jwk", [{ field: "id", op: "eq", value: FIXTURE.KID }]);
    expect({ secretVersion: key?.secretVersion, slot: key?.slot }).toEqual({
      secretVersion: 2,
      slot: "signing",
    });
    expect(key?.privateKey).not.toBe(FIXTURE.sealedKey);
    // The resealed values open under version 2 alone: version 1 can go.
    const only2 = w.auth([{ version: 2, value: S2 }]);
    w.clock.advance(30_000);
    expect(await passFactor(only2, w.clock.now())).toBe(true);
    const again = await only2.api.jwt?.mint({ userId: FIXTURE.USER, sessionId: session.id });
    expect(again?.ok && decodeJws(again.value.token)?.header.kid).toBe(FIXTURE.KID);
  });

  it("writes every new value under the current version", async () => {
    const w = world();
    await seedToday(w.storage, w.clock.now());
    const auth = w.auth(PHASE_2);
    expect((await auth.api.emailOtp?.request({ email: "new@example.com", ip: null }))?.ok).toBe(
      true,
    );
    const row = await w.storage.findOne("verification", [
      { field: "identifier", op: "eq", value: "new@example.com" },
    ]);
    expect(row?.secretVersion).toBe(2);
    // The keyed hash of the new row is under S2: the code from the mail passes under version 2 alone.
    const code = /\b(\d{6})\b/.exec(w.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const only2 = w.auth([{ version: 2, value: S2 }]);
    expect(
      (
        await only2.api.emailOtp?.verify({
          email: "new@example.com",
          code,
          ip: null,
          userAgent: null,
        })
      )?.ok,
    ).toBe(true);
  });

  it("answers a value under a version that the config does not hold as a wrong secret, with one log line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world();
    await seedToday(w.storage, w.clock.now());
    await w.storage.update("verification", [{ field: "id", op: "eq", value: FIXTURE.CODE_ROW }], {
      secretVersion: 9,
    });
    const auth = w.auth(PHASE_2);
    const code = await auth.api.emailOtp?.verify({
      email: CODE_EMAIL,
      code: "123456",
      ip: null,
      userAgent: null,
    });
    expect(code).toMatchObject({ ok: false, code: "invalid_code" });
    expect(log).toHaveBeenCalledWith(
      "authtempo: a stored value names secret version 9, which is not configured",
      FIXTURE.CODE_ROW,
    );
  });

  it("writes the version of the new secret when a setup replaces an unconfirmed one", async () => {
    const w = world();
    const at = w.clock.now();
    await w.storage.create("user", {
      id: "01JA0000000000000000000U02",
      email: "cy@example.com",
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      createdAt: at,
      updatedAt: at,
    });
    await w.storage.create("password", {
      id: "01JA0000000000000000000P02",
      userId: "01JA0000000000000000000U02",
      hash: await FAST.hash(PW),
      createdAt: at,
      updatedAt: at,
    });
    const userId = "01JA0000000000000000000U02";
    const first = await setupTotp(w.config(ONE), { userId, password: PW });
    expect(first.ok).toBe(true);
    // The second setup runs after the switch to version 2 and replaces the first in place.
    const setup = await setupTotp(w.config(PHASE_2), { userId, password: PW });
    if (!setup.ok) throw new Error(setup.code);
    const row = await w.storage.findOne("totp", [{ field: "userId", op: "eq", value: userId }]);
    expect(row?.secretVersion).toBe(2);
    // The secret and the backup codes of the new setup open under version 2 alone.
    const only2 = w.config([{ version: 2, value: S2 }]);
    const signIn = await passwordSignIn(only2, {
      email: "cy@example.com",
      password: PW,
      ip: null,
      userAgent: null,
    });
    if (!signIn.ok || !("token" in signIn.value)) throw new Error("no session");
    const session = await resolveSession(only2, signIn.value.token);
    if (!session) throw new Error("no session");
    const enabled = await enableTotp(only2, {
      session,
      code: await totpCode(base32Decode(setup.value.secret), w.clock.now()),
    });
    expect(enabled.ok).toBe(true);
    const factor = await w.storage.findOne("secondFactor", [
      { field: "userId", op: "eq", value: userId },
    ]);
    if (!factor) throw new Error("no factor row");
    expect(factor.secretVersion).toBe(2);
    const code = setup.value.backupCodes[0] ?? "";
    expect(await spendBackupCode(only2, factor, code, w.clock.now())).toBe(
      setup.value.backupCodes.length - 1,
    );
  });

  it("leaves an unconfirmed setup with backup codes under its version at a rewrap", async () => {
    const w = world();
    await seedToday(w.storage, w.clock.now());
    // An unconfirmed setup: its backup codes are keyed under the row's version too.
    await w.storage.update("totp", [{ field: "id", op: "eq", value: FIXTURE.TOTP_ROW }], {
      enabledAt: null,
    });
    const cfg = w.config(PHASE_2);
    const setup = await w.storage.findOne("totp", [
      { field: "id", op: "eq", value: FIXTURE.TOTP_ROW },
    ]);
    if (!setup) throw new Error("no totp row");
    expect(await rewrapTotpRow(cfg, setup)).toBe(false);
    const after = await w.storage.findOne("totp", [
      { field: "id", op: "eq", value: FIXTURE.TOTP_ROW },
    ]);
    expect({ secret: after?.secret, secretVersion: after?.secretVersion }).toEqual({
      secret: FIXTURE.totpSecret,
      secretVersion: 1,
    });
    // An enabled row has moved its codes to the factor row: the rewrap moves it.
    await w.storage.update("totp", [{ field: "id", op: "eq", value: FIXTURE.TOTP_ROW }], {
      enabledAt: w.clock.now(),
    });
    const enabled = await w.storage.findOne("totp", [
      { field: "id", op: "eq", value: FIXTURE.TOTP_ROW },
    ]);
    if (!enabled) throw new Error("no totp row");
    expect(await rewrapTotpRow(cfg, enabled)).toBe(true);
    const moved = await w.storage.findOne("totp", [
      { field: "id", op: "eq", value: FIXTURE.TOTP_ROW },
    ]);
    expect(moved?.secretVersion).toBe(2);
  });

  it("reseals an expired setup with backup codes at a rewrap and clears its codes", async () => {
    const w = world();
    await seedToday(w.storage, w.clock.now());
    await w.storage.update("totp", [{ field: "id", op: "eq", value: FIXTURE.TOTP_ROW }], {
      enabledAt: null,
    });
    // The setup lives 15 minutes from `createdAt`: at that moment it is expired.
    w.clock.advance(15 * 60_000);
    const setup = await w.storage.findOne("totp", [
      { field: "id", op: "eq", value: FIXTURE.TOTP_ROW },
    ]);
    if (!setup) throw new Error("no totp row");
    expect(await rewrapTotpRow(w.config(PHASE_2), setup)).toBe(true);
    const moved = await w.storage.findOne("totp", [
      { field: "id", op: "eq", value: FIXTURE.TOTP_ROW },
    ]);
    expect({ secretVersion: moved?.secretVersion, backupCodes: moved?.backupCodes }).toEqual({
      secretVersion: 2,
      backupCodes: [],
    });
    expect(moved?.secret).not.toBe(FIXTURE.totpSecret);
  });

  it("keys the email code of a challenge under the version that its send writes", async () => {
    const w = world();
    await seedToday(w.storage, w.clock.now());
    await w.storage.update("secondFactor", [{ field: "id", op: "eq", value: FIXTURE.TOTP_ROW }], {
      methods: ["totp", "email"],
    });
    // The challenge row is written under version 1; the send runs after the switch to version 2.
    const signIn = await w.auth(ONE).api.password?.signIn({
      email: EMAIL,
      password: PW,
      ip: null,
      userAgent: null,
    });
    if (!signIn?.ok || !("twoFactor" in signIn.value)) throw new Error("no challenge");
    const challenge = signIn.value.twoFactor.challenge;
    expect((await sendSecondFactorEmail(w.config(PHASE_2), { challenge })).ok).toBe(true);
    const code = /\b(\d{6})\b/.exec(w.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const verified = await w.auth([{ version: 2, value: S2 }]).api.totp?.verify({
      challenge,
      emailCode: code,
      ip: null,
    });
    expect(verified?.ok).toBe(true);
  });
});
