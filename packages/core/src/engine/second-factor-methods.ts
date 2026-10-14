import type { ResolvedConfig } from "../config.js";
import { sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
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
  newBackupCodes,
  removeMethod,
  SETUP_PER_USER,
  TWO_FACTOR_TOKEN_RE,
} from "./second-factor.js";
import { endedList, type ResolvedSession, sessionsEnded } from "./sessions.js";

/**
 * The second-factor methods beside TOTP (plan 12c, spec 8.14): a passkey and
 * an email code. Each enable takes the password, on the setup's key, as the
 * TOTP setup does: a session thief must not turn the factor on, because the
 * enable of the first method ends the owner's sessions.
 */

// Per 15 minutes per IP, for the passkey options of a challenge. The same
// budget as the passkey sign-in options (`passkey-options:ip`, plan 4).
const PASSKEY_OPTIONS_PER_IP = { seconds: 900, max: 30 };

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
 * passkey: the count runs after `addMethod` holds the row, so a parallel
 * delete of the last passkey either waits for this commit or finds the
 * method on.
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
          first: { id, backupCodes: hashes },
        },
        now,
        ended,
      );
      if (
        method === "passkey" &&
        (await tx.findMany("passkey", [{ field: "userId", op: "eq", value: session.user.id }]))
          .length === 0
      )
        throw new NoPasskeyError();
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
      `second-factor-passkey:ip:${input.ip ?? "unknown"}`,
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
