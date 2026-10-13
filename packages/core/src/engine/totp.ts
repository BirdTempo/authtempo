import type { ResolvedConfig, ResolvedTotp } from "../config.js";
import { openSealed, seal } from "../primitives/aead.js";
import { constantTimeEqual, hmacSha256Hex } from "../primitives/crypto.js";
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
import { endSessions, type ResolvedSession, sessionsEnded } from "./sessions.js";

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
const SETUP_TTL_MS = 15 * 60_000;
// Per 15 minutes, for every operation that takes a code with a session: a
// stolen session must not guess codes to turn the factor off.
const CODE_PER_USER = { seconds: 900, max: 10 };

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
  while (current && current.enabledAt !== null) {
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

/**
 * The secret, the key URI, and the backup codes for a new factor (plan 9f).
 * Needs a verified email. A factor that is on answers `totp_enabled`; an
 * unconfirmed setup is replaced in place, so one row per user stays. The
 * backup codes pass only after `enable`.
 */
export async function setupTotp(
  config: ResolvedConfig,
  input: { user: UserRow; issuer?: string | undefined },
): Promise<Result<TotpSetup>> {
  const totp = config.totp;
  if (!totp) return fail("not_found");
  const { user } = input;
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
  if (!(await config.limiter.allow(`totp-code:user:${user.id}`, CODE_PER_USER)))
    return fail("rate_limited");
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
  if (!(await config.limiter.allow(`totp-code:user:${input.user.id}`, CODE_PER_USER)))
    return fail("rate_limited");
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
  while (current && current.enabledAt !== null) {
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
  return fail("totp_not_enabled");
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
  if (!(await config.limiter.allow(`totp-code:user:${input.user.id}`, CODE_PER_USER)))
    return fail("rate_limited");
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
