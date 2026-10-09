import type { ResolvedConfig } from "../config.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { hasControlChar } from "../primitives/text.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { passwordPolicyError } from "./password-policy.js";
import { createSession } from "./sessions.js";
import { normalizeEmail, userStillUnverified } from "./users.js";

export const PASSWORD_VERIFY_PREFIX = "pv_";
export const PASSWORD_VERIFY_TOKEN_RE = /^pv_[A-Za-z0-9_-]{43}$/;
export const PASSWORD_RESET_PREFIX = "pr_";
export const PASSWORD_RESET_TOKEN_RE = /^pr_[A-Za-z0-9_-]{43}$/;
// 10 per hour per IP: a person makes one account; a script that makes many is slowed.
const SIGN_UP_PER_IP = { seconds: 3600, max: 10 };
const NAME_MAX = 200;

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
