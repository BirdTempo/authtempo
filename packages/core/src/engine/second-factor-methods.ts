import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { constantTimeEqual, hmacSha256Hex, randomDigits, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { currentSecret, hashSecretFor } from "../primitives/keyring.js";
import { fail, ok, type Result } from "../result.js";
import type { SecondFactorMethod, SecondFactorRow, UserRow, VerificationRow } from "../schema.js";
import type { PublicKeyCredentialRequestOptionsJSON } from "../seams/webauthn.js";
import { StorageError } from "../storage/port.js";
import {
  checkSecondFactorPasskey,
  checkSignInAssertionOf,
  secondFactorPasskeyOptions,
} from "./passkeys.js";
import { checkUserPassword } from "./password.js";
import {
  addMethod,
  challengeMethods,
  challengeOrigin,
  FactorRaceError,
  factorRow,
  later,
  newBackupCodes,
  removeMethod,
  SETUP_PER_USER,
  TWO_FACTOR_TOKEN_RE,
} from "./second-factor.js";
import { endedList, type ResolvedSession, sessionsEnded } from "./sessions.js";
import { MAILED_CODES_PER_EMAIL_DAY } from "./verification.js";

/**
 * The second-factor methods beside TOTP (plan 12c, spec 8.14): a passkey and
 * an email code. Each enable takes the password, on the setup's key, as the
 * TOTP setup does: a session thief must not turn the factor on, because the
 * enable of the first method ends the owner's sessions.
 */

// Per 15 minutes per IP, for the passkey options of a challenge. The same
// budget as the passkey sign-in options (`passkey-options:ip`, plan 4).
const PASSKEY_OPTIONS_PER_IP = { seconds: 900, max: 30 };
// Per 15 minutes per user, for the second-factor code mails over all
// challenges: a person with the password must not fill the mailbox.
const EMAIL_SENDS_PER_USER = { seconds: 900, max: 5 };
// The mails of one challenge. A new send replaces the code, so one code is
// live per challenge; 3 covers a slow mail and a typo.
const SENDS_PER_CHALLENGE = 3;
// The digits of the code: one guess passes with 10^-6. With the per-user
// code keys (30 a day) one account admits about 3 x 10^-5 per day and about
// 1.1 % per year to a person with the password and not the mailbox.
const EMAIL_CODE_DIGITS = 6;
/** The compare's stored value when no code was sent: the same HMAC and compare run. */
const NO_HASH = "0".repeat(64);

/** The stored value of a second-factor email code: HMAC-SHA256 under the app secret of `<challenge row id>:<code>`. */
function emailCodeHash(secret: string, challengeId: string, code: string): Promise<string> {
  return hmacSha256Hex(secret, `${challengeId}:${code}`);
}

/** A method's enable: the methods that are on, and the backup codes, answered once for the first method (else empty). */
export interface MethodEnabled {
  methods: SecondFactorMethod[];
  backupCodes: string[];
}

/** Thrown inside the enable's transaction when no passkey is left for the passkey method. The throw undoes the method. */
class NoPasskeyError extends Error {
  constructor() {
    super("authtempo: no passkey for the passkey method");
    this.name = "NoPasskeyError";
  }
}

/** The password of an enable or a disable, on the setup's key `totp-setup:user` (spec 8.11, plan 9h). */
export async function provePassword(
  config: ResolvedConfig,
  userId: string,
  password: string,
): Promise<Result<true>> {
  if (!(await config.limiter.allow(`totp-setup:user:${userId}`, SETUP_PER_USER)))
    return fail("rate_limited");
  const proved = await checkUserPassword(config, userId, password);
  return proved.ok ? ok(true) : fail(proved.code);
}

/**
 * Turns a method on for the session's user, after the caller's proofs. The
 * first method writes the row with new backup codes and ends the other
 * sessions with `two_factor` (`addMethod`). The passkey method needs a
 * passkey. After `addMethod`, the enable writes `updatedAt` of every passkey
 * row of the user, so it holds those rows until its commit. Zero rows: no
 * passkey, and the throw undoes the method. A parallel `deletePasskey` waits
 * on its delete of a held row and then reads the committed factor row, so it
 * sees the method on (Postgres READ COMMITTED). Both take the factor row
 * first and the passkey rows second, so neither waits on the other in turn.
 */
export async function enableMethod(
  config: ResolvedConfig,
  session: ResolvedSession,
  method: SecondFactorMethod,
): Promise<Result<MethodEnabled>> {
  const totp = config.totp;
  if (!totp) return fail("not_found");
  const now = config.clock.now();
  const id = newId(now);
  const { codes, hashes } = await newBackupCodes(config, totp, id);
  const ended = endedList(config);
  let added: { first: boolean; row: SecondFactorRow };
  try {
    added = await config.storage.transaction(async (tx) => {
      const a = await addMethod(
        tx,
        {
          userId: session.user.id,
          keepSessionId: session.session.id,
          method,
          first: { id, backupCodes: hashes, secretVersion: config.keyring.current },
        },
        now,
        ended,
      );
      if (method === "passkey") {
        const held = await tx.update(
          "passkey",
          [{ field: "userId", op: "eq", value: session.user.id }],
          { updatedAt: now },
        );
        if (held === 0) throw new NoPasskeyError();
      }
      return a;
    });
  } catch (err) {
    if (err instanceof NoPasskeyError) return fail("passkey_failed");
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
  if (added.first) await sessionsEnded(config, ended, "two_factor");
  return ok({ methods: added.row.methods, backupCodes: added.first ? codes : [] });
}

/**
 * Turns the passkey method on (plan 12c). Needs a verified address, the
 * password, and a sign-in assertion of one of the user's passkeys: the
 * assertion proves that the person holds a passkey now.
 */
export async function enablePasskeyMethod(
  config: ResolvedConfig,
  input: { session: ResolvedSession; password: string; response: unknown },
): Promise<Result<MethodEnabled>> {
  if (!config.totp || !config.passkey) return fail("not_found");
  const { user } = input.session;
  if (!user.emailVerified) return fail("email_unverified");
  const proved = await provePassword(config, user.id, input.password);
  if (!proved.ok) return proved;
  if (!(await checkSignInAssertionOf(config, { userId: user.id, response: input.response })))
    return fail("passkey_failed");
  return enableMethod(config, input.session, "passkey");
}

/**
 * Turns the passkey or the email method off with the password (plan 12c).
 * The last method turns the factor off (`removeMethod`). `totp_not_enabled`:
 * the method is not on. The TOTP method keeps its own disable with a code.
 */
export async function disableMethod(
  config: ResolvedConfig,
  input: { user: UserRow; method: "passkey" | "email"; password: string },
): Promise<Result<{ ok: true; methods: SecondFactorMethod[] }>> {
  if (!config.totp) return fail("not_found");
  const proved = await provePassword(config, input.user.id, input.password);
  if (!proved.ok) return proved;
  const now = config.clock.now();
  try {
    const removed = await config.storage.transaction((tx) =>
      removeMethod(tx, input.user.id, input.method, now),
    );
    if (!removed) return fail("totp_not_enabled");
  } catch (err) {
    if (err instanceof FactorRaceError) return fail("conflict");
    throw err;
  }
  const left = await factorRow(config.storage, input.user.id);
  return ok({ ok: true, methods: left?.methods ?? [] });
}

/** A live challenge and the factor row of its user, or `invalid_token`: unknown, spent, expired, or no factor. */
export async function liveChallenge(
  config: ResolvedConfig,
  challenge: string,
  now: Date,
): Promise<Result<{ row: VerificationRow; factor: SecondFactorRow }>> {
  if (!TWO_FACTOR_TOKEN_RE.test(challenge)) return fail("invalid_token");
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(challenge) },
    { field: "purpose", op: "eq", value: "two-factor" },
  ]);
  if (!row || row.consumedAt !== null || row.expiresAt.getTime() <= now.getTime())
    return fail("invalid_token");
  const factor = await factorRow(config.storage, row.identifier);
  if (!factor) return fail("invalid_token");
  return ok({ row, factor });
}

/**
 * The WebAuthn request options of one challenge (plan 12c). `invalid_body`:
 * the challenge offers no passkey (no passkey method, or no passkey config).
 */
export async function passkeyChallengeOptions(
  config: ResolvedConfig,
  input: { challenge: string; ip: string | null },
): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> {
  if (!config.totp || !config.passkey) return fail("not_found");
  if (
    !(await config.limiter.allow(
      `second-factor-passkey:ip:${ipKey(input.ip)}`,
      PASSKEY_OPTIONS_PER_IP,
    ))
  )
    return fail("rate_limited");
  const live = await liveChallenge(config, input.challenge, config.clock.now());
  if (!live.ok) return live;
  const { row, factor } = live.value;
  if (!challengeMethods(config, factor, challengeOrigin(row.data)).includes("passkey"))
    return fail("invalid_body");
  return secondFactorPasskeyOptions(config, { userId: row.identifier, challengeId: row.id });
}

/** True for an assertion of the user's passkey over this challenge's options. */
export function acceptPasskey(
  config: ResolvedConfig,
  challenge: VerificationRow,
  response: unknown,
): Promise<boolean> {
  return checkSecondFactorPasskey(config, {
    userId: challenge.identifier,
    challengeId: challenge.id,
    response,
  });
}

/**
 * Turns the email method on (plan 12c). Needs a verified address and the
 * password; the address is the user's own, so the enable sends no code. An
 * email code proves the mailbox, which a reset also proves: for a user whose
 * only method is the email code, a person who holds the mailbox resets the
 * password and passes the code. The threat model page (concepts) says so.
 */
export async function enableEmailMethod(
  config: ResolvedConfig,
  input: { session: ResolvedSession; password: string },
): Promise<Result<MethodEnabled>> {
  if (!config.totp) return fail("not_found");
  const { user } = input.session;
  if (!user.emailVerified) return fail("email_unverified");
  const proved = await provePassword(config, user.id, input.password);
  if (!proved.ok) return proved;
  return enableMethod(config, input.session, "email");
}

/**
 * Mails a 6-digit code bound to one challenge (plan 12c, ASVS 5.0 6.6.2).
 * The challenge must offer `email`: a password sign-in only (owner decision
 * 4). The order of the checks: the challenge, the method, the per-challenge
 * cap of 3, then the per-user key and the daily key of the address,
 * so a refusal before the limiters costs no budget. The code's keyed hash
 * replaces the last one in the challenge's `data` by a compare-and-set on
 * `updatedAt`; the mail goes after the write, never inside a transaction.
 */
export async function sendSecondFactorEmail(
  config: ResolvedConfig,
  input: { challenge: string },
): Promise<Result<{ sent: true }>> {
  const totp = config.totp;
  if (!totp) return fail("not_found");
  const now = config.clock.now();
  const live = await liveChallenge(config, input.challenge, now);
  if (!live.ok) return live;
  const { row, factor } = live.value;
  if (!challengeMethods(config, factor, challengeOrigin(row.data)).includes("email"))
    return fail("invalid_body");
  const data: Record<string, unknown> = { ...(row.data ?? {}) };
  const sends = typeof data.emailSends === "number" ? data.emailSends : 0;
  if (sends >= SENDS_PER_CHALLENGE) return fail("rate_limited");
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: row.identifier },
  ]);
  if (!user) return fail("invalid_token");
  if (!(await config.limiter.allow(`second-factor-email:user:${user.id}`, EMAIL_SENDS_PER_USER)))
    return fail("rate_limited");
  if (!(await config.limiter.allow(`totp:email-day:${user.email}`, MAILED_CODES_PER_EMAIL_DAY)))
    return fail("rate_limited");
  const code = randomDigits(EMAIL_CODE_DIGITS);
  // One compare-and-set on the challenge row: a parallel send or a counted
  // guess that wrote first makes this match zero rows. `countAttempt` keeps
  // the other keys of `data`, so a guess never drops the code.
  const n = await config.storage.update(
    "verification",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "consumedAt", op: "eq", value: null },
      { field: "updatedAt", op: "eq", value: row.updatedAt },
    ],
    {
      data: {
        ...data,
        emailCodeHash: await emailCodeHash(currentSecret(config.keyring), row.id, code),
        emailSends: sends + 1,
        emailSentAt: now.toISOString(),
      },
      updatedAt: later(now, row.updatedAt),
      // The version that keys `emailCodeHash` (plan 12b). The challenge row holds no other keyed value.
      secretVersion: config.keyring.current,
    },
  );
  if (n === 0) return fail("conflict");
  // The code lives with its challenge: at most 5 minutes (ASVS 5.0 6.5.5 allows 10).
  const ttlMinutes = Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 60_000));
  const message = totp.emailMail({ email: user.email, code, ttlMinutes, appName: config.appName });
  // To the user's address, whatever the builder wrote, as the email code sign-in does.
  await config.mail.send({ ...message, to: user.email });
  return ok({ sent: true });
}

/**
 * True for the code of this challenge's last send (plan 12c). One HMAC and
 * one compare on every path. The code passes once: the verify spends the
 * challenge as the last statement of its session transaction.
 */
export async function acceptEmailCode(
  config: ResolvedConfig,
  challenge: VerificationRow,
  code: string,
): Promise<boolean> {
  const stored = (challenge.data as { emailCodeHash?: unknown } | null)?.emailCodeHash;
  // The row's version keys the HMAC (plan 12b); an unknown version matches nothing.
  const key = hashSecretFor(config.keyring, challenge.secretVersion, challenge.id);
  const candidate = await emailCodeHash(key.secret, challenge.id, code.replace(/\s/g, ""));
  const right = constantTimeEqual(candidate, typeof stored === "string" ? stored : NO_HASH);
  return typeof stored === "string" && right && key.known;
}
