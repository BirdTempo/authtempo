import type { ResolvedConfig } from "../config.js";
import { constantTimeEqual, hmacSha256Hex, randomDigits } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow, VerificationRow } from "../schema.js";
import type { Sort, StorageAdapter, Where } from "../storage/port.js";
import { hookGuard } from "./hooks.js";
import { resetWithProof } from "./password.js";
import { sessionOpened, sessionSteps, sessionsEnded } from "./sessions.js";
import { findOrCreateUserByEmail, normalizeEmail } from "./users.js";

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
}

export interface EmailOtpVerify {
  email: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
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

function attemptsOf(row: VerificationRow): number {
  const n = (row.data as { attempts?: unknown } | null)?.attempts;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
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
  const id = newId(now);
  const code = randomDigits(otp.length);
  await config.storage.create("verification", {
    id,
    purpose,
    identifier: email,
    valueHash: await codeHash(config.secret, id, code),
    expiresAt: new Date(now.getTime() + otp.ttlMinutes * 60_000),
    consumedAt: null,
    data: { attempts: 0 },
    createdAt: now,
    updatedAt: now,
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
 * `too_many_attempts`. Rows of one millisecond sort by id, which is random
 * inside the millisecond, so the live row is read first, not the newest row.
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
 * Counts one wrong code (plan 9e). A compare-and-set on `updatedAt`: the
 * update matches the row only as this call read it, and writes a strictly
 * later `updatedAt`. When a parallel guess wrote first, the update matches
 * zero rows, and the call reads the row again and counts on the new value.
 * So no guess goes uncounted, on D1 and on Postgres. A lost round means that
 * another guess counted or the row was spent, so the loop ends.
 */
async function countMiss(
  storage: StorageAdapter,
  row: VerificationRow,
  max: number,
  now: Date,
): Promise<"invalid_code" | "too_many_attempts"> {
  let current: VerificationRow | null = row;
  while (current && current.consumedAt === null) {
    const attempts = attemptsOf(current) + 1;
    const capped = attempts >= max;
    const n = await storage.update(
      "verification",
      [
        { field: "id", op: "eq", value: current.id },
        { field: "consumedAt", op: "eq", value: null },
        { field: "updatedAt", op: "eq", value: current.updatedAt },
      ],
      {
        data: { attempts },
        updatedAt: new Date(Math.max(now.getTime(), current.updatedAt.getTime() + 1)),
        ...(capped ? { consumedAt: now } : {}),
      },
    );
    if (n === 1) return capped ? "too_many_attempts" : "invalid_code";
    current = await storage.findOne("verification", [{ field: "id", op: "eq", value: current.id }]);
  }
  return current && attemptsOf(current) >= max ? "too_many_attempts" : "invalid_code";
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
  const candidate = await codeHash(config.secret, row?.id ?? NO_ROW_ID, code);
  const right = constantTimeEqual(candidate, row?.valueHash ?? NO_ROW_HASH);
  if (!row) return fail("invalid_code");
  if (row.consumedAt !== null)
    return fail(attemptsOf(row) >= otp.maxAttempts ? "too_many_attempts" : "invalid_code");
  if (row.expiresAt.getTime() <= now.getTime()) return fail("invalid_code");
  if (right) return ok(row);
  return fail(await countMiss(config.storage, row, otp.maxAttempts, now));
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
): Promise<Result<EmailOtpSession>> {
  if (!config.emailOtp) return fail("not_found");
  const gate = await verifyGate(config, input);
  if (!gate.ok) return gate;
  const now = config.clock.now();
  const checked = await checkCode(config, "email-otp", gate.value, input.code, now);
  if (!checked.ok) return checked;
  const consumed = await consumeCode(config.storage, checked.value, now);
  if (!consumed.ok) return consumed;
  const ended: SessionRow[] = [];
  // The hook runs before the resolution's first write, for the D1 undo (see `insertSignUp` in password.ts).
  const steps = sessionSteps(config, {
    ip: input.ip,
    userAgent: input.userAgent,
    via: "email_otp",
  });
  const resolved = await hookGuard(async () =>
    ok(
      await findOrCreateUserByEmail(
        config.storage,
        consumed.value.identifier,
        now,
        (tx) => steps.write(tx),
        ended,
        steps.before,
      ),
    ),
  );
  if (!resolved.ok) return resolved;
  const { user, after } = resolved.value;
  await sessionsEnded(config, ended, "claim");
  await sessionOpened(config, after.session, user, "email_otp");
  return ok({ token: after.token, user, session: after.session });
}

export interface EmailOtpReset {
  email: string;
  code: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
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
 */
export async function resetPasswordWithOtp(
  config: ResolvedConfig,
  input: EmailOtpReset,
): Promise<Result<EmailOtpSession>> {
  if (!config.emailOtp || !config.password) return fail("not_found");
  const gate = await verifyGate(config, input);
  if (!gate.ok) return gate;
  const now = config.clock.now();
  const checked = await checkCode(config, "password-reset-otp", gate.value, input.code, now);
  if (!checked.ok) return checked;
  const row = checked.value;
  const reset = await resetWithProof(config, input, row, (tx) => consumeCode(tx, row, now), now);
  if (!reset.ok) return reset;
  return ok({ token: reset.value.token, user: reset.value.user, session: reset.value.session });
}
