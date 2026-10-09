import type { ResolvedConfig } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { hasControlChar } from "../primitives/text.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow } from "../schema.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";
import { PASSWORD_MAX_LENGTH, passwordPolicyError } from "./password-policy.js";
import { createSession, type ResolvedSession } from "./sessions.js";
import { claimEmail, ensureEmailIdentity, normalizeEmail, userStillUnverified } from "./users.js";
import { consumeVerification } from "./verification.js";

export const PASSWORD_VERIFY_PREFIX = "pv_";
export const PASSWORD_VERIFY_TOKEN_RE = /^pv_[A-Za-z0-9_-]{43}$/;
export const PASSWORD_RESET_PREFIX = "pr_";
export const PASSWORD_RESET_TOKEN_RE = /^pr_[A-Za-z0-9_-]{43}$/;
// 10 per hour per IP: a person makes one account; a script that makes many is slowed.
const SIGN_UP_PER_IP = { seconds: 3600, max: 10 };
const NAME_MAX = 200;
// Per 15 minutes. The email limit stops a guess run on one account from many
// addresses; the IP limit stops one address that tries many accounts.
const SIGN_IN_PER_IP = { seconds: 900, max: 20 };
const SIGN_IN_PER_EMAIL = { seconds: 900, max: 10 };
// Per 15 minutes, as the magic link request.
const RESET_PER_IP = { seconds: 900, max: 20 };
const RESET_PER_EMAIL = { seconds: 900, max: 5 };
// Per 15 minutes. A stolen session must not run an unlimited guess of the current password.
const CHANGE_PER_USER = { seconds: 900, max: 10 };

export interface PasswordSession {
  token: string;
  user: UserRow;
  session: SessionRow;
}

export interface PasswordSignUp {
  email: string;
  password: string;
  name?: string | undefined;
  ip: string | null;
  userAgent: string | null;
}

export interface PasswordSignIn {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}

type Resolved = NonNullable<ResolvedConfig["password"]>;

/**
 * The policy, then the breach check. `email` must be normalized: the
 * policy compares the password with it. A breach check that throws fails
 * closed: the route answers 500.
 */
async function screen(
  pw: Resolved,
  password: string,
  email: string,
): Promise<"password_policy" | "password_breached" | null> {
  const policy = passwordPolicyError(password, email, pw.minLength);
  if (policy) return policy;
  if (pw.breachCheck && (await pw.breachCheck(password))) return "password_breached";
  return null;
}

interface Created {
  signedIn: PasswordSession;
  passwordId: string;
}

/**
 * Creates an unverified user with a password and a session, then mails a
 * link that confirms the address.
 */
export async function passwordSignUp(
  config: ResolvedConfig,
  input: PasswordSignUp,
): Promise<Result<PasswordSession>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  if (!(await config.limiter.allow(`password-sign-up:ip:${input.ip ?? "unknown"}`, SIGN_UP_PER_IP)))
    return fail("rate_limited");
  // Before the policy and before any read: the policy and the lookups trust a normalized address.
  const email = normalizeEmail(input.email);
  if (email === null) return fail("invalid_body");
  const name = input.name;
  if (name !== undefined && (name.length < 1 || name.length > NAME_MAX || hasControlChar(name)))
    return fail("invalid_body");
  const refused = await screen(pw, input.password, email);
  if (refused) return fail(refused);
  // Before the transaction: a hash inside it would hold a Postgres connection for its CPU time.
  const hash = await pw.hash.hash(input.password);
  const now = config.clock.now();
  let created: Result<Created> | null = null;
  for (let attempt = 0; created === null; attempt++) {
    try {
      created = await insertSignUp(config, input, { email, name: name ?? null, hash }, now);
    } catch (err) {
      // A concurrent sign-up or sign-in created the user between our read
      // and our create. Caught here, outside: inside, Postgres has already
      // aborted the transaction. Run once more, so the read finds the
      // winner's row and the answer follows the rules for an existing user:
      // `email_taken_unverified` tells an unverified social winner's owner
      // to use the magic link.
      if (
        attempt === 0 &&
        err instanceof StorageError &&
        err.code === "unique_violation" &&
        err.model === "user"
      )
        continue;
      throw err;
    }
  }
  if (!created.ok) return created;
  await sendVerifyMail(config, email, created.value.passwordId, now);
  return ok(created.value.signedIn);
}

/**
 * One transaction. The new-user guard is the plan 6b one: on D1 a claim
 * (the owner's magic link) can find this user before the commit, so the
 * last statement is a conditional update of the user row where
 * `emailVerified` is false.
 */
function insertSignUp(
  config: ResolvedConfig,
  input: PasswordSignUp,
  row: { email: string; name: string | null; hash: string },
  now: Date,
): Promise<Result<Created>> {
  return config.storage.transaction(async (tx): Promise<Result<Created>> => {
    const existing = await tx.findOne("user", [{ field: "email", op: "eq", value: row.email }]);
    if (existing) {
      if (existing.emailVerified) return fail("email_taken");
      const has = await tx.findOne("password", [{ field: "userId", op: "eq", value: existing.id }]);
      return fail(has ? "email_taken" : "email_taken_unverified");
    }
    const user = await tx.create("user", {
      id: newId(now),
      email: row.email,
      emailVerified: false,
      name: row.name,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    const password = await tx.create("password", {
      id: newId(now),
      userId: user.id,
      hash: row.hash,
      createdAt: now,
      updatedAt: now,
    });
    const s = await createSession(
      config,
      { userId: user.id, ip: input.ip, userAgent: input.userAgent },
      tx,
    );
    // claimEmail flips the flag in its first statement, so any claim since
    // the user create makes this match zero rows. The user row is the
    // owner's now. A throw would undo the user create, and the D1 undo
    // deletes the user row by id with no check: the owner's email identity
    // and session would point to no user. So delete the own session and the
    // own password row by id, and commit. When it matches one row it is the
    // last statement, so no undo runs after it, and a later claim deletes
    // the password row and the session. Checked 2026-10-10.
    if (!(await userStillUnverified(tx, user.id, now))) {
      await tx.delete("session", [{ field: "id", op: "eq", value: s.session.id }]);
      await tx.delete("password", [{ field: "id", op: "eq", value: password.id }]);
      return fail("email_taken_unverified");
    }
    return ok({ signedIn: { token: s.token, user, session: s.session }, passwordId: password.id });
  });
}

/** One `password-verify` row and one mail. The link opens a confirm page with no side effect. */
async function sendVerifyMail(
  config: ResolvedConfig,
  email: string,
  passwordId: string,
  now: Date,
): Promise<void> {
  const token = randomToken(PASSWORD_VERIFY_PREFIX);
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "password-verify",
    identifier: email,
    valueHash: await sha256Hex(token),
    expiresAt: new Date(now.getTime() + config.magicLink.ttlMinutes * 60_000),
    consumedAt: null,
    data: { passwordId },
    createdAt: now,
    updatedAt: now,
  });
  const link = `${config.baseURL}${config.basePath}/password/verify?token=${encodeURIComponent(token)}`;
  await config.mail.send({
    to: email,
    subject: `Confirm your email for ${config.appName}`,
    text: `Open this link to confirm your email address. It is valid for ${config.magicLink.ttlMinutes} minutes.\n\n${link}\n\nIf you did not create an account, ignore this message.`,
  });
}

/**
 * Every failure after the limits answers `invalid_credentials` after one
 * `verify`: an unknown address, a malformed address, and a user with no
 * password row verify against the seam's `dummy()`. So the answer and its
 * CPU are the same as for a wrong password.
 */
export async function passwordSignIn(
  config: ResolvedConfig,
  input: PasswordSignIn,
): Promise<Result<PasswordSession>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  if (!(await config.limiter.allow(`password:ip:${input.ip ?? "unknown"}`, SIGN_IN_PER_IP)))
    return fail("rate_limited");
  // Before any lookup: the lookup and the email limit key trust a normalized address.
  const email = normalizeEmail(input.email);
  if (email !== null && !(await config.limiter.allow(`password:email:${email}`, SIGN_IN_PER_EMAIL)))
    return fail("rate_limited");
  // The length is the caller's own input, so this refusal tells nothing about an account. It bounds the CPU.
  if ([...input.password].length > PASSWORD_MAX_LENGTH) return fail("invalid_credentials");
  const user =
    email === null
      ? null
      : await config.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  const row = user
    ? await config.storage.findOne("password", [{ field: "userId", op: "eq", value: user.id }])
    : null;
  if (!user || !row) {
    await pw.hash.verify(input.password, await pw.hash.dummy());
    return fail("invalid_credentials");
  }
  const checked = await pw.hash.verify(input.password, row.hash);
  if (!checked.ok) return fail("invalid_credentials");
  const now = config.clock.now();
  // The hash this sign-in proved. The session is valid only while the row still holds it.
  let proved = row.hash;
  if (checked.rehash) {
    // Before the transaction: a hash inside it would hold a Postgres connection for its CPU time.
    const fresh = await pw.hash.hash(input.password);
    // Conditional on the id and the old hash. A reset or a change that wrote
    // a new hash since the read keeps its hash. A claim that deleted the row
    // since the read makes this match zero rows, and an update writes no row
    // then. Zero rows means the proved hash is gone: answer the failure now.
    const n = await config.storage.update(
      "password",
      [
        { field: "id", op: "eq", value: row.id },
        { field: "hash", op: "eq", value: row.hash },
      ],
      { hash: fresh, updatedAt: now },
    );
    if (n === 0) return fail("invalid_credentials");
    proved = fresh;
  }
  return config.storage.transaction(async (tx): Promise<Result<PasswordSession>> => {
    const s = await createSession(
      config,
      { userId: user.id, ip: input.ip, userAgent: input.userAgent },
      tx,
    );
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
    return ok({ token: s.token, user, session: s.session });
  });
}

export interface PasswordVerify {
  token: string;
  ip: string | null;
  userAgent: string | null;
}

export interface PasswordVerified {
  user: UserRow;
  signedIn: { token: string; session: SessionRow } | null;
}

/**
 * The sign-up link. The claim keeps the password this link confirms and
 * deletes every other credential of the user, then signs the person in,
 * maybe on another device. When the password row is gone (a claim or a
 * reset deleted it), the link confirms nothing: it is consumed, it answers
 * `invalid_token`, and the user does not change. A user already verified
 * gets no session and no change.
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
  const row = consumed.value;
  const passwordId = (row.data as { passwordId?: unknown } | null)?.passwordId;
  if (typeof passwordId !== "string") return fail("invalid_token");
  return config.storage.transaction(async (tx): Promise<Result<PasswordVerified>> => {
    const user = await tx.findOne("user", [{ field: "email", op: "eq", value: row.identifier }]);
    if (!user) return fail("invalid_token");
    // A conditional update, not a read, so that it sees a claim's
    // statements on D1. It is the first write: zero rows refuses with no
    // change. The row must also belong to this user: a user deleted and
    // made again under the address does not inherit the link.
    const kept = await tx.update(
      "password",
      [
        { field: "id", op: "eq", value: passwordId },
        { field: "userId", op: "eq", value: user.id },
      ],
      { updatedAt: now },
    );
    if (kept === 0) return fail("invalid_token");
    if (user.emailVerified) return ok({ user, signedIn: null });
    await claimEmail(tx, user.id, { passwordId }, now);
    await ensureEmailIdentity(tx, user.id, user.email, now);
    const s = await createSession(
      config,
      { userId: user.id, ip: input.ip, userAgent: input.userAgent },
      tx,
    );
    return ok({ user: { ...user, emailVerified: true, updatedAt: now }, signedIn: s });
  });
}

export interface PasswordResetRequest {
  email: string;
  next?: string | undefined;
  ip: string | null;
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
  if (!(await config.limiter.allow(`password-reset:ip:${input.ip ?? "unknown"}`, RESET_PER_IP)))
    return fail("rate_limited");
  if (!(await config.limiter.allow(`password-reset:email:${email}`, RESET_PER_EMAIL)))
    return fail("rate_limited");
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
  });
  const link = `${config.baseURL}${config.basePath}/password/reset?token=${encodeURIComponent(token)}`;
  await config.mail.send({
    to: email,
    subject: `Reset your password for ${config.appName}`,
    text: `Open this link to choose a new password. It is valid for ${pw.resetTtlMinutes} minutes.\n\n${link}\n\nIf you did not ask for it, ignore this message. Your password does not change.`,
  });
  return ok({ sent: true });
}

export interface PasswordReset {
  token: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * A reset proves the mailbox, as a magic link does. The policy and the
 * breach check run before the consume, so a refused password leaves the
 * link usable. Then one transaction: an unknown address gets a new
 * verified user; the password row is set; an unverified user is claimed
 * with `keep.passwordId` (every credential of the claimant goes, except
 * the new password); a verified user loses every session and keeps the
 * passkeys and the social identities (spec 8.7, deviation 2); a new
 * session starts.
 */
export async function resetPassword(
  config: ResolvedConfig,
  input: PasswordReset,
): Promise<Result<PasswordSession & { next: string }>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  if (!PASSWORD_RESET_TOKEN_RE.test(input.token)) return fail("invalid_token");
  const valueHash = await sha256Hex(input.token);
  const peek = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: valueHash },
    { field: "purpose", op: "eq", value: "password-reset" },
  ]);
  if (!peek) return fail("invalid_token");
  const refused = await screen(pw, input.password, peek.identifier);
  if (refused) return fail(refused);
  // Before the transaction: a hash inside it would hold a Postgres connection for its CPU time.
  const hash = await pw.hash.hash(input.password);
  const now = config.clock.now();
  const consumed = await consumeVerification(config.storage, {
    purpose: "password-reset",
    valueHash,
    now,
  });
  if (!consumed.ok) return consumed;
  const row = consumed.value;
  const next = safeNext((row.data as { next?: unknown } | null)?.next);
  // A failure after this point burns the link by design. The person
  // requests a new one.
  for (let attempt = 0; ; attempt++) {
    try {
      const done = await applyReset(config, input, row.identifier, hash, now);
      return ok({ ...done, next });
    } catch (err) {
      // Two resets for one address raced: the loser's user, email
      // identity, or password create failed on a unique key. Caught here,
      // outside: inside, Postgres has already aborted the transaction. Run
      // once more, so the read finds the winner's rows.
      if (
        attempt === 0 &&
        err instanceof StorageError &&
        err.code === "unique_violation" &&
        (err.model === "user" || err.model === "identity" || err.model === "password")
      )
        continue;
      throw err;
    }
  }
}

function applyReset(
  config: ResolvedConfig,
  input: PasswordReset,
  email: string,
  hash: string,
  now: Date,
): Promise<PasswordSession> {
  return config.storage.transaction(async (tx): Promise<PasswordSession> => {
    let user = await tx.findOne("user", [{ field: "email", op: "eq", value: email }]);
    if (!user) {
      user = await tx.create("user", {
        id: newId(now),
        email,
        emailVerified: true,
        name: null,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    // The new password row before any session delete. A password sign-in
    // in flight re-checks its row by id and by the hash it verified as its
    // last statement. When that re-check still finds the old hash, this
    // write has not run, so the session delete below still removes that
    // sign-in's session. The opposite order lets an old-password sign-in
    // commit a session after the delete.
    const passwordId = await setPassword(tx, user.id, hash, now);
    if (!user.emailVerified) {
      // The claim deletes the claimant's sessions, identities, passkeys,
      // and every other password row, and keeps the new password.
      await claimEmail(tx, user.id, { passwordId }, now);
      user = { ...user, emailVerified: true, updatedAt: now };
    } else {
      await tx.delete("session", [{ field: "userId", op: "eq", value: user.id }]);
    }
    await ensureEmailIdentity(tx, user.id, email, now);
    const s = await createSession(
      config,
      { userId: user.id, ip: input.ip, userAgent: input.userAgent },
      tx,
    );
    return { token: s.token, user, session: s.session };
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

export interface PasswordChange {
  session: ResolvedSession;
  currentPassword?: string | undefined;
  newPassword: string;
}

/**
 * Needs a verified email: a claimant's new password row could otherwise
 * land after a claim deleted the passwords. The current password is
 * required when one exists. Every other session of the user ends.
 */
export async function changePassword(
  config: ResolvedConfig,
  input: PasswordChange,
): Promise<Result<{ ok: true }>> {
  const pw = config.password;
  if (!pw) return fail("not_found");
  const { user, session } = input.session;
  if (!user.emailVerified) return fail("email_unverified");
  if (!(await config.limiter.allow(`password-change:user:${user.id}`, CHANGE_PER_USER)))
    return fail("rate_limited");
  const row = await config.storage.findOne("password", [
    { field: "userId", op: "eq", value: user.id },
  ]);
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
  try {
    return await config.storage.transaction(async (tx): Promise<Result<{ ok: true }>> => {
      // The new hash before the session delete, for the reason in
      // `applyReset`: the sign-in re-check matches the row by id and hash.
      // Do not read `password.updatedAt` as the change time: the sign-in
      // re-check writes it too.
      if (row) {
        // Conditional on the hash this call verified, so two changes do not
        // both win. It is the first write: zero rows refuses with no change.
        const n = await tx.update(
          "password",
          [
            { field: "id", op: "eq", value: row.id },
            { field: "hash", op: "eq", value: row.hash },
          ],
          { hash, updatedAt: now },
        );
        if (n === 0) return fail("conflict");
      } else {
        await tx.create("password", {
          id: newId(now),
          userId: user.id,
          hash,
          createdAt: now,
          updatedAt: now,
        });
      }
      await tx.delete("session", [
        { field: "userId", op: "eq", value: user.id },
        { field: "id", op: "ne", value: session.id },
      ]);
      return ok({ ok: true });
    });
  } catch (err) {
    // A concurrent first password (a reset) won the unique key. Caught
    // here, outside: inside, Postgres has already aborted the transaction.
    if (err instanceof StorageError && err.code === "unique_violation" && err.model === "password")
      return fail("conflict");
    throw err;
  }
}
