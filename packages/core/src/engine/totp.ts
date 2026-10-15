import type { ResolvedConfig } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import { ipKey } from "../limiter/ip-key.js";
import { openSealed, seal } from "../primitives/aead.js";
import { appErrorName } from "../primitives/app-error.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { currentSecret, secretFor } from "../primitives/keyring.js";
import { base32Encode, otpauthUri, verifyTotp } from "../primitives/totp.js";
import { fail, ok, type Result } from "../result.js";
import type {
  SecondFactorMethod,
  SecondFactorRow,
  SessionRow,
  TotpRow,
  UserRow,
} from "../schema.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";
import { hookGuard } from "./hooks.js";
import { checkUserPassword } from "./password.js";
import {
  addMethod,
  type ChallengeMethod,
  challengeMethods,
  challengeOrigin,
  disableSecondFactor,
  FactorRaceError,
  factorRow,
  later,
  liveTrust,
  NoBackupCodesError,
  newBackupCodes,
  removeMethod,
  replaceBackupCodes,
  SETUP_PER_USER,
  spendBackupCode,
  TRUST_PREFIX,
  TWO_FACTOR_TOKEN_RE,
  type TwoFactorPending,
  touchTrust,
  writeChallenge,
} from "./second-factor.js";
import { acceptEmailCode, acceptPasskey, liveChallenge } from "./second-factor-methods.js";
import {
  endedList,
  openSession,
  type ResolvedSession,
  sessionOpened,
  sessionsEnded,
} from "./sessions.js";
import { attemptsOf, countAttempt } from "./verification.js";

export type { ChallengeMethod, TwoFactorPending } from "./second-factor.js";
export {
  CHALLENGE_TTL_MS,
  deleteTwoFactorChallenges,
  TRUST_PREFIX,
  TRUST_TOKEN_RE,
  TWO_FACTOR_PREFIX,
  TWO_FACTOR_TOKEN_RE,
} from "./second-factor.js";

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

export interface TotpSetup {
  /** The base32 secret, for a person who types it in. Answered once. */
  secret: string;
  /** The `otpauth://` key URI, for a QR code. Answered once. */
  uri: string;
  /**
   * The backup codes, usable after `enable`. Answered once. Empty when
   * another method is on: the factor keeps its list (plan 12c).
   */
  backupCodes: string[];
}

export interface TotpStatus {
  /** True when the second factor is on, by any method (plan 12c). */
  enabled: boolean;
  enabledAt: Date | null;
  backupCodesLeft: number;
  /** The live trusted devices. */
  trustedDevices: number;
  /** The methods that are on (plan 12c). Empty when the factor is off. */
  methods: SecondFactorMethod[];
  /** 1 for a list of plan 9f, 2 for codes of 112 bits; null when the factor is off (plan 12c). An app asks a user at version 1 to make new codes. */
  backupCodesVersion: number | null;
}

/** The row of a factor that is on, or null. */
function enabledRow(storage: StorageAdapter, userId: string): Promise<TotpRow | null> {
  return storage.findOne("totp", [
    { field: "userId", op: "eq", value: userId },
    { field: "enabledAt", op: "ne", value: null },
  ]);
}

/**
 * An unconfirmed setup that holds backup codes and has not expired (plan
 * 12b). It keys its codes under the row's version too. A reseal would move
 * the secret and leave the codes, and the enable then copies the codes with
 * the wrong version. So no reseal touches it until the enable, a new setup,
 * or the end of its 15 minutes. `api.secrets.rewrap` counts it as skipped.
 */
export function isLiveSetupWithCodes(row: TotpRow, now: Date): boolean {
  const setupCodes = row.enabledAt === null && row.backupCodes.length > 0;
  return setupCodes && row.createdAt.getTime() + SETUP_TTL_MS > now.getTime();
}

/** The secret under the version its row names (plan 12b), or null: another version, another user, or a changed byte. */
function openSecret(config: ResolvedConfig, row: TotpRow): Promise<Uint8Array | null> {
  const secret = secretFor(config.keyring, row.secretVersion, row.id);
  return secret === null
    ? Promise.resolve(null)
    : openSealed(secret, SEAL_INFO, row.secret, row.userId);
}

/**
 * Seals an opened secret again under the current version (plan 12b), after a
 * right code or from `api.secrets.rewrap`. One conditional update on the old
 * sealed value: zero rows means another request resealed it, or a new setup
 * replaced it. True when this call wrote the row. It never throws, so a lost
 * or failed reseal never fails a right code.
 */
async function resealSecret(
  config: ResolvedConfig,
  row: TotpRow,
  plain: Uint8Array,
): Promise<boolean> {
  const { keyring } = config;
  if (row.secretVersion === keyring.current) return false;
  if (isLiveSetupWithCodes(row, config.clock.now())) return false;
  const setupCodes = row.enabledAt === null && row.backupCodes.length > 0;
  // An expired setup stays until its user runs a new setup. Without a
  // reseal, the rewrap never ends. Only the enable reads its codes, and the
  // enable refuses an expired setup, so the reseal clears them. A new setup
  // writes new codes in place.
  try {
    const sealed = await seal(currentSecret(keyring), SEAL_INFO, plain, row.userId);
    const n = await config.storage.update(
      "totp",
      [
        { field: "id", op: "eq", value: row.id },
        { field: "secret", op: "eq", value: row.secret },
      ],
      {
        secret: sealed,
        secretVersion: keyring.current,
        ...(setupCodes ? { backupCodes: [] } : {}),
      },
    );
    return n === 1;
  } catch (e) {
    console.error("authtempo: a TOTP secret reseal failed", row.id, appErrorName(e));
    return false;
  }
}

/** `api.secrets.rewrap` for one TOTP row (plan 12b): true when it moved to the current version. */
export async function rewrapTotpRow(config: ResolvedConfig, row: TotpRow): Promise<boolean> {
  const plain = await openSecret(config, row);
  return plain ? resealSecret(config, row, plain) : false;
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
  const plain = await openSecret(config, row);
  const step = await matchStep(plain, code, now);
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
  if (n !== 1) return false;
  // The reseal leaves `updatedAt`: the compare-and-set of plan 9f on it must not see a reseal as a change.
  if (plain) await resealSecret(config, row, plain);
  return true;
}

/** A code of the app (6 digits) or a backup code (any other text), for the operations that take either. */
async function proveFactor(
  config: ResolvedConfig,
  factor: SecondFactorRow,
  code: string,
  now: Date,
): Promise<boolean> {
  const typed = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(typed)) {
    const row = await enabledRow(config.storage, factor.userId);
    return row !== null && (await acceptCode(config, row, typed, now));
  }
  return (await spendBackupCode(config, factor, code, now)) !== null;
}

/** True when the user's second factor is on (plan 12a): the factor row of plan 12c exists. */
export async function secondFactorOn(config: ResolvedConfig, userId: string): Promise<boolean> {
  return config.totp !== null && (await factorRow(config.storage, userId)) !== null;
}

/**
 * A code of the user's second factor, for the re-authentication (plan
 * 12a): an authenticator code or a backup code, on the per-user code keys
 * of every code check (`totp-code:user`, `totp-code:user-day`).
 * `totp_not_enabled` when no factor is on.
 */
export async function proveUserFactor(
  config: ResolvedConfig,
  userId: string,
  code: string,
): Promise<Result<true>> {
  if (!config.totp) return fail("not_found");
  if (!(await codeCheckAllowed(config, userId))) return fail("rate_limited");
  const factor = await factorRow(config.storage, userId);
  if (!factor) return fail("totp_not_enabled");
  return (await proveFactor(config, factor, code, config.clock.now()))
    ? ok(true)
    : fail("invalid_code");
}

/** The setup's input: the user and the user's password (plan 9f final fix wave, review I-1). */
export interface TotpSetupInput {
  userId: string;
  password: string;
  /**
   * Not read since plan 9h: the setup counts per user only
   * (`totp-setup:user`). Kept so that the callers of plan 9f keep compiling.
   */
  ip?: string | null | undefined;
  issuer?: string | undefined;
}

/**
 * The secret, the key URI, and the backup codes for a new factor (plan 9f).
 * Needs the user's password and a verified email. The password check is
 * `checkUserPassword` under its own key, `totp-setup:user` 5 per 15 minutes
 * (plan 9h), with the dummy verify, and `invalid_credentials` on a miss,
 * before any row write. A session alone
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
  if (!(await config.limiter.allow(`totp-setup:user:${input.userId}`, SETUP_PER_USER)))
    return fail("rate_limited");
  const proved = await checkUserPassword(config, input.userId, input.password);
  if (!proved.ok) return fail(proved.code);
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  // checkUserPassword found the password row; a user deleted since then gets no factor.
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
  // The codes come with the first method only. With another method on, the
  // factor keeps its list, and the setup answers an empty one (plan 12c).
  const factor = await factorRow(config.storage, user.id);
  const { codes, hashes } = factor
    ? { codes: [], hashes: [] }
    : await newBackupCodes(config, totp, id);
  const sealed = await seal(currentSecret(config.keyring), SEAL_INFO, secret, user.id);
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
        // The version that sealed the new secret and keyed the new codes (plan 12b).
        secretVersion: config.keyring.current,
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
        secretVersion: config.keyring.current,
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
 * Thrown inside the TOTP enable's transaction when the setup made backup
 * codes, but another method turned on since (plan 12c). The factor keeps its
 * own list, so the setup's codes would never pass. The throw undoes the
 * confirm; the caller answers `totp_not_enabled`, and a new setup answers no
 * codes.
 */
class StaleSetupCodesError extends Error {
  constructor() {
    super("authtempo: the setup's backup codes no longer apply");
    this.name = "StaleSetupCodesError";
  }
}

/**
 * Confirms the setup with a code of the window (plan 9f) and turns the TOTP
 * method on (plan 12c). As the first method, the factor row takes the totp
 * row's id and the setup's codes, so their hashes stay valid, and every
 * other session of the user ends with `two_factor`; the trusted devices and
 * the challenges go. As a later method, nothing ends. The caller's own
 * session stays.
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
  const ended = endedList(config);
  let done: Result<{ first: boolean }>;
  try {
    done = await config.storage.transaction(async (tx): Promise<Result<{ first: boolean }>> => {
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
        // The setup's codes move to the factor row; this column is unread from version 8 on.
        { enabledAt: now, lastStep: step, backupCodes: [], updatedAt: later(now, row.updatedAt) },
      );
      if (n === 0) return fail("invalid_code");
      const added = await addMethod(
        tx,
        {
          userId: user.id,
          keepSessionId: session.id,
          method: "totp",
          // The setup keyed these codes under the version of its row.
          first: { id: row.id, backupCodes: row.backupCodes, secretVersion: row.secretVersion },
        },
        now,
        ended,
      );
      if (!added.first && row.backupCodes.length > 0) throw new StaleSetupCodesError();
      return ok({ first: added.first });
    });
  } catch (err) {
    // The setup ran while another method was on, so it made no backup codes,
    // and that method went off since. The confirm is undone; a new setup
    // makes the codes.
    if (err instanceof NoBackupCodesError) return fail("totp_not_enabled");
    // The setup's codes were shown, but another method turned on since and
    // the factor keeps its list. The confirm is undone; a new setup answers
    // no codes, and the person keeps the codes of the first method.
    if (err instanceof StaleSetupCodesError) return fail("totp_not_enabled");
    // A parallel first enable of another method won the unique `userId`, or
    // the row changed under every round. Caught here, outside: inside,
    // Postgres has already aborted the transaction. The person retries.
    if (
      err instanceof FactorRaceError ||
      (err instanceof StorageError &&
        err.code === "unique_violation" &&
        err.model === "secondFactor")
    )
      return fail("conflict");
    throw err;
  }
  if (!done.ok) return done;
  if (done.value.first) await sessionsEnded(config, ended, "two_factor");
  return totpStatus(config, { userId: user.id });
}

/**
 * The in-process disable, with no code (plan 9f): it turns every method off
 * (plan 12c). For the operator after identity proofing at the level of the
 * enrollment (ASVS 5.0 6.4.4), and for an app that checked the person another
 * way, such as the compat shim after the password.
 */
export async function disableTotp(
  config: ResolvedConfig,
  input: { userId: string },
): Promise<Result<{ ok: true }>> {
  if (!config.totp) return fail("not_found");
  // Read first: with the factor off the answer is `totp_not_enabled` and
  // nothing is written, so a setup in progress stays.
  if (!(await factorRow(config.storage, input.userId))) return fail("totp_not_enabled");
  if ((await disableSecondFactor(config, input.userId)) === 0) return fail("totp_not_enabled");
  return ok({ ok: true });
}

/**
 * The route's disable of the TOTP method: a current code or a backup code.
 * The last method turns the factor off (plan 12c).
 */
export async function disableTotpWithCode(
  config: ResolvedConfig,
  input: { user: UserRow; code: string },
): Promise<Result<{ ok: true }>> {
  if (!config.totp) return fail("not_found");
  if (!(await codeCheckAllowed(config, input.user.id))) return fail("rate_limited");
  const now = config.clock.now();
  const factor = await factorRow(config.storage, input.user.id);
  const row = await enabledRow(config.storage, input.user.id);
  if (!factor || !row) return fail("totp_not_enabled");
  if (!(await proveFactor(config, factor, input.code, now))) return fail("invalid_code");
  try {
    await config.storage.transaction(async (tx) => {
      await tx.delete("totp", [{ field: "id", op: "eq", value: row.id }]);
      await removeMethod(tx, input.user.id, "totp", now);
    });
  } catch (err) {
    if (err instanceof FactorRaceError) return fail("conflict");
    throw err;
  }
  return ok({ ok: true });
}

/** The in-process regeneration, with no code (plan 9f). */
export async function regenerateBackupCodes(
  config: ResolvedConfig,
  input: { userId: string },
): Promise<Result<{ backupCodes: string[] }>> {
  const totp = config.totp;
  if (!totp) return fail("not_found");
  const factor = await factorRow(config.storage, input.userId);
  if (!factor) return fail("totp_not_enabled");
  return replaceBackupCodes(config, totp, factor, config.clock.now());
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
  const factor = await factorRow(config.storage, input.user.id);
  if (!factor) return fail("totp_not_enabled");
  if (!(await proveFactor(config, factor, input.code, now))) return fail("invalid_code");
  // Read again: a backup code that proved the call was spent from this row.
  const current = await factorRow(config.storage, input.user.id);
  if (!current) return fail("totp_not_enabled");
  return replaceBackupCodes(config, totp, current, now);
}

/** The factor's state. It never answers the secret, the URI, or a code. */
export async function totpStatus(
  config: ResolvedConfig,
  input: { userId: string },
): Promise<Result<TotpStatus>> {
  if (!config.totp) return fail("not_found");
  const now = config.clock.now();
  const factor = await factorRow(config.storage, input.userId);
  const devices = await config.storage.findMany("trustedDevice", [
    { field: "userId", op: "eq", value: input.userId },
    { field: "expiresAt", op: "gt", value: now },
  ]);
  return ok({
    enabled: factor !== null,
    enabledAt: factor?.enabledAt ?? null,
    backupCodesLeft: factor?.backupCodes.length ?? 0,
    trustedDevices: devices.length,
    methods: factor?.methods ?? [],
    backupCodesVersion: factor?.backupCodesVersion ?? null,
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

/** A challenge takes 5 wrong codes (spec 8.11). Its lifetime is `CHALLENGE_TTL_MS`. */
export const CHALLENGE_MAX_ATTEMPTS = 5;
// Per 15 minutes. The challenge cap bounds the guesses per challenge, the
// sign-in's email limit bounds the challenges per address, and
// `CODE_PER_USER` and `CODE_PER_USER_DAY` bound the guesses per user over
// all challenges.
const VERIFY_PER_IP = { seconds: 900, max: 30 };

export interface TwoFactorVerify {
  challenge: string;
  /** A 6-digit code of the app. Exactly one of `code`, `backupCode`, `emailCode`, and `passkey`. */
  code?: string | undefined;
  backupCode?: string | undefined;
  /** The code of `POST /second-factor/email/send` for this challenge (plan 12c). After a password sign-in only. */
  emailCode?: string | undefined;
  /** A WebAuthn assertion over the options of `POST /second-factor/passkey/options` for this challenge (plan 12c). */
  passkey?: unknown;
  /**
   * The clear `td_` token of the page's trusted-device button (plan 12c): a
   * live trust row of the challenge's user passes with no code. A social
   * sign-in from Apple arrives by a cross-site form post with no `Lax`
   * cookie, so the device's trust is read here, on a same-site post.
   */
  trustToken?: string | undefined;
  /** True: write a trusted device and answer its token. */
  trustDevice?: boolean | undefined;
  ip: string | null;
}

/** The one proof of a verify (plan 12c). */
type Proof =
  | { method: "totp"; value: string }
  | { method: "backup"; value: string }
  | { method: "email"; value: string }
  | { method: "passkey"; value: unknown }
  | { method: "trusted"; value: string };

/** The one proof of a verify, or null for none or for more than one. */
function proofOf(input: TwoFactorVerify): Proof | null {
  const proofs: Proof[] = [];
  if (input.code !== undefined) proofs.push({ method: "totp", value: input.code });
  if (input.backupCode !== undefined) proofs.push({ method: "backup", value: input.backupCode });
  if (input.emailCode !== undefined) proofs.push({ method: "email", value: input.emailCode });
  if (input.passkey !== undefined) proofs.push({ method: "passkey", value: input.passkey });
  if (input.trustToken !== undefined) proofs.push({ method: "trusted", value: input.trustToken });
  return proofs.length === 1 ? (proofs[0] ?? null) : null;
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
 * The gate of the password sign-in (owner decision 1b), after the password
 * is proved. `trustId`: no gate (no factor config, no factor on, or a live
 * trust row of this user, read by `liveTrust`), so the sign-in opens its
 * session and then moves the row's `lastSeenAt` with `touchTrust`. Else a
 * challenge in place of the session. The challenge is a session in waiting,
 * so it keeps the sign-in's guard: the conditional update on the proved hash
 * runs after the create, and zero rows (a reset, a change, or a claim since
 * the check) deletes the challenge and refuses.
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
): Promise<{ challenge: Result<TwoFactorPending> } | { trustId: string | null }> {
  if (!config.totp) return { trustId: null };
  const { user } = input;
  const row = await factorRow(config.storage, user.id);
  if (!row) return { trustId: null };
  const trustId = await liveTrust(config.storage, user.id, input.trustDevice, now);
  if (trustId) return { trustId };
  const challenge = await config.storage.transaction(
    async (tx): Promise<Result<TwoFactorPending>> => {
      const { id, pending } = await writeChallenge(
        config,
        tx,
        row,
        {
          userId: user.id,
          via: "password",
          from: "sign-in",
          ip: input.ip,
          userAgent: input.userAgent,
          next: input.next,
        },
        now,
      );
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
      return ok(pending);
    },
  );
  return { challenge };
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
  if (!(await config.limiter.allow(`totp-verify:ip:${ipKey(input.ip)}`, VERIFY_PER_IP)))
    return fail("rate_limited");
  if (!TWO_FACTOR_TOKEN_RE.test(input.challenge)) return fail("invalid_token");
  const proof = proofOf(input);
  if (!proof) return fail("invalid_body");
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
  const factor = await factorRow(config.storage, challenge.identifier);
  if (!factor) return fail("invalid_token");
  // The methods of this challenge, read from the current row (plan 12c): a
  // method that went off after the challenge no longer passes, and an email
  // code never passes after a mailbox proof.
  if (
    proof.method !== "trusted" &&
    !challengeMethods(config, factor, challengeOrigin(challenge.data)).includes(proof.method)
  )
    return fail("invalid_body");
  // The bounds per user over all challenges (15 minutes and 24 hours), shared
  // with the enable, the disable, and the new backup codes. A capped challenge
  // spends only itself, so without this line each new sign-in gives five more
  // guesses. After the live check: an unknown, spent, or expired challenge
  // costs the user nothing. A passkey assertion is no guess: it counts on the
  // challenge only (plan 12c).
  if (
    proof.method !== "passkey" &&
    proof.method !== "trusted" &&
    !(await codeCheckAllowed(config, challenge.identifier))
  )
    return fail("rate_limited");
  const miss = async (): Promise<Result<TwoFactorSession>> =>
    fail(await countAttempt(config.storage, challenge, CHALLENGE_MAX_ATTEMPTS, now));
  // The trust row of the trusted button, for its `lastSeenAt` after the commit.
  let trustId: string | null = null;
  let backupCodesLeft = factor.backupCodes.length;
  if (proof.method === "totp") {
    const row = await enabledRow(config.storage, challenge.identifier);
    if (!row || !(await acceptCode(config, row, proof.value, now))) return miss();
  } else if (proof.method === "backup") {
    // The spend commits here, before the session transaction. So a backup
    // code is spent also when that transaction refuses: a spend of the
    // challenge that matches zero rows (a reset or a change ran), or a
    // `session.beforeCreate` hook that refuses (hookGuard). The person then
    // uses another backup code.
    const left = await spendBackupCode(config, factor, proof.value, now);
    if (left === null) return miss();
    backupCodesLeft = left;
  } else if (proof.method === "email") {
    if (!(await acceptEmailCode(config, challenge, proof.value))) return miss();
  } else if (proof.method === "trusted") {
    // A trust token is 32 random bytes, no guess: a miss counts nothing and
    // answers `invalid_token`, as for a challenge that the page cannot pass.
    trustId = await liveTrust(config.storage, challenge.identifier, proof.value, now);
    if (!trustId) return fail("invalid_token");
  } else if (!(await acceptPasskey(config, challenge, proof.value))) return miss();
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: challenge.identifier },
  ]);
  if (!user) return fail("invalid_token");
  const data = challenge.data as { ip?: unknown; userAgent?: unknown; next?: unknown } | null;
  // The first factor of the challenge: the session keeps its `via` (plan 12c).
  // A row of plan 9f holds `password`.
  const { via } = challengeOrigin(challenge.data);
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
      const s = await openSession(config, { user, ip, userAgent, via }, tx);
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
  if (opened.ok) {
    await touchTrust(config, trustId, now);
    await sessionOpened(config, opened.value.session, opened.value.user, via);
  }
  return opened;
}

/** What the challenge page shows (plan 12c). */
export interface ChallengeView {
  methods: ChallengeMethod[];
  /** A live trust row of the challenge's user matches the request's trust cookie. */
  trusted: boolean;
  /** The challenge holds an email code. */
  emailSent: boolean;
}

/**
 * The reads of the challenge page's GET (plan 12c): the challenge, the factor
 * row, and the trust row. It writes nothing, so a GET changes nothing. An
 * unknown, spent, or expired challenge answers `invalid_token`.
 */
export async function challengeView(
  config: ResolvedConfig,
  input: { challenge: string; trustToken: string | undefined },
): Promise<Result<ChallengeView>> {
  if (!config.totp) return fail("not_found");
  const now = config.clock.now();
  const live = await liveChallenge(config, input.challenge, now);
  if (!live.ok) return live;
  const { row, factor } = live.value;
  return ok({
    methods: challengeMethods(config, factor, challengeOrigin(row.data)),
    trusted: (await liveTrust(config.storage, row.identifier, input.trustToken, now)) !== null,
    emailSent: typeof (row.data as { emailCodeHash?: unknown } | null)?.emailCodeHash === "string",
  });
}
