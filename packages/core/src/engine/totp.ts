import type { ResolvedConfig, ResolvedTotp } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import { openSealed, seal } from "../primitives/aead.js";
import { constantTimeEqual, hmacSha256Hex, randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import {
  base32Encode,
  normalizeBackupCode,
  otpauthUri,
  randomBackupCode,
  verifyTotp,
} from "../primitives/totp.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, TotpRow, UserRow } from "../schema.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";
import { hookGuard } from "./hooks.js";
import { verifyPassword } from "./password.js";
import {
  endSessions,
  openSession,
  type ResolvedSession,
  sessionOpened,
  sessionsEnded,
} from "./sessions.js";
import { attemptsOf, countAttempt } from "./verification.js";

/**
 * The TOTP second factor (plan 9f, spec 8.11). One `totp` row per user
 * holds the sealed secret, the last accepted 30-second step, and the keyed
 * hashes of the backup codes. A code passes once: the check and the write of
 * `lastStep` are one conditional update. The secret is opened for a check
 * only, and no log line holds it, a code, or a URI.
 */

const SEAL_INFO = "tempo-auth totp";
const SECRET_BYTES = 20;
/** One step before and one after now (spec 8.11 item 2): a clock off by up to 30 seconds still passes. */
const TOTP_WINDOW = 1;
/** The compare's secret when the sealed value opens with no key (another app secret): the same three HMACs run. */
const NO_SECRET = new Uint8Array(SECRET_BYTES);
/** An unconfirmed setup confirms within 15 minutes. After that `enable` answers `totp_not_enabled`, and a new setup replaces it. */
export const SETUP_TTL_MS = 15 * 60_000;
// Per 15 minutes, for every code check: the challenge verify, the enable,
// the disable, and the new backup codes. A stolen session must not guess
// codes to turn the factor off, and a capped challenge spends only itself.
const CODE_PER_USER = { seconds: 900, max: 10 };
// Per 24 hours, after `CODE_PER_USER`, on the same code checks (plan 9f
// final fix wave). One guess passes with p = 3 / 10^6 (the three codes of the
// window). With the 15-minute key alone an attacker who has the password
// gets 960 guesses a day: about 8.3 % in 30 days and about 65 % in a year.
// With 30 a day: one account per day about 9 x 10^-5, per year about 3.2 %,
// the same order as the email code's daily figure (spec section 9).
const CODE_PER_USER_DAY = { seconds: 86_400, max: 30 };
/**
 * One code check of the user: true when both per-user keys allow it. Every
 * operation that compares a code or a backup code calls this first.
 */
async function codeCheckAllowed(config: ResolvedConfig, userId: string): Promise<boolean> {
  return (
    (await config.limiter.allow(`totp-code:user:${userId}`, CODE_PER_USER)) &&
    (await config.limiter.allow(`totp-code:user-day:${userId}`, CODE_PER_USER_DAY))
  );
}
/** The rounds of the backup code replacement's compare-and-set. Each lost round means that another write landed first. */
const REPLACE_ROUNDS = 5;

export interface TotpSetup {
  /** The base32 secret, for a person who types it in. Answered once. */
  secret: string;
  /** The `otpauth://` key URI, for a QR code. Answered once. */
  uri: string;
  /** The backup codes, usable after `enable`. Answered once. */
  backupCodes: string[];
}

export interface TotpStatus {
  enabled: boolean;
  enabledAt: Date | null;
  backupCodesLeft: number;
  /** The live trusted devices. */
  trustedDevices: number;
}

/** A write time strictly after `than`, so a compare-and-set on `updatedAt` sees every write. */
function later(now: Date, than: Date): Date {
  return new Date(Math.max(now.getTime(), than.getTime() + 1));
}

/** The row of a factor that is on, or null. */
function enabledRow(storage: StorageAdapter, userId: string): Promise<TotpRow | null> {
  return storage.findOne("totp", [
    { field: "userId", op: "eq", value: userId },
    { field: "enabledAt", op: "ne", value: null },
  ]);
}

function openSecret(config: ResolvedConfig, row: TotpRow): Promise<Uint8Array | null> {
  return openSealed(config.secret, SEAL_INFO, row.secret, row.userId);
}

function backupCodeHash(secret: string, rowId: string, code: string): Promise<string> {
  return hmacSha256Hex(secret, `${rowId}:${code}`);
}

async function newBackupCodes(
  config: ResolvedConfig,
  totp: ResolvedTotp,
  rowId: string,
): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = Array.from({ length: totp.backupCodes }, () =>
    randomBackupCode(totp.backupCodeLength),
  );
  const hashes = await Promise.all(codes.map((c) => backupCodeHash(config.secret, rowId, c)));
  return { codes, hashes };
}

/**
 * The step of a right code within one step of now, or null (spec 8.11 item
 * 2). `verifyTotp` runs the HMAC and `constantTimeEqual` on each step of the
 * window, also for a sealed value that opened with no key, so the time tells
 * nothing.
 */
async function matchStep(
  secret: Uint8Array | null,
  code: string,
  now: Date,
): Promise<number | null> {
  const step = await verifyTotp(secret ?? NO_SECRET, code.replace(/\s/g, ""), now, TOTP_WINDOW);
  return secret === null ? null : step;
}

/**
 * A right code of a factor that is on. The check and the replay guard are
 * one conditional update: `lastStep` moves only when the matched step is
 * later, so a replayed step matches no row. The write leaves `updatedAt`,
 * which versions the backup code list.
 */
async function acceptCode(
  config: ResolvedConfig,
  row: TotpRow,
  code: string,
  now: Date,
): Promise<boolean> {
  const step = await matchStep(await openSecret(config, row), code, now);
  if (step === null) return false;
  const n = await config.storage.update(
    "totp",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "enabledAt", op: "ne", value: null },
      { field: "lastStep", op: "lt", value: step },
    ],
    { lastStep: step },
  );
  return n === 1;
}

/**
 * Spends a backup code: the codes left, or null for a code that is not
 * there. Every stored hash runs the compare. The removal is a
 * compare-and-set on `updatedAt`, so two parallel uses of one code spend it
 * once: the loser reads the row again and no longer finds the code.
 */
async function acceptBackupCode(
  config: ResolvedConfig,
  row: TotpRow,
  code: string,
  now: Date,
): Promise<number | null> {
  const typed = normalizeBackupCode(code);
  let current: TotpRow | null = row;
  // A hard bound, as `countAttempt` has. Each lost round means that a
  // parallel use spent a code, so an honest adapter ends before the list is
  // empty. An adapter whose `eq` on a date never matches loses every round;
  // without the bound one backup code then holds a request forever.
  for (let round = 0; round <= row.backupCodes.length; round++) {
    if (!current || current.enabledAt === null) return null;
    const candidate = await backupCodeHash(config.secret, current.id, typed);
    let found = -1;
    current.backupCodes.forEach((hash, i) => {
      if (constantTimeEqual(candidate, hash)) found = i;
    });
    if (found === -1) return null;
    const left = current.backupCodes.filter((_, i) => i !== found);
    const n = await config.storage.update(
      "totp",
      [
        { field: "id", op: "eq", value: current.id },
        { field: "updatedAt", op: "eq", value: current.updatedAt },
      ],
      { backupCodes: left, updatedAt: later(now, current.updatedAt) },
    );
    if (n === 1) return left.length;
    current = await config.storage.findOne("totp", [{ field: "id", op: "eq", value: current.id }]);
  }
  console.error("tempo-auth: backup code spend gave up", row.id);
  return null;
}

/** A code of the app (6 digits) or a backup code (any other text), for the operations that take either. */
async function proveFactor(
  config: ResolvedConfig,
  row: TotpRow,
  code: string,
  now: Date,
): Promise<boolean> {
  const typed = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(typed)) return acceptCode(config, row, typed, now);
  return (await acceptBackupCode(config, row, code, now)) !== null;
}

/** A challenge is a session in waiting, as a handoff code is: a flow that ends the user's sessions or changes the factor deletes the user's challenges. */
export async function deleteTwoFactorChallenges(tx: StorageAdapter, userId: string): Promise<void> {
  await tx.delete("verification", [
    { field: "purpose", op: "eq", value: "two-factor" },
    { field: "identifier", op: "eq", value: userId },
  ]);
}

/** The setup's input: the user and the user's password (plan 9f final fix wave, review I-1). */
export interface TotpSetupInput {
  userId: string;
  password: string;
  /** The caller's IP, for the password check's per-IP limit. */
  ip?: string | null | undefined;
  issuer?: string | undefined;
}

/**
 * The secret, the key URI, and the backup codes for a new factor (plan 9f).
 * Needs the user's password and a verified email. The password check is
 * `verifyPassword`: the sign-in's limits and its dummy verify, and
 * `invalid_credentials` on a miss, before any row write. A session alone
 * must not set up the factor: a session thief would enroll an own
 * authenticator, the enable would end the owner's sessions, and every later
 * password sign-in of the owner would ask for the thief's code. A factor
 * that is on answers `totp_enabled`; an unconfirmed setup is replaced in
 * place, so one row per user stays. The backup codes pass only after
 * `enable`.
 */
export async function setupTotp(
  config: ResolvedConfig,
  input: TotpSetupInput,
): Promise<Result<TotpSetup>> {
  const totp = config.totp;
  if (!totp) return fail("not_found");
  const proved = await verifyPassword(config, {
    userId: input.userId,
    password: input.password,
    ip: input.ip ?? null,
  });
  if (!proved.ok) return fail(proved.code);
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  // verifyPassword found the user; a user deleted since then gets no factor.
  if (!user) return fail("invalid_credentials");
  if (!user.emailVerified) return fail("email_unverified");
  const now = config.clock.now();
  const existing = await config.storage.findOne("totp", [
    { field: "userId", op: "eq", value: user.id },
  ]);
  if (existing?.enabledAt) return fail("totp_enabled");
  const secret = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(secret);
  const id = existing?.id ?? newId(now);
  const { codes, hashes } = await newBackupCodes(config, totp, id);
  const sealed = await seal(config.secret, SEAL_INFO, secret, user.id);
  if (existing) {
    // In place, and only while unconfirmed: zero rows means an enable confirmed it since the read.
    const n = await config.storage.update(
      "totp",
      [
        { field: "id", op: "eq", value: existing.id },
        { field: "enabledAt", op: "eq", value: null },
      ],
      {
        secret: sealed,
        lastStep: 0,
        backupCodes: hashes,
        createdAt: now,
        updatedAt: later(now, existing.updatedAt),
      },
    );
    if (n === 0) return fail("totp_enabled");
  } else {
    try {
      await config.storage.create("totp", {
        id,
        userId: user.id,
        secret: sealed,
        enabledAt: null,
        lastStep: 0,
        backupCodes: hashes,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      // A parallel setup of the same user won the unique key. No transaction is open here.
      if (err instanceof StorageError && err.code === "unique_violation") return fail("conflict");
      throw err;
    }
  }
  return ok({
    secret: base32Encode(secret),
    uri: otpauthUri({ secret, issuer: input.issuer ?? totp.issuer, account: user.email }),
    backupCodes: codes,
  });
}

/**
 * Confirms the setup with a code of the window (plan 9f). Then every other
 * session of the user ends with `two_factor`, so a session a thief holds
 * does not survive the enable, and the user's trusted devices and challenges
 * go. The caller's own session stays.
 */
export async function enableTotp(
  config: ResolvedConfig,
  input: { session: ResolvedSession; code: string },
): Promise<Result<TotpStatus>> {
  const totp = config.totp;
  if (!totp) return fail("not_found");
  const { user, session } = input.session;
  if (!user.emailVerified) return fail("email_unverified");
  if (!(await codeCheckAllowed(config, user.id))) return fail("rate_limited");
  const now = config.clock.now();
  const row = await config.storage.findOne("totp", [{ field: "userId", op: "eq", value: user.id }]);
  if (row?.enabledAt) return fail("totp_enabled");
  if (!row || row.createdAt.getTime() + SETUP_TTL_MS <= now.getTime())
    return fail("totp_not_enabled");
  const step = await matchStep(await openSecret(config, row), input.code, now);
  if (step === null) return fail("invalid_code");
  const ended: SessionRow[] = [];
  const done = await config.storage.transaction(async (tx): Promise<Result<TotpStatus>> => {
    // The confirm and the replay guard in one statement, as `acceptCode`.
    const n = await tx.update(
      "totp",
      [
        { field: "id", op: "eq", value: row.id },
        { field: "enabledAt", op: "eq", value: null },
        { field: "lastStep", op: "lt", value: step },
        // The row as this call read it: a parallel setup that replaced it
        // after the read wrote another secret and reset `lastStep`, and the
        // code was checked against the old secret. Without this line the
        // enable turns on a secret that no code confirmed.
        { field: "updatedAt", op: "eq", value: row.updatedAt },
      ],
      { enabledAt: now, lastStep: step, updatedAt: later(now, row.updatedAt) },
    );
    if (n === 0) return fail("invalid_code");
    await endSessions(
      tx,
      [
        { field: "userId", op: "eq", value: user.id },
        { field: "id", op: "ne", value: session.id },
      ],
      ended,
    );
    await tx.delete("trustedDevice", [{ field: "userId", op: "eq", value: user.id }]);
    await deleteTwoFactorChallenges(tx, user.id);
    return ok({
      enabled: true,
      enabledAt: now,
      backupCodesLeft: row.backupCodes.length,
      trustedDevices: 0,
    });
  });
  if (done.ok) await sessionsEnded(config, ended, "two_factor");
  return done;
}

/** Deletes the factor, the trusted devices, and the challenges of the user in one transaction. The count of factor rows it deleted. */
function removeTotp(config: ResolvedConfig, userId: string): Promise<number> {
  return config.storage.transaction(async (tx) => {
    const n = await tx.delete("totp", [{ field: "userId", op: "eq", value: userId }]);
    await tx.delete("trustedDevice", [{ field: "userId", op: "eq", value: userId }]);
    await deleteTwoFactorChallenges(tx, userId);
    return n;
  });
}

/** The in-process disable, with no code (plan 9f): for an app that checked the person another way, such as the compat shim after the password. */
export async function disableTotp(
  config: ResolvedConfig,
  input: { userId: string },
): Promise<Result<{ ok: true }>> {
  if (!config.totp) return fail("not_found");
  if (!(await enabledRow(config.storage, input.userId))) return fail("totp_not_enabled");
  await removeTotp(config, input.userId);
  return ok({ ok: true });
}

/** The route's disable: a current code or a backup code. */
export async function disableTotpWithCode(
  config: ResolvedConfig,
  input: { user: UserRow; code: string },
): Promise<Result<{ ok: true }>> {
  if (!config.totp) return fail("not_found");
  if (!(await codeCheckAllowed(config, input.user.id))) return fail("rate_limited");
  const now = config.clock.now();
  const row = await enabledRow(config.storage, input.user.id);
  if (!row) return fail("totp_not_enabled");
  if (!(await proveFactor(config, row, input.code, now))) return fail("invalid_code");
  await removeTotp(config, input.user.id);
  return ok({ ok: true });
}

/** A new list of backup codes, by a compare-and-set on `updatedAt`: a backup code spent at the same time does not come back. */
async function replaceBackupCodes(
  config: ResolvedConfig,
  totp: ResolvedTotp,
  row: TotpRow,
  now: Date,
): Promise<Result<{ backupCodes: string[] }>> {
  let current: TotpRow | null = row;
  // A hard bound, as `countAttempt` has: a lost round means that a parallel
  // spend or replacement wrote first. Past the bound the answer is
  // `conflict`, because the factor is still on.
  for (let round = 0; round < REPLACE_ROUNDS; round++) {
    if (!current || current.enabledAt === null) return fail("totp_not_enabled");
    const { codes, hashes } = await newBackupCodes(config, totp, current.id);
    const n = await config.storage.update(
      "totp",
      [
        { field: "id", op: "eq", value: current.id },
        { field: "updatedAt", op: "eq", value: current.updatedAt },
      ],
      { backupCodes: hashes, updatedAt: later(now, current.updatedAt) },
    );
    if (n === 1) return ok({ backupCodes: codes });
    current = await config.storage.findOne("totp", [{ field: "id", op: "eq", value: current.id }]);
  }
  console.error("tempo-auth: backup code replacement gave up", row.id);
  return fail("conflict");
}

/** The in-process regeneration, with no code (plan 9f). */
export async function regenerateBackupCodes(
  config: ResolvedConfig,
  input: { userId: string },
): Promise<Result<{ backupCodes: string[] }>> {
  const totp = config.totp;
  if (!totp) return fail("not_found");
  const row = await enabledRow(config.storage, input.userId);
  if (!row) return fail("totp_not_enabled");
  return replaceBackupCodes(config, totp, row, config.clock.now());
}

/** The route's regeneration: a current code or a backup code. */
export async function regenerateBackupCodesWithCode(
  config: ResolvedConfig,
  input: { user: UserRow; code: string },
): Promise<Result<{ backupCodes: string[] }>> {
  const totp = config.totp;
  if (!totp) return fail("not_found");
  if (!(await codeCheckAllowed(config, input.user.id))) return fail("rate_limited");
  const now = config.clock.now();
  const row = await enabledRow(config.storage, input.user.id);
  if (!row) return fail("totp_not_enabled");
  if (!(await proveFactor(config, row, input.code, now))) return fail("invalid_code");
  return replaceBackupCodes(config, totp, row, now);
}

/** The factor's state. It never answers the secret, the URI, or a code. */
export async function totpStatus(
  config: ResolvedConfig,
  input: { userId: string },
): Promise<Result<TotpStatus>> {
  if (!config.totp) return fail("not_found");
  const now = config.clock.now();
  const row = await enabledRow(config.storage, input.userId);
  const devices = await config.storage.findMany("trustedDevice", [
    { field: "userId", op: "eq", value: input.userId },
    { field: "expiresAt", op: "gt", value: now },
  ]);
  return ok({
    enabled: row !== null,
    enabledAt: row?.enabledAt ?? null,
    backupCodesLeft: row?.backupCodes.length ?? 0,
    trustedDevices: devices.length,
  });
}

/**
 * The key URI of a factor that is on, in process only (plan 9f): the compat
 * shim answers it after the password, as Better Auth's get-totp-uri does. No
 * route answers it after the setup. A sealed value that opens with no key
 * (the app secret changed) answers `totp_not_enabled`.
 */
export async function totpUri(
  config: ResolvedConfig,
  input: { userId: string },
): Promise<Result<{ uri: string }>> {
  const totp = config.totp;
  if (!totp) return fail("not_found");
  const row = await enabledRow(config.storage, input.userId);
  if (!row) return fail("totp_not_enabled");
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  const secret = await openSecret(config, row);
  if (!user || !secret) return fail("totp_not_enabled");
  return ok({ uri: otpauthUri({ secret, issuer: totp.issuer, account: user.email }) });
}

/** Deletes every trusted device of the user: each next password sign-in asks for the factor. */
export async function revokeTrustedDevices(
  config: ResolvedConfig,
  input: { userId: string },
): Promise<Result<{ ok: true }>> {
  if (!config.totp) return fail("not_found");
  await config.storage.delete("trustedDevice", [
    { field: "userId", op: "eq", value: input.userId },
  ]);
  return ok({ ok: true });
}

export const TWO_FACTOR_PREFIX = "tf_";
export const TWO_FACTOR_TOKEN_RE = /^tf_[A-Za-z0-9_-]{43}$/;
export const TRUST_PREFIX = "td_";
export const TRUST_TOKEN_RE = /^td_[A-Za-z0-9_-]{43}$/;
/** A challenge lives 5 minutes and takes 5 wrong codes (spec 8.11). */
export const CHALLENGE_TTL_MS = 300_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
// Per 15 minutes. The challenge cap bounds the guesses per challenge, the
// sign-in's email limit bounds the challenges per address, and
// `CODE_PER_USER` and `CODE_PER_USER_DAY` bound the guesses per user over
// all challenges.
const VERIFY_PER_IP = { seconds: 900, max: 30 };

/** The sign-in's answer for a user with the factor on: no session yet. */
export interface TwoFactorPending {
  twoFactor: { challenge: string; expiresAt: Date };
}

export interface TwoFactorVerify {
  challenge: string;
  /** A 6-digit code of the app. Exactly one of `code` and `backupCode`. */
  code?: string | undefined;
  backupCode?: string | undefined;
  /** True: write a trusted device and answer its token. */
  trustDevice?: boolean | undefined;
  ip: string | null;
}

export interface TwoFactorSession {
  token: string;
  user: UserRow;
  session: SessionRow;
  next: string;
  trustDevice: { token: string; expiresAt: Date } | null;
  backupCodesLeft: number;
}

/**
 * True for a live trusted device of this user: then it moves `lastSeenAt`.
 * A token of another user's device is no skip and changes nothing. An
 * expired row is deleted.
 */
async function trusted(
  config: ResolvedConfig,
  userId: string,
  token: string | undefined,
  now: Date,
): Promise<boolean> {
  if (token === undefined || !TRUST_TOKEN_RE.test(token)) return false;
  const row = await config.storage.findOne("trustedDevice", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  if (!row || row.userId !== userId) return false;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await config.storage.delete("trustedDevice", [{ field: "id", op: "eq", value: row.id }]);
    return false;
  }
  await config.storage.update("trustedDevice", [{ field: "id", op: "eq", value: row.id }], {
    lastSeenAt: now,
    updatedAt: later(now, row.updatedAt),
  });
  return true;
}

/**
 * The gate of the password sign-in (owner decision 1b), after the password
 * is proved. Null: no gate (no factor config, no factor on, or a trusted
 * device), so the sign-in opens its session. Else a challenge in place of
 * the session. The challenge is a session in waiting, so it keeps the
 * sign-in's guard: the conditional update on the proved hash runs after the
 * create, and zero rows (a reset, a change, or a claim since the check)
 * deletes the challenge and refuses.
 */
export async function twoFactorGate(
  config: ResolvedConfig,
  input: {
    user: UserRow;
    passwordId: string;
    proved: string;
    ip: string | null;
    userAgent: string | null;
    next: string | undefined;
    trustDevice: string | undefined;
  },
  now: Date,
): Promise<Result<TwoFactorPending> | null> {
  if (!config.totp) return null;
  const { user } = input;
  if (!(await enabledRow(config.storage, user.id))) return null;
  if (await trusted(config, user.id, input.trustDevice, now)) return null;
  const challenge = randomToken(TWO_FACTOR_PREFIX);
  const valueHash = await sha256Hex(challenge);
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const id = newId(now);
  return config.storage.transaction(async (tx): Promise<Result<TwoFactorPending>> => {
    await tx.create("verification", {
      id,
      purpose: "two-factor",
      identifier: user.id,
      valueHash,
      expiresAt,
      consumedAt: null,
      data: {
        via: "password",
        ip: input.ip,
        userAgent: input.userAgent,
        next: safeNext(input.next),
        attempts: 0,
      },
      createdAt: now,
      updatedAt: now,
    });
    const n = await tx.update(
      "password",
      [
        { field: "id", op: "eq", value: input.passwordId },
        { field: "hash", op: "eq", value: input.proved },
      ],
      { updatedAt: now },
    );
    if (n === 0) {
      await tx.delete("verification", [{ field: "id", op: "eq", value: id }]);
      return fail("invalid_credentials");
    }
    return ok({ twoFactor: { challenge, expiresAt } });
  });
}

/**
 * The second step of a gated sign-in (plan 9f). A wrong code counts on the
 * challenge (`countAttempt`); the fifth spends it. A right code opens the
 * session with the challenge's IP and user agent. The spend of the
 * challenge is the last statement of the session transaction: a reset or a
 * change deletes the user's challenges before it ends the sessions, so zero
 * rows here means that delete ran, and the verify deletes its own session.
 */
export async function verifyTwoFactor(
  config: ResolvedConfig,
  input: TwoFactorVerify,
): Promise<Result<TwoFactorSession>> {
  const totp = config.totp;
  if (!totp) return fail("not_found");
  if (!(await config.limiter.allow(`totp-verify:ip:${input.ip ?? "unknown"}`, VERIFY_PER_IP)))
    return fail("rate_limited");
  if (!TWO_FACTOR_TOKEN_RE.test(input.challenge)) return fail("invalid_token");
  const { code, backupCode } = input;
  if ((code === undefined) === (backupCode === undefined)) return fail("invalid_body");
  const now = config.clock.now();
  const challenge = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(input.challenge) },
    { field: "purpose", op: "eq", value: "two-factor" },
  ]);
  if (!challenge) return fail("invalid_token");
  if (challenge.consumedAt !== null)
    return fail(
      attemptsOf(challenge) >= CHALLENGE_MAX_ATTEMPTS ? "too_many_attempts" : "invalid_token",
    );
  if (challenge.expiresAt.getTime() <= now.getTime()) return fail("invalid_token");
  // The bounds per user over all challenges (15 minutes and 24 hours), shared
  // with the enable, the disable, and the new backup codes. A capped challenge
  // spends only itself, so without this line each new sign-in gives five more
  // guesses. After the live check: an unknown, spent, or expired challenge
  // costs the user nothing.
  if (!(await codeCheckAllowed(config, challenge.identifier))) return fail("rate_limited");
  const row = await enabledRow(config.storage, challenge.identifier);
  if (!row) return fail("invalid_token");
  let backupCodesLeft = row.backupCodes.length;
  if (code !== undefined) {
    if (!(await acceptCode(config, row, code, now)))
      return fail(await countAttempt(config.storage, challenge, CHALLENGE_MAX_ATTEMPTS, now));
  } else {
    // The spend commits here, before the session transaction. So a backup
    // code is spent also when that transaction refuses: a spend of the
    // challenge that matches zero rows (a reset or a change ran), or a
    // `session.beforeCreate` hook that refuses (hookGuard). The person then
    // uses another backup code.
    const left = await acceptBackupCode(config, row, backupCode ?? "", now);
    if (left === null)
      return fail(await countAttempt(config.storage, challenge, CHALLENGE_MAX_ATTEMPTS, now));
    backupCodesLeft = left;
  }
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: challenge.identifier },
  ]);
  if (!user) return fail("invalid_token");
  const data = challenge.data as { ip?: unknown; userAgent?: unknown; next?: unknown } | null;
  const ip = typeof data?.ip === "string" ? data.ip : null;
  const userAgent = typeof data?.userAgent === "string" ? data.userAgent : null;
  const next = safeNext(data?.next);
  const trust = input.trustDevice
    ? {
        id: newId(now),
        token: randomToken(TRUST_PREFIX),
        expiresAt: new Date(now.getTime() + totp.trustDays * 86_400_000),
      }
    : null;
  const trustHash = trust ? await sha256Hex(trust.token) : null;
  const opened = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<TwoFactorSession>> => {
      const s = await openSession(config, { user, ip, userAgent, via: "password" }, tx);
      if (trust && trustHash)
        await tx.create("trustedDevice", {
          id: trust.id,
          userId: user.id,
          tokenHash: trustHash,
          expiresAt: trust.expiresAt,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        });
      const n = await tx.update(
        "verification",
        [
          { field: "id", op: "eq", value: challenge.id },
          { field: "consumedAt", op: "eq", value: null },
          { field: "expiresAt", op: "gt", value: now },
        ],
        { consumedAt: now, updatedAt: later(now, challenge.updatedAt) },
      );
      if (n === 0) {
        await tx.delete("session", [{ field: "id", op: "eq", value: s.session.id }]);
        if (trust) await tx.delete("trustedDevice", [{ field: "id", op: "eq", value: trust.id }]);
        return fail("invalid_token");
      }
      return ok({
        token: s.token,
        user,
        session: s.session,
        next,
        trustDevice: trust ? { token: trust.token, expiresAt: trust.expiresAt } : null,
        backupCodesLeft,
      });
    }),
  );
  // After the commit, as every flow does (plan 9d).
  if (opened.ok) await sessionOpened(config, opened.value.session, opened.value.user, "password");
  return opened;
}
