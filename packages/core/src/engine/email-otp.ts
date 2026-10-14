import { checkCaptcha } from "../captcha.js";
import type { ResolvedConfig } from "../config.js";
import { constantTimeEqual, hmacSha256Hex, randomDigits } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { currentSecret, hashSecretFor } from "../primitives/keyring.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow, VerificationRow } from "../schema.js";
import type { Sort, StorageAdapter, Where } from "../storage/port.js";
import { hookGuard } from "./hooks.js";
import { resetWithProof } from "./password.js";
import { gatedSteps, type TwoFactorPending, touchTrust } from "./second-factor.js";
import { endedList, sessionOpened, sessionsEnded } from "./sessions.js";
import { findOrCreateUserByEmail, normalizeEmail, signUpGuard } from "./users.js";
import { attemptsOf, countAttempt, MAILED_CODES_PER_EMAIL_DAY } from "./verification.js";

/**
 * Email codes (plan 9e, spec 8.10). A code is a proof of the address, as a
 * magic link is, and follows the magic link's rules. What differs is the
 * secret: a code of 6 digits has one million values, so the engine bounds
 * the guesses per code (`maxAttempts`), keys the stored hash with the app
 * secret, and keeps one live code per address and purpose.
 */

export type EmailOtpPurpose = "email-otp" | "password-reset-otp";

// Per 15 minutes, for the sign-in code and the reset code together: one
// budget per address and per IP for every mailed code. 3 per address is the
// verify mail resend's limit (password.ts), not the magic link's 5: with
// `maxAttempts` guesses per code, it bounds the guesses on one address.
const REQUEST_PER_IP = { seconds: 900, max: 20 };
const REQUEST_PER_EMAIL = { seconds: 900, max: 3 };
// Per 24 hours, for both purposes, checked after the 15-minute keys. The
// 15-minute keys alone let one address take 960 guesses a day: about 1 in
// 1,040 per day and about 30 % per year for a patient attacker. 20 codes a
// day at `maxAttempts` 5 gives at most 100 guesses a day: about 1 in 10,000
// per day and about 3.6 % per year, and the victim gets 20 mails a day.
// The value is MAILED_CODES_PER_EMAIL_DAY (verification.ts); the second-factor code has its own key.

// Per 15 minutes, shared by the sign-in verify and the reset.
const VERIFY_PER_IP = { seconds: 900, max: 30 };
const VERIFY_PER_EMAIL = { seconds: 900, max: 10 };
/**
 * The compare's inputs when no row exists: an address with no code runs the
 * same HMAC and compare as a wrong code, short of the attempt write.
 */
const NO_ROW_ID = "00000000000000000000000000";
const NO_ROW_HASH = "0".repeat(64);
const NEWEST_FIRST: Sort<"verification">[] = [
  { field: "createdAt", dir: "desc" },
  { field: "id", dir: "desc" },
];

export interface EmailOtpRequest {
  email: string;
  ip: string | null;
  /** The captcha token (plan 12b). Undefined in process: no check. Null or "": the request had none. */
  captchaToken?: string | null | undefined;
}

export interface EmailOtpVerify {
  email: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
  /** The clear `td_` token of a trusted device (plan 12c): it skips the gate. */
  trustDevice?: string | undefined;
}

/** A sign-in or a reset by code: the session token, the user, and the session row. */
export interface EmailOtpSession {
  token: string;
  user: UserRow;
  session: SessionRow;
}

/** The stored value of a code: HMAC-SHA256 under the app secret of `<row id>:<code>`, in hex. */
export function codeHash(secret: string, rowId: string, code: string): Promise<string> {
  return hmacSha256Hex(secret, `${rowId}:${code}`);
}

/**
 * Always `ok` for a well-formed call, so a caller cannot learn whether an
 * address has an account. `rate_limited` is the one visible failure. The
 * earlier live codes of the address and purpose are spent first, so one
 * code is live. Two parallel requests can leave two live codes, within the
 * per-email limit; the verify reads the newest. The mail goes after the row
 * is written, never inside a transaction.
 */
async function requestCode(
  config: ResolvedConfig,
  purpose: EmailOtpPurpose,
  input: EmailOtpRequest,
): Promise<Result<{ sent: true }>> {
  const otp = config.emailOtp;
  if (!otp) return fail("not_found");
  // Before any limit key and before the row: both trust a normalized address.
  const email = normalizeEmail(input.email);
  if (email === null) return ok({ sent: true });
  if (!(await config.limiter.allow(`otp:ip:${input.ip ?? "unknown"}`, REQUEST_PER_IP)))
    return fail("rate_limited");
  if (!(await config.limiter.allow(`otp:email:${email}`, REQUEST_PER_EMAIL)))
    return fail("rate_limited");
  if (!(await config.limiter.allow(`otp:email-day:${email}`, MAILED_CODES_PER_EMAIL_DAY)))
    return fail("rate_limited");
  // After the limits and before the rows (plan 12b). The reset code is a reset request.
  const captcha = await checkCaptcha(
    config,
    purpose === "email-otp" ? "email-otp-request" : "password-reset-request",
    input.captchaToken,
    input.ip,
  );
  if (captcha) return captcha;
  const now = config.clock.now();
  await config.storage.update(
    "verification",
    [
      { field: "purpose", op: "eq", value: purpose },
      { field: "identifier", op: "eq", value: email },
      { field: "consumedAt", op: "eq", value: null },
    ],
    { consumedAt: now, updatedAt: now },
  );
  // After the spend, so every row that this request spent is in the read
  // (plan 9h). The new row comes strictly after the newest of them: the id is
  // random inside its millisecond, so with equal times the fallback read of
  // `newestCode` could find a spent older row first and answer invalid_code
  // after the cap (spec 8.10 item 4). A parallel request that this read does
  // not see left its row live, and the cap spends live rows.
  const [newest] = await config.storage.findMany(
    "verification",
    [
      { field: "purpose", op: "eq", value: purpose },
      { field: "identifier", op: "eq", value: email },
    ],
    { sort: NEWEST_FIRST, limit: 1 },
  );
  const createdAt = new Date(Math.max(now.getTime(), (newest?.createdAt.getTime() ?? 0) + 1));
  const id = newId(createdAt);
  const code = randomDigits(otp.length);
  await config.storage.create("verification", {
    id,
    purpose,
    identifier: email,
    valueHash: await codeHash(currentSecret(config.keyring), id, code),
    // From the request time: the bump above moves the order, not the life.
    expiresAt: new Date(now.getTime() + otp.ttlMinutes * 60_000),
    consumedAt: null,
    data: { attempts: 0 },
    createdAt,
    updatedAt: createdAt,
    secretVersion: config.keyring.current,
  });
  const build = purpose === "email-otp" ? otp.mail : otp.resetMail;
  const message = build({ email, code, ttlMinutes: otp.ttlMinutes, appName: config.appName });
  // To the address the code belongs to, whatever the builder wrote.
  await config.mail.send({ ...message, to: email });
  return ok({ sent: true });
}

/** A sign-in code (plan 9e). */
export function requestEmailOtp(
  config: ResolvedConfig,
  input: EmailOtpRequest,
): Promise<Result<{ sent: true }>> {
  return requestCode(config, "email-otp", input);
}

/** The verify limits, then the normalized address, or null for a malformed one. */
async function verifyGate(
  config: ResolvedConfig,
  input: { email: string; ip: string | null },
): Promise<Result<string | null>> {
  if (!(await config.limiter.allow(`otp-verify:ip:${input.ip ?? "unknown"}`, VERIFY_PER_IP)))
    return fail("rate_limited");
  const email = normalizeEmail(input.email);
  if (
    email !== null &&
    !(await config.limiter.allow(`otp-verify:email:${email}`, VERIFY_PER_EMAIL))
  )
    return fail("rate_limited");
  return ok(email);
}

/**
 * The live code of the address: the newest unconsumed row. With none, the
 * newest row of any state, so a code that its cap spent still answers
 * `too_many_attempts`. The request writes each row after every row that it
 * spent (plan 9h), so the newest row is the last request's row; rows of two
 * parallel requests can share a millisecond, and both are live until the cap
 * spends both.
 */
async function newestCode(
  storage: StorageAdapter,
  purpose: EmailOtpPurpose,
  email: string,
): Promise<VerificationRow | null> {
  const where: Where<"verification">[] = [
    { field: "purpose", op: "eq", value: purpose },
    { field: "identifier", op: "eq", value: email },
  ];
  const [live] = await storage.findMany(
    "verification",
    [...where, { field: "consumedAt", op: "eq", value: null }],
    { sort: NEWEST_FIRST, limit: 1 },
  );
  if (live) return live;
  const [last] = await storage.findMany("verification", where, { sort: NEWEST_FIRST, limit: 1 });
  return last ?? null;
}

/**
 * Compares `code` with the address's live code (plan 9e). A right code is
 * not spent here: the caller spends it with `consumeCode`. A wrong code
 * counts one guess; the guess that reaches `maxAttempts` also spends the
 * row. Every failure answers `invalid_code`, except a row that its cap spent,
 * which answers `too_many_attempts` until a new request. No row, an expired
 * row, and a spent row answer as a wrong code: the answer tells nothing
 * about the account.
 */
async function checkCode(
  config: ResolvedConfig,
  purpose: EmailOtpPurpose,
  email: string | null,
  code: string,
  now: Date,
): Promise<Result<VerificationRow>> {
  const otp = config.emailOtp;
  if (!otp) return fail("not_found");
  const row = email === null ? null : await newestCode(config.storage, purpose, email);
  // One HMAC and one compare on every path, against a fixed value when no row exists.
  // The row's version keys the HMAC (plan 12b). With no row, the current
  // version runs it against NO_ROW_HASH. One HMAC and one compare on every path.
  const key = row
    ? hashSecretFor(config.keyring, row.secretVersion, row.id)
    : { secret: currentSecret(config.keyring), known: true };
  const candidate = await codeHash(key.secret, row?.id ?? NO_ROW_ID, code);
  const right = constantTimeEqual(candidate, row?.valueHash ?? NO_ROW_HASH) && key.known;
  if (!row) return fail("invalid_code");
  if (row.consumedAt !== null)
    return fail(attemptsOf(row) >= otp.maxAttempts ? "too_many_attempts" : "invalid_code");
  if (row.expiresAt.getTime() <= now.getTime()) return fail("invalid_code");
  if (right) return ok(row);
  return fail(await countAttempt(config.storage, row, otp.maxAttempts, now));
}

/**
 * Spends a right code in one conditional update. Zero rows: a parallel
 * right code, the cap, or a newer request spent it first.
 */
async function consumeCode(
  storage: StorageAdapter,
  row: VerificationRow,
  now: Date,
): Promise<Result<VerificationRow>> {
  const n = await storage.update(
    "verification",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "consumedAt", op: "eq", value: null },
      { field: "expiresAt", op: "gt", value: now },
    ],
    { consumedAt: now, updatedAt: now },
  );
  return n === 1 ? ok(row) : fail("invalid_code");
}

/**
 * The sign-in by code (plan 9e). After the code check, the magic link's
 * resolution: find or create the user, the claim rule (spec 8.2 item 5),
 * and the session, in one transaction, with the session hook before the
 * first write (plan 9d). The code is spent before the resolution, as the
 * magic link's row is: a failure after that point burns the code by design,
 * and the person requests a new one.
 */
export async function verifyEmailOtp(
  config: ResolvedConfig,
  input: EmailOtpVerify,
): Promise<Result<EmailOtpSession | TwoFactorPending>> {
  if (!config.emailOtp) return fail("not_found");
  const gate = await verifyGate(config, input);
  if (!gate.ok) return gate;
  const now = config.clock.now();
  const checked = await checkCode(config, "email-otp", gate.value, input.code, now);
  if (!checked.ok) return checked;
  const consumed = await consumeCode(config.storage, checked.value, now);
  if (!consumed.ok) return consumed;
  const ended = endedList(config);
  // The hook runs before the resolution's first write, for the D1 undo (see
  // `insertSignUp` in password.ts). A user with the second factor on gets a
  // challenge in place of the session (plan 12c). The code proves the
  // mailbox, so the challenge offers no email method (owner decision 4).
  const steps = gatedSteps(
    config,
    {
      ip: input.ip,
      userAgent: input.userAgent,
      via: "email_otp",
      next: "/",
      trustDevice: input.trustDevice,
      gate: config.totp?.gate.emailOtp ?? false,
    },
    now,
  );
  const resolved = await hookGuard(async () =>
    ok(
      await findOrCreateUserByEmail(
        config.storage,
        consumed.value.identifier,
        now,
        (tx) => steps.write(tx),
        ended,
        signUpGuard(config, steps.before),
      ),
    ),
  );
  if (!resolved.ok) return resolved;
  const { user, after } = resolved.value;
  await sessionsEnded(config, ended, "claim");
  if (after.kind === "challenge") return ok(after.pending);
  await touchTrust(config, steps.trustId(), now);
  await sessionOpened(config, after.session, user, "email_otp");
  return ok({ token: after.token, user, session: after.session });
}

export interface EmailOtpReset {
  email: string;
  code: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
  /** The clear `td_` token of a trusted device (plan 12c): it skips the reset's challenge. */
  trustDevice?: string | undefined;
}

/**
 * A reset code (plan 9e), with the sign-in code's rules and budget. An
 * address with no user, or a user with no password row, still gets a code:
 * the reset creates them, as the reset link does (spec 8.7).
 */
export function requestResetOtp(
  config: ResolvedConfig,
  input: EmailOtpRequest,
): Promise<Result<{ sent: true }>> {
  if (!config.password) return Promise.resolve(fail("not_found"));
  return requestCode(config, "password-reset-otp", input);
}

/**
 * The reset by code (plan 9e). The sign-in code's check, then the reset
 * link's apply path (`resetWithProof`): the policy, the breach check, the
 * hash, and one transaction that spends the code first, sets or creates the
 * password, ends every session, applies the claim rule, runs the session
 * hook before its first write, and opens a session.
 * A user with the second factor on gets the challenge in place of the session (plan 12c).
 */
export async function resetPasswordWithOtp(
  config: ResolvedConfig,
  input: EmailOtpReset,
): Promise<Result<EmailOtpSession | TwoFactorPending>> {
  if (!config.emailOtp || !config.password) return fail("not_found");
  const gate = await verifyGate(config, input);
  if (!gate.ok) return gate;
  const now = config.clock.now();
  const checked = await checkCode(config, "password-reset-otp", gate.value, input.code, now);
  if (!checked.ok) return checked;
  const row = checked.value;
  const reset = await resetWithProof(config, input, row, (tx) => consumeCode(tx, row, now), now);
  if (!reset.ok) return reset;
  // A user with the second factor on gets the challenge, not a session (plan 12c).
  if ("twoFactor" in reset.value) return ok({ twoFactor: reset.value.twoFactor });
  return ok({ token: reset.value.token, user: reset.value.user, session: reset.value.session });
}
