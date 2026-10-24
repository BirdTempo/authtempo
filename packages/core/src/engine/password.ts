import { checkCaptcha } from "../captcha.js";
import type { MailMessage, ResolvedConfig } from "../config.js";
import type { ErrorCode } from "../errors.js";
import { safeNext } from "../http/safe-next.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow, VerificationPurpose, VerificationRow } from "../schema.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import { hasAddress, provedAccount } from "./address.js";
import {
  type AnonymousCaller,
  anonymousData,
  recordedAnonymous,
  type UpgradeSteps,
  upgradeProof,
  upgradeSteps,
} from "./anonymous.js";
import { type CreateSteps, createSteps, type VerifySteps, verifySteps } from "./create-steps.js";
import { type CodeShape, compareCode, consumeCode, issueCode } from "./email-otp.js";
import { requireFresh } from "./fresh.js";
import { HookStop, hookGuard, stopWith } from "./hooks.js";
import { passwordMethod } from "./last-method.js";
import { sendNotice } from "./notices.js";
import { endFamilies, type FamilyEnds, familyEnds } from "./oauth-family.js";
import { deleteOAuthTokens } from "./oauth-grants.js";
import { deliverLogouts } from "./oauth-logout.js";
import { type ImpersonationStops, impersonationStops } from "./operator/audit.js";
import { activeBan } from "./operator/ban-rule.js";
import { PASSWORD_MAX_LENGTH, passwordPolicyError } from "./password-policy.js";
import { inRegion } from "./phone.js";
import { gateRead, touchTrust, writeChallenge } from "./second-factor.js";
import { deleteHandoffCodes, endOtherAccess } from "./session-list.js";
import {
  challengeOpened,
  endedList,
  endSessions,
  type PreparedSession,
  prepareSession,
  type ResolvedSession,
  sessionOpened,
  sessionsEnded,
  writeSession,
} from "./sessions.js";
import { enforcedAnswer, ssoRequiredFor } from "./sso/enforce.js";
import {
  deleteTwoFactorChallenges,
  secondFactorOn,
  type TwoFactorPending,
  twoFactorGate,
} from "./totp.js";
import { holdUser, userStays } from "./user-hold.js";
import { byUsername, normalizeUsername, type Username } from "./username.js";
import {
  ClaimLostError,
  claimEmail,
  claimedUser,
  draftUserRow,
  ensureEmailIdentity,
  mayCreateUser,
  normalizeEmail,
  userStillUnverified,
  validUserName,
} from "./users.js";
import { consumeVerification } from "./verification.js";

export const PASSWORD_VERIFY_PREFIX = "pv_";
export const PASSWORD_VERIFY_TOKEN_RE = /^pv_[A-Za-z0-9_-]{43}$/;
export const PASSWORD_RESET_PREFIX = "pr_";
export const PASSWORD_RESET_TOKEN_RE = /^pr_[A-Za-z0-9_-]{43}$/;
// 10 per hour per IP: a person makes one account; a script that makes many is slowed.
const SIGN_UP_PER_IP = { seconds: 3600, max: 10 };
// Per hour, per address, in both answers (plan 12b). A uniform sign-up of a
// known address mails its owner, so a bound per address stops many IP
// addresses from sending that mail without end. A new and a known address
// get the same 429, so the limit tells nothing.
const SIGN_UP_PER_EMAIL = { seconds: 3600, max: 5 };
// Per 15 minutes. The email limit stops a guess run on one account from many
// addresses; the IP limit stops one address that tries many accounts.
const SIGN_IN_PER_IP = { seconds: 900, max: 20 };
const SIGN_IN_PER_EMAIL = { seconds: 900, max: 10 };
// Plan 12i: the same count for a username and for a phone. Each kind has its
// own key, so the counts add up. One account takes up to 20 guesses per 15
// minutes by address and username. With a phone, it takes 30 (a residual of
// ruling 17). A key per user id would close the sum, but its 429 would tell
// that a phone and an address name one account.
const SIGN_IN_PER_USERNAME = { seconds: 900, max: 10 };
const SIGN_IN_PER_PHONE = { seconds: 900, max: 10 };
// Per 15 minutes, as the magic link request.
const RESET_PER_IP = { seconds: 900, max: 20 };
const RESET_PER_EMAIL = { seconds: 900, max: 5 };
// Per 15 minutes. Each reset POST can cost one breach call and one hash.
const RESET_POST_PER_IP = { seconds: 900, max: 20 };
// Per 15 minutes. A stolen session must not run an unlimited guess of the current password.
const CHANGE_PER_USER = { seconds: 900, max: 10 };
// The proofs of a reset: the mailed link and the mailed code (plan 9e). A
// reset of either kind and a password change spend the live ones of both.
// Typed, so a renamed purpose fails the typecheck.
const RESET_PURPOSES: readonly VerificationPurpose[] = ["password-reset", "password-reset-otp"];
// Per 15 minutes. Each resend sends one mail from the app's sender, so the
// product owns this limit (plan 8b).
const RESEND_PER_IP = { seconds: 900, max: 20 };
const RESEND_PER_EMAIL = { seconds: 900, max: 3 };
// The sign-up code (plan 12i Task 20): the draw and the counter of the
// email code (spec 8.10 items 3 and 5). 6 digits for 10 minutes, and 5
// wrong tries spend the code, as the email code's defaults.
const VERIFY_CODE: CodeShape = { length: 6, ttlMinutes: 10 };
const VERIFY_CODE_MAX_ATTEMPTS = 5;
// Per 15 minutes, as the email code verify. The per-address key bounds
// the guesses on one address to 10 in 15 minutes, whatever the count of
// codes that the resend sends.
const VERIFY_CODE_PER_IP = { seconds: 900, max: 30 };
const VERIFY_CODE_PER_EMAIL = { seconds: 900, max: 10 };
/**
 * The marker on the stored hash string of a sign-up's password row until
 * the sign-up proved the user still unverified. The row is unusable until
 * then: on D1 an owner's claim can verify the user before the password
 * create, so `claimEmail` finds no row to delete, and a claimant sign-in
 * must not prove the sign-up password on the owner's verified user (plan 9
 * Task 4 review I-1, 2026-10-10). The sign-in treats a marked row as no
 * row. No seam's stored string starts with it (PBKDF2 starts with
 * `pbkdf2-sha256$`).
 */
export const PENDING_HASH_PREFIX = "pending$";
/**
 * The stored hash string of a password row that an importer wrote for a
 * user whose old system exports no hash (Cognito; spec 17.4). No seam
 * parses it, so `verify` fails on it. The sign-in asks
 * `password.legacyVerify` instead, and on `true` writes a real hash over it.
 * It is a password row, so a claim deletes it (`claimEmail`) and a reset
 * overwrites it: a verified proof revokes the old system's password too.
 */
export const LEGACY_VERIFY_HASH = "legacy-verify$";

/**
 * The work of a route after its answer (ruling 23 of plan 12i): the route
 * passes `ctx.waitUntil`. In process there is none, and the work runs in
 * the call.
 */
export type AfterAnswer = (work: Promise<unknown>) => void;

/** Runs `work` after the answer when the caller passed `after`, else in this call. */
async function deliver(work: () => Promise<void>, after: AfterAnswer | undefined): Promise<void> {
  if (after) after(work());
  else await work();
}

export interface PasswordSession {
  token: string;
  user: UserRow;
  session: SessionRow;
}

/**
 * The sign-up answer while `password.requireVerified` is on, or `signUp` is
 * `"invited"` (plan 12b): the new user and no session. The verify link
 * signs the person in.
 */
export interface PasswordSignUpPending {
  user: UserRow;
  verifyRequired: true;
}

/**
 * `{ sent: true }` for every address while `password.uniformSignUp` is on
 * (the default, plan 12b). With it off: a session, or the user with no
 * session while `password.requireVerified` is on or `signUp` is `"invited"`.
 */
export type PasswordSignUpResult = PasswordSession | PasswordSignUpPending | { sent: true };

/** What the mail to a known address gets (plan 12b). */
export interface ExistingAccountMailInput {
  email: string;
  appName: string;
  appURL: string;
}

/** The default mail to an address that has an account. `password.existingAccountMail` replaces it. */
export function defaultExistingAccountMail(input: ExistingAccountMailInput): MailMessage {
  return {
    to: input.email,
    subject: `Your account at ${input.appName}`,
    text: `Someone asked to create an account for ${input.appName} with this address. You already have an account. Sign in at ${input.appURL}. If you forgot your password, ask for a reset on the sign-in page.\n\nIf it was not you, ignore this message. Nothing changed.`,
  };
}

export interface PasswordSignUp {
  email: string;
  password: string;
  name?: string | undefined;
  /** The username (plan 12i). Only with `username` on, else `invalid_body`. */
  username?: string | undefined;
  ip: string | null;
  userAgent: string | null;
  /** The captcha token (plan 12b). Undefined in process: no check. Null or "": the request had none. */
  captchaToken?: string | null | undefined;
  /**
   * The live anonymous session of the request (plan 12i Task 7). A sign-up
   * that opens its session replaces it there. A sign-up that mails a link
   * records it in the link's row, and the confirm replaces it.
   */
  anonymous?: AnonymousCaller | null | undefined;
}

/**
 * The one identifier of a password sign-in (plan 12i, spec 32 item 6):
 * exactly one of an address, a username, or a phone.
 */
export type PasswordIdentifier =
  | { email: string; username?: never; phone?: never }
  | { username: string; email?: never; phone?: never }
  | { phone: string; email?: never; username?: never };

export type PasswordSignIn = PasswordIdentifier & PasswordSignInFields;

/** The one identifier of a body that may hold any of the three, or null for two or none. */
export function passwordIdentifier(body: {
  email?: string | undefined;
  username?: string | undefined;
  phone?: string | undefined;
}): PasswordIdentifier | null {
  const { email, username, phone } = body;
  if ([email, username, phone].filter((v) => v !== undefined).length !== 1) return null;
  if (email !== undefined) return { email };
  if (username !== undefined) return { username };
  return phone === undefined ? null : { phone };
}

export interface PasswordSignInFields {
  password: string;
  ip: string | null;
  userAgent: string | null;
  /** The clear `td_` token of a trusted device (plan 9f). A live token of this user skips the second factor. */
  trustDevice?: string | undefined;
  /** Where the challenge page lands after the second factor (plan 9f). `safeNext` applies. */
  next?: string | undefined;
  /** The captcha token (plan 12b). Undefined in process: no check. Null or "": the request had none. */
  captchaToken?: string | null | undefined;
  /**
   * The live anonymous session of the request (plan 12i Task 7). The
   * sign-in completes in this request, so it is bound: it replaces this
   * anonymous user.
   */
  anonymous?: AnonymousCaller | null | undefined;
}

/** A session, or a second-factor challenge for a user with the factor on (plan 9f). */
export type PasswordSignInResult = PasswordSession | TwoFactorPending;
export type { TwoFactorPending };

/** The in-process re-authentication (plan 9f): the password of a known user. */
export interface PasswordReauth {
  userId: string;
  password: string;
  ip: string | null;
}

type Resolved = NonNullable<ResolvedConfig["password"]>;

/**
 * The policy, then the breach check. `email` must be normalized: the
 * policy compares the password with it. The check fails closed: an
 * `"unavailable"` answer refuses with `breach_check_unavailable` (plan 12b),
 * and a throw answers 500. The sign-up and both resets run it before any
 * read of a user, so the refusal is the same for a known and an unknown address.
 */
async function screen(
  pw: Resolved,
  password: string,
  email: string | null,
): Promise<"password_policy" | "password_breached" | "breach_check_unavailable" | null> {
  const policy = passwordPolicyError(password, email, pw.minLength);
  if (policy) return policy;
  if (!pw.breachCheck) return null;
  const answer = await pw.breachCheck(password);
  if (answer === "unavailable") return "breach_check_unavailable";
  return answer === true ? "password_breached" : null;
}

/** The fields of a new password user that the sign-up checked. */
interface SignUpRow {
  email: string;
  name: string | null;
  hash: string;
  username: Username | null;
}

/** The uniform sign-up holds no username (ruling 16 M1). */
type UniformRow = Omit<SignUpRow, "username">;

interface Created {
  answer: PasswordSession | PasswordSignUpPending;
  passwordId: string;
}

/**
 * Creates an unverified user with a password, then mails a link that
 * confirms the address. While `password.uniformSignUp` is on (the default),
 * it opens no session and answers `{ sent: true }` for every address (plan
 * 12b, see `uniformSignUp`). With it off, it opens a session; while
 * `password.requireVerified` is on, or `signUp` is `"invited"`, it opens none
 * and answers the user with `verifyRequired: true`.
 */
export async function passwordSignUp(
  config: ResolvedConfig,
  input: PasswordSignUp,
  after?: AfterAnswer,
): Promise<Result<PasswordSignUpResult>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  if (!(await limit(config, "password-sign-up:ip", ipKey(input.ip), SIGN_UP_PER_IP)))
    return fail("rate_limited");
  // After the per-IP limit and before every per-email limit: see checkCaptcha (plan 12b).
  const captcha = await checkCaptcha(config, "password-sign-up", input.captchaToken, input.ip);
  if (captcha) return captcha;
  // Before the policy and before any read: the policy and the lookups trust a normalized address.
  const email = normalizeEmail(input.email);
  if (email === null) return fail("invalid_body");
  // Only SSO signs in an address of an enforced domain (plan 12d, spec 30 item 12).
  const enforced = await enforcedAnswer(config, email);
  if (enforced) return enforced;
  // Before any read of a user: the answer is the same for every address (plan 12b).
  if (config.signUp === false) return fail("sign_up_closed");
  const name = input.name;
  if (name !== undefined && !validUserName(name)) return fail("invalid_body");
  // The form of the username, with the other body checks (plan 12i Task 2).
  // The read by username runs in the transaction, before any read by address.
  let username: Username | null = null;
  if (input.username !== undefined) {
    if (!config.username) return fail("invalid_body");
    // With the uniform answer, a name at sign-up tells a known address from
    // a new one: only a new address holds it. So the person sets the name
    // after the confirm (ruling 16 M1, plan 12b).
    if (pw.uniformSignUp) return fail("invalid_body");
    username = normalizeUsername(config, input.username);
    if (username === null) return fail("username_invalid");
  }
  const refused = await screen(pw, input.password, email);
  if (refused) return fail(refused);
  // After the body checks, which answer the same for every address and send
  // no mail, and before the hash: only a sign-up that can mail counts.
  if (!(await limit(config, "password-sign-up:email", email, SIGN_UP_PER_EMAIL)))
    return fail("rate_limited");
  // Before the transaction: a hash inside it would hold a Postgres connection for its CPU time.
  const hash = await pw.hash.hash(input.password);
  const now = config.clock.now();
  // The user hooks of the new user (plan 12a). The transaction runs the sign-up rule itself.
  const made = createSteps(config, "password", { signUpRule: false });
  if (pw.uniformSignUp)
    return uniformSignUp(
      config,
      pw,
      { email, name: name ?? null, hash },
      now,
      made,
      input.anonymous ?? null,
      after,
    );
  // A sign-up that opens its session completes in this request: bound (plan 12i Task 7).
  const upgrade = upgradeSteps(config, input.anonymous ?? null, null, "bound");
  let created: Result<Created> | null = null;
  for (let attempt = 0; created === null; attempt++) {
    try {
      created = await hookGuard(() =>
        insertSignUp(
          config,
          input,
          { email, name: name ?? null, hash, username },
          now,
          made,
          upgrade,
        ),
      );
    } catch (err) {
      // A concurrent sign-up or sign-in created the user between our read
      // and our create, or (on D1) an owner's reset wrote this user's
      // password row between our two creates and verified the user. Caught
      // here, outside: inside, Postgres has already aborted the transaction.
      // Run once more, so the read finds the winner's row and the answer
      // follows the rules for an existing user: `email_taken_unverified`
      // tells an unverified social winner's owner to use the magic link,
      // and the owner's verified user answers `email_taken`. A race on the
      // username answers `username_taken` at the read of the second run.
      if (
        attempt === 0 &&
        err instanceof StorageError &&
        err.code === "unique_violation" &&
        (err.model === "user" || err.model === "password")
      )
        continue;
      throw err;
    }
  }
  if (!created.ok) return created;
  const answer = created.value.answer;
  // Right after the commit, before the session hook and the mail (plan 12a).
  await made.after(answer.user);
  // Right after the commit, before the mail: the session exists whatever the mail does.
  if ("session" in answer) {
    await sessionOpened(config, answer.session, answer.user, "password");
    await upgrade.after();
  }
  // A link with no session yet records the anonymous user for its confirm.
  const recorded = "session" in answer ? null : (input.anonymous ?? null);
  await sendVerifyMail(config, email, created.value.passwordId, now, recorded);
  return ok(answer);
}

/**
 * One transaction. The new-user guard is the plan 6b one: on D1 a claim
 * (the owner's magic link) can find this user before the commit, so a
 * conditional update of the user row where `emailVerified` is false runs
 * after the session insert. The last statement activates the password row,
 * which the sign-up wrote pending (`PENDING_HASH_PREFIX`). While
 * `password.requireVerified` is on, or `signUp` is `"invited"`, no session
 * hook runs and no session row is written (plan 12b); the guard and the
 * activation stay.
 */
function insertSignUp(
  config: ResolvedConfig,
  input: PasswordSignUp,
  row: SignUpRow,
  now: Date,
  made: CreateSteps,
  upgrade: UpgradeSteps,
): Promise<Result<Created>> {
  return config.storage.transaction(async (tx): Promise<Result<Created>> => {
    // A retry forgets the user of the attempt that rolled back.
    made.begin();
    // The username before any read by address (spec 32 item 7), so the
    // answer to a taken name is the same for a known and a new address.
    if (await usernameTaken(tx, row.username)) return fail("username_taken");
    // "invited": before the existence read, so a known address with no
    // invitation gets the same answer as a new one (plan 12b).
    if (config.signUp !== "open") await mayCreateUser(config, tx, row.email);
    const existing = await tx.findOne("user", [{ field: "email", op: "eq", value: row.email }]);
    if (existing) {
      if (existing.emailVerified) return fail("email_taken");
      const has = await tx.findOne("password", [{ field: "userId", op: "eq", value: existing.id }]);
      return fail(has ? "email_taken" : "email_taken_unverified");
    }
    // The user row first, the password row second. The password row's
    // `userId` can carry a foreign key to the user row (Better Auth's
    // `account.userId` does, plan 9), and the database checks it at once.
    // On D1 an owner's reset can run inside this open transaction, between
    // the two creates: it finds this unverified user, writes the owner's
    // password row for it, and verifies it in its claim. The password create
    // then fails with unique_violation on `userId`. The undo of the user
    // create deletes the row only while `emailVerified` is false
    // (`undoCreateWhere`), so the owner's verified user stays, and the retry
    // reads it and answers `email_taken`. Postgres isolates the transaction,
    // so the order is no guard there. Checked 2026-10-10.
    // `user.beforeCreate` before the session hook and the first write (plan 12a).
    const minted: UserRow = await made.user(
      tx,
      draftUserRow(
        { email: row.email, emailVerified: false, name: row.name, ...(row.username ?? {}) },
        now,
      ),
    );
    // The session hook before the first write, with the minted user (plan
    // 9d, fix round 1). On D1 a refusal after a create makes the undo
    // delete the created row by id (`undoCreateWhere`), and only the user
    // row has a guard. After an owner's reset inside this transaction, the
    // pending password row holds the owner's hash, so an undo of it would
    // delete the owner's password. A refusal here undoes nothing.
    // Under "invited" the address must be proved too (owner ruling,
    // 2026-10-15): else a stranger who knows an invited address gets a
    // session. The verify link opens it, as under `requireVerified`.
    const opens = !config.password?.requireVerified && config.signUp !== "invited";
    // The anonymous upgrade (plan 12i Task 7): its hook before the session hook, before the first create.
    if (opens) await upgrade.before(tx, minted, upgradeProof(minted), "password");
    const prepared = opens
      ? await prepareSession(
          config,
          { user: minted, ip: input.ip, userAgent: input.userAgent, via: "password" },
          tx,
        )
      : null;
    const user = await tx.create("user", minted);
    // Pending until the guard below passed: see `PENDING_HASH_PREFIX`.
    const pending = `${PENDING_HASH_PREFIX}${row.hash}`;
    const password = await tx.create("password", {
      id: newId(now),
      userId: user.id,
      hash: pending,
      createdAt: now,
      updatedAt: now,
    });
    const s = prepared ? await writeSession(config, prepared, tx) : null;
    const dropSession = async () => {
      if (s) await tx.delete("session", [{ field: "id", op: "eq", value: s.session.id }]);
    };
    // claimEmail flips the flag in its first statement, so any claim since
    // the user create makes this match zero rows. The user row is the
    // owner's now. A throw would undo the password create, and the D1 undo
    // deletes that row by id: after an owner's reset it holds the owner's
    // hash. So delete the own session and the own password row by id and
    // hash, and commit. Checked 2026-10-10.
    // The password delete matches the pending string this sign-up wrote. An
    // owner's reset keeps this row id and writes the owner's hash into it,
    // and that row must stay.
    if (!(await userStillUnverified(tx, user.id, now))) {
      await dropSession();
      await tx.delete("password", [
        { field: "id", op: "eq", value: password.id },
        { field: "hash", op: "eq", value: pending },
      ]);
      return fail("email_taken_unverified");
    }
    // The last statement: activate the row, conditional on the id and the
    // pending string. Zero rows means a claim deleted the row or a reset
    // wrote the owner's hash into it since the guard. Then delete the own
    // session by id, commit, and answer as for a claim. One row means no
    // undo runs after it, and a later claim deletes the row and the session.
    const active = await tx.update(
      "password",
      [
        { field: "id", op: "eq", value: password.id },
        { field: "hash", op: "eq", value: pending },
      ],
      { hash: row.hash, updatedAt: now },
    );
    if (active === 0) {
      await dropSession();
      return fail("email_taken_unverified");
    }
    // The claim of the anonymous upgrade, after the guards: no path commits it without the session.
    if (s) await upgrade.claim(tx);
    const answer: PasswordSignUpResult = s
      ? { token: s.token, user, session: s.session }
      : { user, verifyRequired: true };
    return ok({ answer, passwordId: password.id });
  });
}

type UniformOutcome =
  | { outcome: "created"; passwordId: string; user: UserRow }
  | { outcome: "existing" | "quiet" };

/**
 * The uniform sign-up (plan 12b): `{ sent: true }` on every path, no
 * session. A new address gets the verify mail, a known one the
 * existing-account mail, and a refused or raced one no mail. The retry on
 * a unique violation runs outside the transaction (plan 3 rule).
 */
async function uniformSignUp(
  config: ResolvedConfig,
  pw: Resolved,
  row: UniformRow,
  now: Date,
  made: CreateSteps,
  anonymous: AnonymousCaller | null,
  after: AfterAnswer | undefined,
): Promise<Result<{ sent: true }>> {
  let done: UniformOutcome | null = null;
  for (let attempt = 0; done === null; attempt++) {
    try {
      const r = await hookGuard(() => insertUniform(config, row, now, made));
      if (r.ok) done = r.value;
      // The "invited" rule refused, or `user.beforeCreate` refused or threw
      // (plan 12a, lead ruling 2026-10-15): the same answer as every other
      // path, and no mail. Else the answer tells that the address has no
      // user. runBefore logged a throw with the hook name and the error name.
      else if (r.code === "sign_up_closed" || r.code === "hook_refused" || r.code === "hook_failed")
        done = { outcome: "quiet" };
      else return r;
    } catch (err) {
      // A parallel sign-up created the user between the read and the create.
      // Run once more outside the failed transaction: the read finds the row.
      if (
        attempt === 0 &&
        err instanceof StorageError &&
        err.code === "unique_violation" &&
        (err.model === "user" || err.model === "password")
      )
        continue;
      throw err;
    }
  }
  // A code row and its mail for a new address, one mail for a known one.
  // With the code, both go after the answer (ruling 23 of plan 12i), so the
  // time of the answer does not tell the two apart. The link keeps its
  // order of plan 12b: the mail goes before the answer.
  const later = pw.verifyBy === "code" ? after : undefined;
  if (done.outcome === "created") {
    // Right after the commit, before the mail (plan 12a).
    await made.after(done.user);
    const { passwordId } = done;
    await deliver(() => sendVerifyMail(config, row.email, passwordId, now, anonymous), later);
  }
  if (done.outcome === "existing")
    await deliver(() => sendExistingAccountMail(config, pw, row.email), later);
  return ok({ sent: true });
}

/**
 * One transaction with no session: the user and the pending password row,
 * the claim guard, and the activation, as `insertSignUp` writes them. A
 * known address writes nothing.
 */
function insertUniform(
  config: ResolvedConfig,
  row: UniformRow,
  now: Date,
  made: CreateSteps,
): Promise<Result<UniformOutcome>> {
  return config.storage.transaction(async (tx): Promise<Result<UniformOutcome>> => {
    // A retry forgets the user of the attempt that rolled back.
    made.begin();
    // "invited": before the existence read, as in `insertSignUp` (plan 12b
    // Task 8). A known and a new address with no invitation then do the
    // same reads and get no mail, so the time of the answer tells nothing.
    // It holds no username: `passwordSignUp` refuses one here.
    if (config.signUp !== "open") await mayCreateUser(config, tx, row.email);
    const existing = await tx.findOne("user", [{ field: "email", op: "eq", value: row.email }]);
    if (existing) return ok({ outcome: "existing" });
    // The order and the guards of `insertSignUp`, with no session.
    // `user.beforeCreate` before the first write (plan 12a). A known address
    // returned above, so only a new address meets the hook.
    const minted = await made.user(
      tx,
      draftUserRow({ email: row.email, emailVerified: false, name: row.name }, now),
    );
    const user = await tx.create("user", minted);
    const pending = `${PENDING_HASH_PREFIX}${row.hash}`;
    const password = await tx.create("password", {
      id: newId(now),
      userId: user.id,
      hash: pending,
      createdAt: now,
      updatedAt: now,
    });
    const own = [
      { field: "id" as const, op: "eq" as const, value: password.id },
      { field: "hash" as const, op: "eq" as const, value: pending },
    ];
    if (!(await userStillUnverified(tx, user.id, now))) {
      await tx.delete("password", own);
      return ok({ outcome: "quiet" });
    }
    const active = await tx.update("password", own, { hash: row.hash, updatedAt: now });
    return ok(
      active === 0 ? { outcome: "quiet" } : { outcome: "created", passwordId: password.id, user },
    );
  });
}

/** True when a user holds the stored name. No name: false, and no read. */
async function usernameTaken(tx: StorageAdapter, name: Username | null): Promise<boolean> {
  if (name === null) return false;
  return (await tx.findOne("user", byUsername(name.username))) !== null;
}

/** The mail to a known address, after the commit. To the address, whatever the builder wrote. */
async function sendExistingAccountMail(
  config: ResolvedConfig,
  pw: Resolved,
  email: string,
): Promise<void> {
  const message = pw.existingAccountMail({ email, appName: config.appName, appURL: config.appURL });
  await config.mail.send({ ...message, to: email });
}

/**
 * One `password-verify` row and one mail. The link opens a confirm page with
 * no side effect. The row records the anonymous user of the request that
 * asked for the link (plan 12i Task 7): the confirm is a mailed proof. With
 * `password.verifyBy: "code"`, a code in place of the link (plan 12i Task 20).
 */
async function sendVerifyMail(
  config: ResolvedConfig,
  email: string,
  passwordId: string,
  now: Date,
  anonymous: AnonymousCaller | null,
): Promise<void> {
  if (config.password?.verifyBy === "code")
    return sendVerifyCode(config, email, passwordId, anonymous);
  const token = randomToken(PASSWORD_VERIFY_PREFIX);
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "password-verify",
    identifier: email,
    valueHash: await sha256Hex(token),
    expiresAt: new Date(now.getTime() + config.magicLink.ttlMinutes * 60_000),
    consumedAt: null,
    data: { passwordId, ...anonymousData(anonymous) },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  const link = `${config.baseURL}${config.basePath}/password/verify?token=${encodeURIComponent(token)}`;
  await config.mail.send({
    to: email,
    subject: `Confirm your email for ${config.appName}`,
    text: `Open this link to confirm your email address. It is valid for ${config.magicLink.ttlMinutes} minutes.\n\n${link}\n\nIf you did not create an account, ignore this message.`,
  });
}

/**
 * One `password-verify-otp` row and one mail (plan 12i Task 20). The draw
 * and the keyed hash are the email code's (`issueCode`). It spends the
 * earlier live codes of the address, so one code is live. The row records
 * the password row and the anonymous user of the request, as the link's
 * row does. The mail goes after the row, never inside a transaction.
 */
async function sendVerifyCode(
  config: ResolvedConfig,
  email: string,
  passwordId: string,
  anonymous: AnonymousCaller | null,
): Promise<void> {
  const pw = config.password;
  if (!pw) return;
  const code = await issueCode(config, VERIFY_CODE, "password-verify-otp", email, {
    passwordId,
    ...anonymousData(anonymous),
  });
  const message = pw.verifyCodeMail({
    email,
    code,
    appName: config.appName,
    ttlMinutes: VERIFY_CODE.ttlMinutes,
  });
  // To the address the code belongs to, whatever the builder wrote.
  await config.mail.send({ ...message, to: email });
}

export interface PasswordResend {
  email: string;
  ip: string | null;
  /** The live anonymous session of the request (plan 12i Task 7): the new link records its user. */
  anonymous?: AnonymousCaller | null | undefined;
}

/**
 * A new verify link (plan 8b). A mail failure after the sign-up commit
 * leaves an account with no link; this sends one. Always `sent` for a
 * well-formed call, as the reset request, so the answer does not tell
 * whether an address has an account; `rate_limited` is the one visible
 * failure. A mail goes only to a user that exists, is unverified, and has
 * an active password row (not `PENDING_HASH_PREFIX`). The other pending
 * links of the address go first, so one link at a time is live. A call
 * that mails takes longer than one that does not; the time can tell that
 * an address has an unverified password account. The mail goes after the
 * row is written, never inside a transaction. The old links go before the
 * send, so a mail throw leaves no live link and answers 500; the next
 * resend repairs it. Two parallel resends can leave two live links, within
 * the per-email limit of 3.
 */
export async function resendPasswordVerification(
  config: ResolvedConfig,
  input: PasswordResend,
  after?: AfterAnswer,
): Promise<Result<{ sent: true }>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  // Before any limit key: both keys trust a normalized address.
  const email = normalizeEmail(input.email);
  if (email === null) return ok({ sent: true });
  if (!(await limit(config, "password-resend:ip", ipKey(input.ip), RESEND_PER_IP)))
    return fail("rate_limited");
  // The email limit counts before the reads, so an unknown address spends
  // the same budget as a known one.
  if (!(await allowResendMail(config, email))) return fail("rate_limited");
  const send = async (): Promise<void> => {
    const user = await config.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
    if (!user || user.emailVerified) return;
    const row = await config.storage.findOne("password", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    if (!row || row.hash.startsWith(PENDING_HASH_PREFIX)) return;
    await replaceVerifyMail(config, email, row.id, input.anonymous ?? null);
  };
  // With the code, the reads and the send go after the answer (ruling 23 of
  // plan 12i). Then the time of the answer tells no account.
  await deliver(send, pw.verifyBy === "code" ? after : undefined);
  return ok({ sent: true });
}

/** The per-email limit of a new verify link: the resend route's key (plan 8b). */
function allowResendMail(config: ResolvedConfig, email: string): Promise<boolean> {
  return limit(config, "password-resend:email", email, RESEND_PER_EMAIL);
}

/**
 * Deletes the pending `password-verify` rows of the address, then mails one
 * new link. A code spends the live codes of the address itself (`issueCode`).
 */
async function replaceVerifyMail(
  config: ResolvedConfig,
  email: string,
  passwordId: string,
  anonymous: AnonymousCaller | null,
): Promise<void> {
  if (config.password?.verifyBy !== "code")
    await config.storage.delete("verification", [
      { field: "purpose", op: "eq", value: "password-verify" },
      { field: "identifier", op: "eq", value: email },
      { field: "consumedAt", op: "eq", value: null },
    ]);
  await sendVerifyMail(config, email, passwordId, config.clock.now(), anonymous);
}

/**
 * A new verify link for a known unverified user with an active password
 * row (plan 12b): the per-email limit of the resend route, then the other
 * pending links go, then one mail. No IP key: the caller counted its own.
 * False when the limit is full and no mail went. A mail throw reaches the
 * caller, as at the resend.
 */
export async function mailVerifyAgain(
  config: ResolvedConfig,
  email: string,
  passwordId: string,
  anonymous: AnonymousCaller | null = null,
): Promise<boolean> {
  if (!(await allowResendMail(config, email))) return false;
  await replaceVerifyMail(config, email, passwordId, anonymous);
  return true;
}

/**
 * Every failure after the limits answers `invalid_credentials` after one
 * `verify`: an unknown address, a malformed address, a user with no
 * password row, and a row a sign-up still holds pending
 * (`PENDING_HASH_PREFIX`) verify against the seam's `dummy()`. So the
 * answer and its CPU are the same as for a wrong password.
 */
export async function passwordSignIn(
  config: ResolvedConfig,
  input: PasswordSignIn,
): Promise<Result<PasswordSignInResult>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  if (!(await limit(config, "password:ip", ipKey(input.ip), SIGN_IN_PER_IP)))
    return fail("rate_limited");
  // After the per-IP limit and before every per-email limit: see checkCaptcha (plan 12b).
  const captcha = await checkCaptcha(config, "password-sign-in", input.captchaToken, input.ip);
  if (captcha) return captcha;
  // Before any lookup: the lookup and its limit key trust the normalized form.
  const by = await signInLookup(config, input);
  if (!by.ok) return by;
  const { where, byEmail } = by.value;
  // The length is the caller's own input, so this refusal tells nothing about an account. It bounds the CPU.
  if ([...input.password].length > PASSWORD_MAX_LENGTH) return fail("invalid_credentials");
  // The floor of every failure from here on (spec 17.4). Date.now, not the
  // injected clock: the floor is real time that a caller measures.
  const started = Date.now();
  const refuse = async (): Promise<Result<PasswordSession>> => {
    await legacyFloor(pw, started);
    return fail("invalid_credentials");
  };
  const user = where === null ? null : await config.storage.findOne("user", where);
  const row = user
    ? await config.storage.findOne("password", [{ field: "userId", op: "eq", value: user.id }])
    : null;
  // A pending row counts as no row. The re-check below matches the proved
  // hash, so it never matches a pending row either.
  if (!user || !row || row.hash.startsWith(PENDING_HASH_PREFIX)) {
    await pw.hash.verify(input.password, await pw.hash.dummy());
    return refuse();
  }
  // The old system knows a user by the address. A legacy row of a user with
  // no address has no check: the dummy, then the failure (no importer
  // writes such a row).
  let checked: { ok: boolean; rehash: boolean };
  if (row.hash !== LEGACY_VERIFY_HASH) checked = await pw.hash.verify(input.password, row.hash);
  else if (hasAddress(user)) checked = await legacyCheck(pw, user.email, input.password, started);
  else {
    await pw.hash.verify(input.password, await pw.hash.dummy());
    return refuse();
  }
  if (!checked.ok) return refuse();
  // A sign-in by address had the SSO check at the door, before any read.
  // A username or a phone names its address only through the user row, so
  // the check comes after the password: only a person who knows it learns
  // that the account is in an enforced domain.
  if (!byEmail) {
    const enforced = await enforcedAnswer(config, user.email);
    if (enforced) return enforced;
  }
  const now = config.clock.now();
  // The hash this sign-in proved. The session is valid only while the row still holds it.
  let proved = row.hash;
  if (checked.rehash) {
    // Before the transaction: a hash inside it would hold a Postgres connection for its CPU time.
    const fresh = await pw.hash.hash(input.password);
    // Conditional on the id and the old hash. A reset or a change that wrote
    // a new hash since the read keeps its hash. A claim that deleted the row
    // since the read makes this match zero rows, and an update writes no row
    // then.
    const n = await config.storage.update(
      "password",
      [
        { field: "id", op: "eq", value: row.id },
        { field: "hash", op: "eq", value: row.hash },
      ],
      { hash: fresh, updatedAt: now },
    );
    if (n === 1) {
      proved = fresh;
    } else {
      // Zero rows: the row changed or is gone. Another right sign-in may have
      // rehashed it first (plan 8b): read it again, and verify this password
      // against its new hash. One more derive, on this path only, still
      // before the transaction. A row a reset or a change wrote holds another
      // password and fails the verify; a claim leaves no row.
      const current = await config.storage.findOne("password", [
        { field: "id", op: "eq", value: row.id },
      ]);
      if (
        !current ||
        current.userId !== user.id ||
        current.hash.startsWith(PENDING_HASH_PREFIX) ||
        !(await pw.hash.verify(input.password, current.hash)).ok
      )
        return refuse();
      proved = current.hash;
    }
  }
  // Plan 12b Task 15 (Better Auth docs audit gap 1). After the password
  // check, so only a person who knows the password learns that the address
  // is unverified. A new link goes out, at most 3 per 15 minutes. Before the
  // second-factor gate: no challenge opens either. Under signUp "invited"
  // too (plan 12b, Task 9 review M1): a stranger who knows an invited
  // address could sign up with their own password and sign in before the
  // address is proved. The ruling of 2026-10-15 closed it for social and
  // for the sign-up session; this closes it for the sign-in.
  // A user with no address is proved by the proof that made it (`provedAccount`), and gets no mail.
  if ((pw.requireVerified || config.signUp === "invited") && !provedAccount(user)) {
    if (hasAddress(user))
      await mailVerifyAgain(config, user.email, row.id, input.anonymous ?? null);
    return fail("email_unverified");
  }
  // The sign-in completes in this request: bound (plan 12i Task 7).
  const upgrade = upgradeSteps(config, input.anonymous ?? null, null, "bound");
  // The second factor (plan 9f, owner decision 1b): a user with the factor on
  // gets a challenge in place of the session. The gate keeps the guard below
  // for its challenge, so a reset, a change, or a claim since the check
  // refuses it.
  const gate = await twoFactorGate(
    config,
    {
      user,
      passwordId: row.id,
      proved,
      ip: input.ip,
      userAgent: input.userAgent,
      next: input.next,
      trustDevice: input.trustDevice,
      method: passwordMethod(input),
      anonymous: upgrade.carried(),
    },
    now,
  );
  if ("challenge" in gate) {
    if (!gate.challenge.ok) await legacyFloor(pw, started);
    else challengeOpened(config, user, "password");
    return gate.challenge;
  }
  const signedIn = await hookGuard(() =>
    config.storage.transaction(async (tx): Promise<Result<PasswordSession>> => {
      // The anonymous upgrade (plan 12i Task 7): its hook before the session hook and its hold.
      await upgrade.before(tx, user, upgradeProof(user), "password");
      const prepared = await prepareSession(
        config,
        { user, ip: input.ip, userAgent: input.userAgent, via: "password" },
        tx,
      );
      const s = await writeSession(config, prepared, tx);
      // For every user, verified or not. Between the verify and this point a
      // reset or a change can write a new hash and delete the sessions, and a
      // claim (the owner's magic link) can delete the row and the sessions.
      // Each of them writes or deletes the password row before it deletes the
      // sessions (claimEmail does; the reset and the change must keep that
      // order). So this conditional update by id and the proved hash is the
      // last statement: one row means that session delete has not run and
      // still removes this session; zero rows means the row changed or is
      // gone, so delete the own session by id, commit, and answer the failure
      // (a throw would reach the caller as a 500). A conditional update, not a
      // read, so that it sees the other flow's statements on D1.
      const n = await tx.update(
        "password",
        [
          { field: "id", op: "eq", value: row.id },
          { field: "hash", op: "eq", value: proved },
        ],
        { updatedAt: now },
      );
      if (n === 0) {
        await tx.delete("session", [{ field: "id", op: "eq", value: s.session.id }]);
        return fail("invalid_credentials");
      }
      // The claim after the row check, so no path commits a claim without its session.
      await upgrade.claim(tx);
      return ok({ token: s.token, user, session: s.session });
    }),
  );
  // After the commit, never inside: the floor must not hold a Postgres connection.
  if (!signedIn.ok) await legacyFloor(pw, started);
  else {
    // The trust row that skipped the gate, after the commit, as the other gates do.
    await touchTrust(config, gate.trustId, now);
    await sessionOpened(config, signedIn.value.session, signedIn.value.user, "password");
    await upgrade.after();
  }
  return signedIn;
}

/**
 * The read of a password sign-in by its one identifier (plan 12i, spec 32
 * item 6), after its limit. `where` is null for an input that no user can
 * hold: a malformed address, a username that breaks the form or is
 * reserved, or a phone that is not E.164 or is outside `phone.regions`.
 * The caller then runs the dummy verify, so a bad form answers as an
 * unknown account does. Only a well-formed identifier counts on its own
 * limit, as the address did before this plan. A username with the
 * username config off is not an input: `invalid_body`, as at the sign-up.
 * A phone with the phone config off is the same (ruling 20 of plan 12i).
 */
async function signInLookup(
  config: ResolvedConfig,
  input: PasswordIdentifier,
): Promise<Result<{ where: Where<"user">[] | null; byEmail: boolean }>> {
  // The type holds one; a plain JavaScript caller can pass two or none.
  if (passwordIdentifier(input) === null) return fail("invalid_body");
  if (input.username !== undefined) {
    if (!config.username) return fail("invalid_body");
    const name = normalizeUsername(config, input.username);
    if (name === null) return ok({ where: null, byEmail: false });
    if (!(await limit(config, "password:username", name.username, SIGN_IN_PER_USERNAME)))
      return fail("rate_limited");
    return ok({ where: byUsername(name.username), byEmail: false });
  }
  if (input.phone !== undefined) {
    // A stored phone signs in only as `phoneSignsIn` says (ruling 15): with
    // `phone` on and the number in a region. A compat store can hold a phone
    // with `phone` off, so the gate comes before the read.
    if (!config.phone) return fail("invalid_body");
    if (!inRegion(config, input.phone)) return ok({ where: null, byEmail: false });
    if (!(await limit(config, "password:phone", input.phone, SIGN_IN_PER_PHONE)))
      return fail("rate_limited");
    return ok({ where: [{ field: "phone", op: "eq", value: input.phone }], byEmail: false });
  }
  const email = normalizeEmail(input.email);
  if (email === null) return ok({ where: null, byEmail: true });
  if (!(await limit(config, "password:email", email, SIGN_IN_PER_EMAIL)))
    return fail("rate_limited");
  // Only SSO signs in an address of an enforced domain (plan 12d, spec 30 item 12).
  const enforced = await enforcedAnswer(config, email);
  if (enforced) return enforced;
  return ok({ where: [{ field: "email", op: "eq", value: email }], byEmail: true });
}

/**
 * The old system's answer for a row that holds `LEGACY_VERIFY_HASH`. The
 * dummy verify first, so the CPU is the same as for a wrong password. A
 * match is `rehash: true`: the sign-in writes this config's hash over the
 * marker by the conditional update on the marker, then signs in as for any
 * other row. Only a boolean `true` is a match. A throw, any other answer, or
 * no answer by the floor's deadline is a failure; the timeout aborts the call.
 * The deadline is `started + timeoutMs`, the same as the floor's, not
 * `timeoutMs` from the call: the lookups and the dummy verify run first, and
 * a timer from the call would answer late by their time. That delay would
 * tell a legacy row from an unknown address.
 */
async function legacyCheck(
  pw: Resolved,
  email: string,
  password: string,
  started: number,
): Promise<{ ok: boolean; rehash: boolean }> {
  await pw.hash.verify(password, await pw.hash.dummy());
  const lv = pw.legacyVerify;
  if (!lv) return { ok: false, rehash: false };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort();
        resolve(false);
      },
      Math.max(0, lv.timeoutMs - (Date.now() - started)),
    );
  });
  try {
    const answer = await Promise.race([lv.verify(email, password, controller.signal), timeout]);
    return answer === true ? { ok: true, rehash: true } : { ok: false, rehash: false };
  } catch {
    return { ok: false, rehash: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * While `legacyVerify` is set, a failed sign-in waits until `timeoutMs`
 * after its check began. A legacy row's failure costs the old system's
 * round trip, and an unknown address costs none; the floor hides the
 * difference. Without `legacyVerify` there is no floor.
 */
async function legacyFloor(pw: Resolved, started: number): Promise<void> {
  const lv = pw.legacyVerify;
  if (!lv) return;
  const left = lv.timeoutMs - (Date.now() - started);
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
}

export interface PasswordVerify {
  token: string;
  ip: string | null;
  userAgent: string | null;
  /** The live anonymous session of the confirm: a mailed proof (plan 12i Task 7). */
  anonymous?: AnonymousCaller | null | undefined;
}

export interface PasswordVerified {
  user: UserRow;
  signedIn: { token: string; session: SessionRow } | null;
}

/**
 * The sign-up link. It is spent, then the confirm runs (`confirmSignUp`).
 * Every refusal after the spend answers `invalid_token`.
 */
export async function verifyPasswordEmail(
  config: ResolvedConfig,
  input: PasswordVerify,
): Promise<Result<PasswordVerified>> {
  if (!config.password) return fail("not_found");
  if (!PASSWORD_VERIFY_TOKEN_RE.test(input.token)) return fail("invalid_token");
  const now = config.clock.now();
  const consumed = await consumeVerification(config.storage, {
    purpose: "password-verify",
    valueHash: await sha256Hex(input.token),
    now,
  });
  if (!consumed.ok) return consumed;
  return confirmSignUp(config, consumed.value, input, now, "invalid_token");
}

export interface PasswordVerifyCode {
  email: string;
  code: string;
  ip: string | null;
  userAgent: string | null;
  /** The live anonymous session of the confirm: a mailed proof (plan 12i Task 7). */
  anonymous?: AnonymousCaller | null | undefined;
}

/**
 * The sign-up code (plan 12i Task 20): `password.verifyBy: "code"`. The
 * limits, then the compare of the email code (spec 8.10 items 3 and 5). No
 * row, an expired row, a spent row, and a wrong code run the same HMAC and
 * compare, and each answers `invalid_code`. A wrong code counts one try by
 * compare-and-set; the fifth spends the row and answers
 * `too_many_attempts`. A right code is spent in one conditional update.
 * Then the link's confirm runs (`confirmSignUp`): the claim rule, and the
 * session of an unverified user. A refusal after the spend answers
 * `invalid_code`, as the link answers `invalid_token`.
 */
export async function verifyPasswordCode(
  config: ResolvedConfig,
  input: PasswordVerifyCode,
): Promise<Result<PasswordVerified>> {
  if (!config.password) return fail("not_found");
  if (!(await limit(config, "password-verify-code:ip", ipKey(input.ip), VERIFY_CODE_PER_IP)))
    return fail("rate_limited");
  // A malformed address counts on the IP only, and its compare finds no row.
  const email = normalizeEmail(input.email);
  if (
    email !== null &&
    !(await limit(config, "password-verify-code:email", email, VERIFY_CODE_PER_EMAIL))
  )
    return fail("rate_limited");
  const now = config.clock.now();
  const checked = await compareCode(
    config,
    VERIFY_CODE_MAX_ATTEMPTS,
    "password-verify-otp",
    email,
    input.code,
    now,
  );
  if (!checked.ok) return checked;
  const consumed = await consumeCode(config.storage, checked.value, now);
  if (!consumed.ok) return consumed;
  return confirmSignUp(config, consumed.value, input, now, "invalid_code");
}

/**
 * The confirm of a sign-up, after the spend of its proof: the link's row or
 * the code's row. The claim keeps the password this proof confirms and
 * deletes every other credential of the user, then signs the person in,
 * maybe on another device. A claim or a reset can delete the password row.
 * Then the proof confirms nothing: it answers `refused`, and the user does
 * not change. A reset by the owner keeps the row id and verifies the user.
 * A user already verified gets no session and no change to the user or the
 * credentials. Only `password.updatedAt` is written, by the row check.
 */
async function confirmSignUp(
  config: ResolvedConfig,
  row: VerificationRow,
  input: {
    ip: string | null;
    userAgent: string | null;
    anonymous?: AnonymousCaller | null | undefined;
  },
  now: Date,
  refused: "invalid_token" | "invalid_code",
): Promise<Result<PasswordVerified>> {
  // A proof mailed before enforce went on opens no session for an address of the domain (plan 12d ruling 38).
  const enforced = await enforcedAnswer(config, row.identifier);
  if (enforced) return enforced;
  const passwordId = (row.data as { passwordId?: unknown } | null)?.passwordId;
  if (typeof passwordId !== "string") return fail(refused);
  const ended = endedList(config);
  const upgrade = upgradeSteps(
    config,
    input.anonymous ?? null,
    recordedAnonymous(row.data),
    "mailed",
  );
  // The verify hooks of the claim (plan 12a, Task 18).
  const verify = verifySteps(config, "password_verify");
  const run = () =>
    hookGuard(() =>
      config.storage.transaction(async (tx): Promise<Result<PasswordVerified>> => {
        // A retry runs the claim again. The rows of an attempt that rolled back did not end.
        if (ended) ended.length = 0;
        verify.begin();
        const user = await tx.findOne("user", [
          { field: "email", op: "eq", value: row.identifier },
        ]);
        if (!user) return fail(refused);
        const claimed = { ...user, emailVerified: true, updatedAt: now };
        // `user.beforeVerify`, then the session hook, before the first write,
        // for the D1 undo (see `insertSignUp`). A verified user gets no
        // session and no verify, so no hook.
        if (!user.emailVerified) await verify.before(user);
        // The anonymous upgrade (plan 12i Task 7): its hook before the session hook and its hold.
        if (!user.emailVerified)
          await upgrade.before(tx, claimed, upgradeProof(claimed), "password");
        const prepared = user.emailVerified
          ? null
          : await prepareSession(
              config,
              { user: claimed, ip: input.ip, userAgent: input.userAgent, via: "password" },
              tx,
            );
        // A conditional update, not a read, so that it sees a claim's
        // statements on D1. It is the first write: zero rows refuses with no
        // change. The row must also belong to this user: a user deleted and
        // made again under the address does not inherit the proof.
        const kept = await tx.update(
          "password",
          [
            { field: "id", op: "eq", value: passwordId },
            { field: "userId", op: "eq", value: user.id },
          ],
          { updatedAt: now },
        );
        if (kept === 0) return fail(refused);
        if (prepared === null) return ok({ user, signedIn: null });
        await claimEmail(tx, user.id, { passwordId, username: true }, now, verify, ended);
        await ensureEmailIdentity(tx, user.id, row.identifier, now);
        await upgrade.claim(tx);
        const s = await writeSession(config, prepared, tx);
        return ok({ user: claimed, signedIn: s });
      }),
    );
  let verified: Result<PasswordVerified>;
  try {
    verified = await run();
  } catch (err) {
    // Another proof claimed the user first (review M1). The retry finds a
    // verified user: it answers as for a verified user and fires no pair.
    if (!(err instanceof ClaimLostError)) throw err;
    verified = await run();
  }
  if (verified.ok) {
    // After the commit, before the session hooks (plan 12a).
    await verify.after(verified.value.user);
    await sessionsEnded(config, ended, "claim", verify.stops, verify.endedCount());
    if (verified.value.signedIn) {
      await sessionOpened(config, verified.value.signedIn.session, verified.value.user, "password");
      await upgrade.after();
    }
  }
  return verified;
}

export interface PasswordResetRequest {
  email: string;
  next?: string | undefined;
  ip: string | null;
  /** The captcha token (plan 12b). Undefined in process: no check. Null or "": the request had none. */
  captchaToken?: string | null | undefined;
}

/**
 * Always `sent` for a well-formed call, so a caller cannot learn whether an
 * address has an account. `rate_limited` is the one visible failure. The
 * mail goes after the row is written, never inside a transaction.
 */
export async function requestPasswordReset(
  config: ResolvedConfig,
  input: PasswordResetRequest,
): Promise<Result<{ sent: true }>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  // Before any limit key and before the row: both trust a normalized address.
  const email = normalizeEmail(input.email);
  if (email === null) return ok({ sent: true });
  if (!(await limit(config, "password-reset:ip", ipKey(input.ip), RESET_PER_IP)))
    return fail("rate_limited");
  // After the per-IP limit and before every per-email limit: see checkCaptcha (plan 12b).
  const captcha = await checkCaptcha(
    config,
    "password-reset-request",
    input.captchaToken,
    input.ip,
  );
  if (captcha) return captcha;
  if (!(await limit(config, "password-reset:email", email, RESET_PER_EMAIL)))
    return fail("rate_limited");
  // An enforced address gets no mail and the normal answer, so the answer tells nothing (plan 12d).
  if (await ssoRequiredFor(config, email)) return ok({ sent: true });
  const now = config.clock.now();
  const token = randomToken(PASSWORD_RESET_PREFIX);
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "password-reset",
    identifier: email,
    valueHash: await sha256Hex(token),
    expiresAt: new Date(now.getTime() + pw.resetTtlMinutes * 60_000),
    consumedAt: null,
    data: { next: safeNext(input.next) },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  const link = `${config.baseURL}${config.basePath}/password/reset?token=${encodeURIComponent(token)}`;
  await config.mail.send({
    to: email,
    subject: `Reset your password for ${config.appName}`,
    text: `Open this link to choose a new password. It is valid for ${pw.resetTtlMinutes} minutes.\n\n${link}\n\nIf you did not ask for it, ignore this message. Your password does not change.`,
  });
  // The same event for an address with no account: the answer is the same too.
  config.observe.emit({ name: "password.reset_request", outcome: "success", email });
  return ok({ sent: true });
}

export interface PasswordReset {
  token: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
  /** The clear `td_` token of a trusted device (plan 12c). A live token of the user skips the reset's challenge, as at the sign-in. */
  trustDevice?: string | undefined;
}

/**
 * A reset of a user with the second factor on (plan 12c, owner decision 1 of
 * 2026-10-14): the password is set and every session ends, and the sign-in's
 * challenge takes the session's place. `next` is the reset link's landing path.
 */
export interface ResetChallenge extends TwoFactorPending {
  next: string;
  user: UserRow;
}

/** What a reset answers: a session, or the challenge for a user with the factor on. */
export type ResetResult = (PasswordSession & { next: string }) | ResetChallenge;

/**
 * A reset proves the mailbox, as a magic link does. The order: the limit,
 * a read of the row (a spent or expired link answers at once), the policy,
 * the breach check, the hash, then one transaction that consumes the row
 * first. So a refused password leaves the link usable. In the
 * transaction: an unknown address gets a new verified user; the password
 * row is set; an unverified user is claimed with `keep.passwordId` (every
 * credential of the claimant goes, except the new password); a verified
 * user loses every session and every handoff code, and keeps the passkeys
 * and the social identities (spec 8.7, deviation 2); the other reset
 * links of the address go; a new session starts.
 * A user with the second factor on gets no session: the reset answers the challenge (plan 12c).
 */
export async function resetPassword(
  config: ResolvedConfig,
  input: PasswordReset,
): Promise<Result<ResetResult>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  if (!PASSWORD_RESET_TOKEN_RE.test(input.token)) return fail("invalid_token");
  // Before any read, the breach call, and the hash: each POST costs one
  // breach call and one hash at full cost. The limiter is the owned one,
  // so a refusal holds whatever a supplier does.
  if (!(await limit(config, "password-reset-post:ip", ipKey(input.ip), RESET_POST_PER_IP)))
    return fail("rate_limited");
  const valueHash = await sha256Hex(input.token);
  const now = config.clock.now();
  // A read, not the consume: a refused password must leave the link usable.
  // A missing, spent, or expired row answers at once, with no breach call
  // and no hash. The consume in the transaction stays the authority for a race.
  const peek = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: valueHash },
    { field: "purpose", op: "eq", value: "password-reset" },
  ]);
  if (!peek || peek.consumedAt !== null) return fail("invalid_token");
  if (peek.expiresAt.getTime() <= now.getTime()) return fail("token_expired");
  const refused = await screen(pw, input.password, peek.identifier);
  if (refused) return fail(refused);
  // Before the transaction: a hash inside it would hold a Postgres connection for its CPU time.
  const hash = await pw.hash.hash(input.password);
  return runReset(
    config,
    input,
    peek,
    (tx) => consumeVerification(tx, { purpose: "password-reset", valueHash, now }),
    hash,
    now,
  );
}

/** What a reset proves the mailbox with: the spend of its row in the reset's transaction (plan 9e). */
export type ResetConsume = (tx: StorageAdapter) => Promise<Result<VerificationRow>>;

/**
 * The reset's transaction, its retry, and its after hooks, for the reset
 * link and the reset code (plan 9e). `proof` is the row that `consume`
 * spends, as the caller read it. `consume` spends it after the deletes of
 * the address's older pending rows (the lock order in `applyReset`).
 * `input` carries the session's ip and user agent, and the trust token of
 * the device (plan 12c).
 */
export async function runReset(
  config: ResolvedConfig,
  input: { ip: string | null; userAgent: string | null; trustDevice?: string | undefined },
  proof: VerificationRow,
  consume: ResetConsume,
  hash: string,
  now: Date,
): Promise<Result<ResetResult>> {
  // A reset link or code mailed before enforce went on opens no session (plan 12d ruling 38).
  const enforced = await enforcedAnswer(config, proof.identifier);
  if (enforced) return enforced;
  const ended: ResetEnded = {
    claim: endedList(config),
    reset: endedList(config),
    resetCount: 0,
    stops: impersonationStops(config, "user_end"),
  };
  // The trust row that skipped the gate, for its `lastSeenAt` after the commit.
  const trust: { id: string | null } = { id: null };
  // The user hooks of a user that the reset creates (plan 12a). The
  // transaction runs the sign-up rule itself.
  const made = createSteps(config, "password_reset", { signUpRule: false });
  // The verify hooks of an unverified user that the reset claims (plan 12a, Task 18).
  const verify = verifySteps(config, "password_reset");
  // The refresh families that the reset deletes, to end after its commit (ruling 43 of plan 12e).
  const families = familyEnds();
  let reset: Result<ResetResult> | null = null;
  for (let attempt = 0; reset === null; attempt++) {
    try {
      reset = await hookGuard(() =>
        applyReset(config, input, proof, consume, hash, now, ended, trust, made, verify, families),
      );
    } catch (err) {
      // Caught outside the transaction, so its deletes are undone.
      if (err instanceof ResetRefusedError) {
        reset = fail(err.code);
        break;
      }
      // Two resets for one address raced: the loser's user, email
      // identity, or password create failed on a unique key. Caught here,
      // outside: inside, Postgres has already aborted the transaction, and
      // the abort also undid this call's consume. Run once more, so the
      // read finds the winner's rows.
      if (
        attempt === 0 &&
        err instanceof StorageError &&
        err.code === "unique_violation" &&
        (err.model === "user" || err.model === "identity" || err.model === "password")
      )
        continue;
      // Another proof claimed the user first (review M1). The rollback undid
      // the consume, so the retry spends the link again and finds a verified user.
      if (attempt === 0 && err instanceof ClaimLostError) continue;
      throw err;
    }
  }
  if (reset.ok) {
    // After the commit, before the session hooks and before a challenge answer (plan 12a).
    await verify.after(reset.value.user);
    await made.after(reset.value.user);
    // One reason for one cause: the claim's rows end with `claim`, the
    // verified user's own rows with `password_reset` (fix round 1).
    await sessionsEnded(config, ended.claim, "claim", verify.stops, verify.endedCount());
    await sessionsEnded(config, ended.reset, "password_reset", ended.stops, ended.resetCount);
    config.observe.emit({
      name: "password.reset",
      outcome: "success",
      userId: reset.value.user.id,
      email: reset.value.user.email,
    });
    // After the commit: the back-channel logouts of the ended sessions (plan 12e Task 16).
    await deliverLogouts(config, reset.value.user.id);
    // A gated reset opened no session: the verify of its challenge fires the hook.
    if ("token" in reset.value) {
      await touchTrust(config, trust.id, now);
      await sessionOpened(config, reset.value.session, reset.value.user, "password");
    } else challengeOpened(config, reset.value.user, "password");
    // After the commit and before the answer (plan 12a). The password is set,
    // also when plan 12c answers the second-factor challenge in place of a session.
    await sendNotice(config, {
      event: "password_reset",
      email: reset.value.user.email,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    // An ok answer means the transaction committed. The families end last
    // (ruling 45 of plan 12e). A storage throw here still answers 500. The
    // notice and the hooks have run then, and the deletes are committed.
    await endFamilies(config, families);
  }
  return reset;
}

/**
 * The reset by code (plan 9e). `proof` is a right code that is not spent
 * yet. A password that the policy or the breach check refuses spends it: a
 * right code counts no guess, so one code must not test passwords against
 * the policy and the breach list with no bound. A refused reset link stays
 * usable; its POST has its own per-IP limit. Then the reset link's own path:
 * the hash, and `runReset`, which spends the code as its first statement.
 */
export async function resetWithProof(
  config: ResolvedConfig,
  input: {
    password: string;
    ip: string | null;
    userAgent: string | null;
    trustDevice?: string | undefined;
  },
  proof: VerificationRow,
  consume: ResetConsume,
  now: Date,
): Promise<Result<ResetResult>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  const refused = await screen(pw, input.password, proof.identifier);
  if (refused) {
    await config.storage.update(
      "verification",
      [
        { field: "id", op: "eq", value: proof.id },
        { field: "consumedAt", op: "eq", value: null },
      ],
      { consumedAt: now, updatedAt: now },
    );
    return fail(refused);
  }
  // Before the transaction: a hash inside it would hold a Postgres connection for its CPU time.
  const hash = await pw.hash.hash(input.password);
  return runReset(config, input, proof, consume, hash, now);
}

/** The session rows a reset deleted, by cause. Only one list fills in one reset. Undefined lists when no `afterEnd` hook listens (plan 9h). */
interface ResetEnded {
  claim: SessionRow[] | undefined;
  reset: SessionRow[] | undefined;
  /** The count of the sessions that the reset deleted, for the event `session.end` (plan 12h Task 5). */
  resetCount: number;
  /** The stop rows of the reset's session end (ruling 43 of plan 12f). The claim keeps its own. */
  stops: ImpersonationStops | null;
}

/** The consume of a reset refused: a throw, so the transaction undoes the older-row deletes. */
class ResetRefusedError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

function applyReset(
  config: ResolvedConfig,
  input: { ip: string | null; userAgent: string | null; trustDevice?: string | undefined },
  proof: VerificationRow,
  consume: ResetConsume,
  hash: string,
  now: Date,
  ended: ResetEnded,
  trust: { id: string | null },
  made: CreateSteps,
  verify: VerifySteps,
  families: FamilyEnds,
): Promise<Result<ResetResult>> {
  return config.storage.transaction(async (tx): Promise<Result<ResetResult>> => {
    // A retry runs again from the consume. The rows of an attempt that rolled back did not end.
    if (ended.claim) ended.claim.length = 0;
    if (ended.reset) ended.reset.length = 0;
    ended.resetCount = 0;
    if (ended.stops) ended.stops.rows.length = 0;
    families.ids.clear();
    families.scopes.length = 0;
    trust.id = null;
    made.begin();
    verify.begin();
    // The lock order (plan 12c, Task 12): every reset takes the pending reset
    // rows of its address in id order, then the password row. So the older
    // rows go first, one delete per row in sorted order, then the consume of
    // this reset's own row. The delete of the newer rows comes later, below.
    // Reason: with the consume first, two resets of one address with two
    // proofs each held its own row. One waited on the other's password row,
    // and the other waited on that row in its delete: a Postgres deadlock
    // (adapter-postgres reset-gate-race.test.ts). Now a reset that holds its
    // own row holds every older pending row too, so no cycle can form. On D1
    // the undo of a delete re-inserts the row as it was, so it stays exact.
    const older = (
      await tx.findMany("verification", [
        { field: "purpose", op: "in", value: RESET_PURPOSES },
        { field: "identifier", op: "eq", value: proof.identifier },
        { field: "consumedAt", op: "eq", value: null },
      ])
    )
      .map((v) => v.id)
      .filter((id) => id < proof.id)
      .sort();
    for (const id of older)
      await tx.delete("verification", [
        { field: "id", op: "eq", value: id },
        { field: "consumedAt", op: "eq", value: null },
      ]);
    // Two POSTs of one proof race here, and only one wins. The caller read
    // the row live with this `now`, so a refusal here means that a parallel
    // flow spent or deleted it: a reset, a password change, a newer code
    // request, or a wrong guess at the cap. The last two delete no reset
    // link. So a refusal throws, and the deletes above are undone.
    const consumed = await consume(tx);
    if (!consumed.ok) throw new ResetRefusedError(consumed.code);
    const email = consumed.value.identifier;
    const next = safeNext((consumed.value.data as { next?: unknown } | null)?.next);
    const found = await tx.findOne("user", [{ field: "email", op: "eq", value: email }]);
    let minted: UserRow | null = null;
    let user: UserRow;
    if (!found) {
      // The sign-up rule (plan 12b): a read, after the consume and before
      // the session hook, so a refused user never reaches the hook. The stop
      // undoes the consume, so the link stays usable.
      await mayCreateUser(config, tx, email);
      // `user.beforeCreate` after the rule and before the session hook (plan 12a).
      // Its stop undoes the consume too, so the link stays usable.
      minted = await made.user(tx, draftUserRow({ email, emailVerified: true, name: null }, now));
      user = minted;
    } else user = found.emailVerified ? found : claimedUser(found, now);
    // The second factor (plan 12c, owner decision 1 of 2026-10-14): a reset
    // must not bypass a factor that is on (ASVS 5.0 6.4.3). These are reads,
    // so they come before the session hook below. A minted user and a
    // claimant (an unverified user) have no factor row: every enable needs a
    // verified address. A live trust token of the user skips the gate, as at
    // the password sign-in: the next sign-in on that device skips it too.
    const gate = found?.emailVerified
      ? await gateRead(config, tx, found.id, input.trustDevice, now)
      : null;
    const gatedRow = gate?.gated ? gate.row : null;
    if (gate && !gate.gated) trust.id = gate.trustId;
    // A banned user gets no challenge (plan 12f). The stop comes before the
    // writes below, as the session hook's does; `writeChallenge` checks again.
    if (gatedRow && activeBan(user, now)) stopWith("account_banned");
    // The reset consumes its link first, and the hook runs before every
    // other write (plan 9d, fix round 2). The link row belongs to this
    // request alone, so the D1 undo of the consume is exact; an undo of the
    // writes below would not be (see `insertSignUp`). A refusal undoes the
    // consume with the transaction, so the link stays usable. The deletes of
    // the older rows above also come before the hook: their undo is exact too.
    // The user the hook sees is the user this reset leaves: found, claimed, or minted.
    // A gated reset opens no session here, so no hook runs: the verify of
    // its challenge runs it through `openSession`. `user.beforeVerify` of a
    // claimant goes before the session hook (plan 12a, Task 18).
    if (found && !found.emailVerified) await verify.before(found);
    const prepared: PreparedSession | null = gatedRow
      ? null
      : await prepareSession(
          config,
          { user, ip: input.ip, userAgent: input.userAgent, via: "password" },
          tx,
        );
    // A gated reset opens no session, so `prepareSession` holds no row. The
    // hold of the user row stays (plan 12a Task 11). Else a delete that
    // commits first leaves the `email` identity of a gone user. That row
    // locks the address out of every mailbox sign-up. The hold also takes
    // the user row before the password row, the lock order of every reset.
    if (gatedRow) await holdUser(config.observe, tx, user.id);
    if (minted) await tx.create("user", minted);
    // The new password row before any session delete. A password sign-in
    // in flight re-checks its row by id and by the hash it verified as its
    // last statement. When that re-check still finds the old hash, this
    // write has not run, so the session delete below still removes that
    // sign-in's session. The opposite order lets an old-password sign-in
    // commit a session after the delete.
    const passwordId = await setPassword(tx, user.id, hash, now);
    // The second-factor challenges before any session delete, for the order
    // above: a verify spends its challenge as its last statement (plan 9f).
    await deleteTwoFactorChallenges(tx, user.id);
    if (found && !found.emailVerified) {
      // The claim deletes the claimant's sessions, identities, passkeys,
      // handoff codes, and every other password row, and keeps the new password.
      await claimEmail(tx, user.id, { passwordId }, now, verify, ended.claim);
    } else {
      ended.resetCount = await endSessions(
        tx,
        [{ field: "userId", op: "eq", value: user.id }],
        ended.reset ?? null,
        now,
        ended.stops,
      );
      await deleteHandoffCodes(tx, user.id);
    }
    // The OAuth refresh tokens and codes end with the sessions: a reset after a
    // compromise must cut off every agent too. The consents stay, so the
    // person signs each client in again with no new consent (plan 9g final fix wave).
    await deleteOAuthTokens(tx, user.id, families);
    // The other links and codes for this address. A person who reads the
    // mailbox later must not set a password with a second proof (plan 9e).
    await tx.delete("verification", [
      { field: "purpose", op: "in", value: RESET_PURPOSES },
      { field: "identifier", op: "eq", value: email },
      { field: "consumedAt", op: "eq", value: null },
    ]);
    await ensureEmailIdentity(tx, user.id, email, now);
    if (gatedRow) {
      // The last write, after the challenge delete above, so this reset's
      // own challenge survives it. A second reset of the address deletes it
      // in its own delete: the newer password owns the challenge.
      const { pending } = await writeChallenge(
        config,
        tx,
        gatedRow,
        {
          userId: user.id,
          user,
          via: "password",
          from: "reset",
          ip: input.ip,
          userAgent: input.userAgent,
          next,
        },
        now,
      );
      // The read after the last insert, for D1 (user-hold.ts).
      await userStays(tx, user.id);
      return ok({ ...pending, next, user });
    }
    if (!prepared) throw new Error("authtempo: the session hook step did not run");
    const s = await writeSession(config, prepared, tx);
    return ok({ token: s.token, user, session: s.session, next });
  });
}

/** Writes `hash` into the user's one password row, or creates it. Returns the row id. */
async function setPassword(
  tx: StorageAdapter,
  userId: string,
  hash: string,
  now: Date,
): Promise<string> {
  const existing = await tx.findOne("password", [{ field: "userId", op: "eq", value: userId }]);
  // Zero rows means a claim deleted the row since the read: create one.
  if (
    existing &&
    (await tx.update("password", [{ field: "id", op: "eq", value: existing.id }], {
      hash,
      updatedAt: now,
    })) === 1
  )
    return existing.id;
  const created = await tx.create("password", {
    id: newId(now),
    userId,
    hash,
    createdAt: now,
    updatedAt: now,
  });
  return created.id;
}

/** A change whose password row changed since its verify: a throw, so the transaction undoes its deletes. */
class ChangeRaceError extends Error {}

export interface PasswordChange {
  session: ResolvedSession;
  currentPassword?: string | undefined;
  newPassword: string;
  /** The client IP, for the notice mail (plan 12a). */
  ip?: string | null | undefined;
  /** The user agent, for the notice mail (plan 12a). */
  userAgent?: string | null | undefined;
}

/**
 * Needs a verified email: a claimant's new password row could otherwise
 * land after a claim deleted the passwords. The current password is
 * required when one exists. Every other session of the user ends. A first
 * password, and a change while the second factor is on, need a fresh
 * session (plan 12a).
 */
export async function changePassword(
  config: ResolvedConfig,
  input: PasswordChange,
): Promise<Result<{ ok: true }>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  const { user, session } = input.session;
  if (!provedAccount(user)) return fail("email_unverified");
  const row = await config.storage.findOne("password", [
    { field: "userId", op: "eq", value: user.id },
  ]);
  // A first password is a new way in with no current password to prove.
  // With the factor on, the password proves one factor only (ASVS 5.0.0
  // 7.5.1). Both need a fresh session (plan 12a). The two reads come before
  // the limit, so a stale session counts no try.
  // A first password is a new first factor: none for an address of an enforced domain (plan 12d).
  const enforced = row ? null : await enforcedAnswer(config, user.email);
  if (enforced) return enforced;
  if (!row || (await secondFactorOn(config, user.id))) {
    const fresh = requireFresh(config, session);
    if (!fresh.ok) return fresh;
  }
  if (!(await limit(config, "password-change:user", user.id, CHANGE_PER_USER)))
    return fail("rate_limited");
  if (row) {
    const current = input.currentPassword;
    // The length is the caller's own input. The refusal bounds the CPU.
    if (current === undefined || [...current].length > PASSWORD_MAX_LENGTH)
      return fail("invalid_credentials");
    if (!(await pw.hash.verify(current, row.hash)).ok) return fail("invalid_credentials");
  }
  const refused = await screen(pw, input.newPassword, user.email);
  if (refused) return fail(refused);
  // Before the transaction: a hash inside it would hold a Postgres connection for its CPU time.
  const hash = await pw.hash.hash(input.newPassword);
  const now = config.clock.now();
  const ended = endedList(config);
  const stops = impersonationStops(config, "user_end");
  // The refresh families that the change deletes, to end after its commit (ruling 43 of plan 12e).
  const families = familyEnds();
  let changed: Result<{ ok: true }>;
  // The count of the other sessions that the change deleted (plan 12h Task 5).
  let endedCount = 0;
  try {
    changed = await config.storage.transaction(async (tx): Promise<Result<{ ok: true }>> => {
      // The new hash before the session delete, for the reason in
      // `applyReset`: the sign-in re-check matches the row by id and hash.
      // Do not read `password.updatedAt` as the change time: the sign-in
      // re-check writes it too.
      // The lock order of `applyReset`: the pending reset rows of the
      // address in id order, then the password row. So a change that races
      // a reset waits on it and forms no cycle on Postgres.
      const pending = (
        await tx.findMany("verification", [
          { field: "purpose", op: "in", value: RESET_PURPOSES },
          { field: "identifier", op: "eq", value: user.email },
          { field: "consumedAt", op: "eq", value: null },
        ])
      )
        .map((v) => v.id)
        .sort();
      for (const id of pending)
        await tx.delete("verification", [
          { field: "id", op: "eq", value: id },
          { field: "consumedAt", op: "eq", value: null },
        ]);
      // The user row after the reset rows and before the password row, the
      // order of a reset (plan 12a Task 11). A first password of a deleted
      // user must not stay. Not for an unverified user: a claim may verify
      // that row now (sessions-claim.test.ts, re-review finding B).
      if (user.emailVerified) await holdUser(config.observe, tx, user.id);
      if (row) {
        // Conditional on the hash this call verified, so two changes do not
        // both win. Zero rows throws, so the deletes above are undone.
        const n = await tx.update(
          "password",
          [
            { field: "id", op: "eq", value: row.id },
            { field: "hash", op: "eq", value: row.hash },
          ],
          { hash, updatedAt: now },
        );
        if (n === 0) throw new ChangeRaceError();
      } else {
        await tx.create("password", {
          id: newId(now),
          userId: user.id,
          hash,
          createdAt: now,
          updatedAt: now,
        });
        // The read after the insert, for D1 (user-hold.ts).
        await userStays(tx, user.id);
      }
      // The challenges, the other sessions, the handoff codes, and the OAuth
      // refresh tokens and codes, in one function with the change of
      // address (plan 12a). The challenges go before the session delete, as
      // in a reset (plan 9f).
      endedCount = await endOtherAccess(
        tx,
        user.id,
        session.id,
        ended ?? null,
        families,
        now,
        stops,
      );
      // The pending reset links and codes of the address go, as in a reset.
      // A person who changes the password after a mailbox exposure must not
      // leave a live proof there that sets a password and ends every session.
      await tx.delete("verification", [
        { field: "purpose", op: "in", value: RESET_PURPOSES },
        { field: "identifier", op: "eq", value: user.email },
        { field: "consumedAt", op: "eq", value: null },
      ]);
      return ok({ ok: true });
    });
  } catch (err) {
    if (err instanceof ChangeRaceError) return fail("conflict");
    // The stop of the hold (user-hold.ts).
    if (err instanceof HookStop) return err.result;
    // A concurrent first password (a reset) won the unique key. Caught
    // here, outside: inside, Postgres has already aborted the transaction.
    if (err instanceof StorageError && err.code === "unique_violation" && err.model === "password")
      return fail("conflict");
    throw err;
  }
  if (changed.ok) {
    await sessionsEnded(config, ended, "password_change", stops, endedCount);
    config.observe.emit({ name: "password.change", outcome: "success", userId: user.id });
    await deliverLogouts(config, user.id);
    // After the commit (plan 12a). A first password is a change of a way in too.
    await sendNotice(config, {
      event: "password_changed",
      email: user.email,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    // Last, after the notice and the hooks (ruling 45 of plan 12e).
    await endFamilies(config, families);
  }
  return changed;
}

/**
 * The password of a known user, for an app that asks for it again before a
 * change (plan 9f: the compat shim's two-factor calls). The sign-in's two
 * limits and its dummy verify, so it is no faster guess route than the
 * sign-in. A row that a sign-up holds pending, or a legacy marker, answers
 * `invalid_credentials`: a person proves a legacy password by a sign-in.
 */
export async function verifyPassword(
  config: ResolvedConfig,
  input: PasswordReauth,
): Promise<Result<{ verified: true }>> {
  if (!config.password) return fail("not_found");
  if (!(await limit(config, "password:ip", ipKey(input.ip), SIGN_IN_PER_IP)))
    return fail("rate_limited");
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  // The per-account limit: the address key of the sign-in, or the user id for a
  // user with no address (ruling 15 of plan 12i), so many IPs share one count.
  if (
    user &&
    !(await (hasAddress(user)
      ? limit(config, "password:email", user.email, SIGN_IN_PER_EMAIL)
      : limit(config, "password:user", user.id, SIGN_IN_PER_EMAIL)))
  )
    return fail("rate_limited");
  return checkUserPassword(config, input.userId, input.password);
}

/**
 * The check of `verifyPassword` with no limit (plan 9h): the caller counts
 * on its own key first. The TOTP setup does, so that a stolen session that
 * guesses there cannot hold the owner's password sign-in at `rate_limited`.
 * A missing user, a pending row, and a legacy marker run the dummy verify and
 * answer `invalid_credentials`, so the time does not tell them apart.
 */
export async function checkUserPassword(
  config: ResolvedConfig,
  userId: string,
  password: string,
): Promise<Result<{ verified: true }>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  if ([...password].length > PASSWORD_MAX_LENGTH) return fail("invalid_credentials");
  const row = await config.storage.findOne("password", [
    { field: "userId", op: "eq", value: userId },
  ]);
  if (!row || row.hash.startsWith(PENDING_HASH_PREFIX) || row.hash === LEGACY_VERIFY_HASH) {
    await pw.hash.verify(password, await pw.hash.dummy());
    return fail("invalid_credentials");
  }
  return (await pw.hash.verify(password, row.hash)).ok
    ? ok({ verified: true })
    : fail("invalid_credentials");
}
