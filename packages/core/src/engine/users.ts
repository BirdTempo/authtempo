import type { ResolvedConfig } from "../config.js";
import { newId } from "../primitives/ids.js";
import type { SessionRow, UserRow } from "../schema.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import type { CreateSteps, VerifySteps } from "./create-steps.js";
import { stopWith } from "./hooks.js";
import { endSessions } from "./sessions.js";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
const USER_NAME_MAX = 200;

/**
 * The characters that a user name must not hold (plan 12a Task 7, review L4).
 * Other people see the name, for example in a member list. A control
 * character (C0, DEL, C1) or a line or paragraph separator can break a line
 * or a header. A format character, such as a bidi override or a zero-width
 * space, can make one name read as another. A lone surrogate is not text.
 * The zero-width non-joiner (U+200C) and joiner (U+200D) pass: Persian names
 * and joined emoji carry them (the lead's ruling, 2026-10-15).
 */
const NAME_REFUSED = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/u;

/**
 * The user name rule: a string of 1 to 200 UTF-16 code units, with no
 * character of NAME_REFUSED. The password sign-up, the profile update, the
 * social fill, the `user.beforeCreate` patch, and the importer (plan 9b)
 * apply it, so one rule holds for all.
 */
export function validUserName(name: string): boolean {
  // A JS caller can pass any value; an array has a length and reads as text (review L1).
  if (typeof name !== "string") return false;
  return name.length >= 1 && name.length <= USER_NAME_MAX && !NAME_REFUSED.test(name);
}

/** The longest image URL. LinkedIn's signed picture URLs pass 255 characters. */
const IMAGE_MAX = 2048;

/**
 * The characters that an image URL must not hold (plan 12a Task 7, review L2
 * of Task 5). They are whitespace of any kind, a control character (C0, DEL,
 * C1), and a format character. A bidi control, a zero-width character, and
 * the soft hyphen are format characters. A lone surrogate and a backslash are
 * refused too. So are `"`, `<`, `>`, a backtick, `{`, `}`, `|`, and `^`
 * (review L2 of Task 7). They are not URL code points: the parser escapes,
 * drops, or rewrites them, so the stored text and the parsed URL could differ.
 * A `"` also breaks an HTML attribute that an app builds by joining strings.
 */
const IMAGE_REFUSED = /[\s\p{Cc}\p{Cf}\p{Cs}\\"<>`{}|^]/u;

/**
 * Text in the authority that the rule refuses (review L2 of Task 7). An `@`
 * starts credentials, and an empty user name is still one. A `%` is an escape
 * that the parser decodes in the host, so the stored host would differ.
 */
const AUTHORITY_REFUSED = /[@%]/;

/** `https://`, then an authority that is not empty. The parser reads `https:/a` and `https:///a` as host `a`. */
const IMAGE_PREFIX = /^https:\/\/[^/?#]/i;

/**
 * The image rule of a profile (plan 12a): an `https://` URL with a host, of
 * at most 2048 characters, with no `@` and no `%` in the authority. It holds
 * no whitespace, no control or format character, no backslash, and none of
 * `"<>\`{}|^`. A private or loopback host passes. A `data:` URL is refused:
 * other people's pages show the image, and the bound would cut it. The
 * social profile, the `user.beforeCreate` patch, the profile update, and the
 * importer apply this one rule.
 */
export function validImageUrl(value: string): boolean {
  // A JS caller can pass any value; an array has a length and reads as text (review L1).
  if (typeof value !== "string") return false;
  if (value.length > IMAGE_MAX || IMAGE_REFUSED.test(value) || !IMAGE_PREFIX.test(value))
    return false;
  // The authority runs from after `https://` to the first `/`, `?`, or `#`.
  const authority = value.slice("https://".length).split(/[/?#]/, 1)[0] ?? "";
  if (AUTHORITY_REFUSED.test(authority)) return false;
  // The prefix fixed the scheme, and the parser refuses an empty `https:` host.
  // With no `@` in the authority, the URL has no credentials.
  try {
    new URL(value);
  } catch {
    return false;
  }
  return true;
}

/**
 * Lowercase, trimmed, and shaped like an address, or null. The shape check
 * is loose on purpose: the magic link proves the address. A control
 * character is never part of an address, and storage rejects U+0000.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  for (const ch of email) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return email;
}

export interface ClaimKeep {
  /** The identity that carries the proof. */
  identityId?: string;
  /** The password row that the proof confirms (the sign-up verify link). */
  passwordId?: string;
}

/**
 * A user created through an unverified email is a claim, not proof. When a
 * sign-in proves the address, every identity that came in before (except
 * the one that carries the proof, and the `email` identity), every
 * session, every password row (except the one `keep.passwordId` names),
 * every passkey, every pending passkey challenge, and every
 * unredeemed handoff code are deleted, so a claimant cannot keep access to the account.
 * Runs inside the caller's transaction. When `ended` is given, the session
 * rows the claim deletes are pushed onto it, so the caller fires
 * session.afterEnd after the commit (plan 9d). `verified` is required, so
 * the type check finds each caller. It throws when the caller did not run
 * `user.beforeVerify` for this user (plan 12a, Task 18).
 */
export async function claimEmail(
  tx: StorageAdapter,
  userId: string,
  keep: ClaimKeep | null,
  now: Date,
  verified: VerifySteps,
  ended?: SessionRow[],
): Promise<void> {
  verified.claimed(userId);
  // First, so a concurrent session insert for this user sees the verified flag and undoes itself (see the conditional update after each session insert).
  await tx.update("user", [{ field: "id", op: "eq", value: userId }], {
    emailVerified: true,
    updatedAt: now,
  });
  const where: Where<"identity">[] = [
    { field: "userId", op: "eq", value: userId },
    { field: "provider", op: "ne", value: "email" },
  ];
  if (keep?.identityId) where.push({ field: "id", op: "ne", value: keep.identityId });
  await tx.delete("identity", where);
  // Before the session delete. A password sign-in of an unverified user
  // checks its password row as the last statement after its session
  // insert. When that check still finds the row, this delete has not run,
  // so the session delete below still removes that sign-in's session.
  const passwords: Where<"password">[] = [{ field: "userId", op: "eq", value: userId }];
  if (keep?.passwordId) passwords.push({ field: "id", op: "ne", value: keep.passwordId });
  await tx.delete("password", passwords);
  // With an `afterEnd` hook, each row by id; with none, one statement (plan 9h).
  // The last delete is by user id, so a session that another request adds
  // after the read goes too.
  await endSessions(tx, [{ field: "userId", op: "eq", value: userId }], ended ?? null);
  // A claimant's passkeys would keep the account open after the claim.
  // Registration already needs a verified email; this closes any other path.
  await tx.delete("passkey", [{ field: "userId", op: "eq", value: userId }]);
  await tx.delete("verification", [
    { field: "purpose", op: "eq", value: "passkey-challenge" },
    { field: "identifier", op: "eq", value: userId },
  ]);
  // A handoff code minted for the claimant would trade for a session after the claim.
  await tx.delete("verification", [
    { field: "purpose", op: "eq", value: "handoff-code" },
    { field: "identifier", op: "eq", value: userId },
  ]);
}

/**
 * Work that runs inside the resolution transaction after the user is
 * resolved, such as the sign-in's session. It commits with the claim, so a
 * claimant's write cannot land between the claim and this work.
 */
export type AfterResolve<T> = (tx: StorageAdapter, user: UserRow, created: boolean) => Promise<T>;

/**
 * Work that runs inside the resolution transaction before its first write,
 * with the user as the resolution will leave it: the sign-in's session hook
 * (plan 9d, fix round 2). On D1 a throw after a write runs an undo that is
 * not exact (see `insertSignUp` in password.ts), so the hook goes first.
 * `created` is true when the transaction is about to create that user (plan
 * 12b, the sign-up rule). A throw undoes the transaction.
 */
export type BeforeResolveWrite = (
  tx: StorageAdapter,
  user: UserRow,
  created: boolean,
) => Promise<void>;

/**
 * Thrown inside a transaction when a claim verified the user after this
 * transaction read the user as unverified. The throw undoes the session
 * insert. The caller catches it outside the transaction.
 */
export class ClaimRacedError extends Error {
  constructor() {
    super("authtempo: a claim raced this session insert");
    this.name = "ClaimRacedError";
  }
}

/**
 * Runs inside the caller's transaction, after a session insert for a user
 * who was unverified when the transaction read the row. Throws
 * `ClaimRacedError` when the user is verified now.
 */
export async function undoSessionIfClaimed(
  tx: StorageAdapter,
  userId: string,
  now: Date,
): Promise<void> {
  if (!(await userStillUnverified(tx, userId, now))) throw new ClaimRacedError();
}

/**
 * Runs inside the caller's transaction. False when a claim verified the
 * user since this transaction read or created it. `claimEmail` flips the
 * flag in its first statement, so a conditional update sees any claim.
 */
export async function userStillUnverified(
  tx: StorageAdapter,
  userId: string,
  now: Date,
): Promise<boolean> {
  const n = await tx.update(
    "user",
    [
      { field: "id", op: "eq", value: userId },
      { field: "emailVerified", op: "eq", value: false },
    ],
    { updatedAt: now },
  );
  return n > 0;
}

/**
 * Runs inside the caller's transaction, as its last statement, after a
 * session insert that an identity row authorizes. `claimEmail` deletes
 * every identity except the proving one and the `email` one, so a claim
 * that ran since the identity read makes this match zero rows. Throws
 * `ClaimRacedError` then.
 */
export async function undoSessionIfIdentityGone(
  tx: StorageAdapter,
  identityId: string,
  now: Date,
): Promise<void> {
  if (!(await identityStillLinked(tx, identityId, now))) throw new ClaimRacedError();
}

/**
 * Runs inside the caller's transaction. False when a claim deleted the
 * identity row since the identity read. A conditional update, not a read,
 * so that it sees the claim's first statement on D1.
 */
async function identityStillLinked(
  tx: StorageAdapter,
  identityId: string,
  now: Date,
): Promise<boolean> {
  const n = await tx.update("identity", [{ field: "id", op: "eq", value: identityId }], {
    updatedAt: now,
  });
  return n > 0;
}

export function findOrCreateUserByEmail(
  storage: StorageAdapter,
  email: string,
  now: Date,
  verified: VerifySteps,
): Promise<{ user: UserRow; created: boolean }>;
export function findOrCreateUserByEmail<T>(
  storage: StorageAdapter,
  email: string,
  now: Date,
  verified: VerifySteps,
  after: AfterResolve<T>,
  ended?: SessionRow[],
  before?: BeforeResolveWrite,
  steps?: CreateSteps,
): Promise<{ user: UserRow; created: boolean; after: T }>;
export async function findOrCreateUserByEmail<T>(
  storage: StorageAdapter,
  email: string,
  now: Date,
  verified: VerifySteps,
  after?: AfterResolve<T>,
  ended?: SessionRow[],
  before?: BeforeResolveWrite,
  steps?: CreateSteps,
): Promise<{ user: UserRow; created: boolean; after?: T }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await createOrFindInTransaction(
        storage,
        email,
        now,
        verified,
        after,
        ended,
        before,
        steps,
      );
    } catch (err) {
      // A concurrent call created the user between our read and our create.
      // Run the resolution once more, outside the failed transaction, so it
      // finds the winner's row, claims it when it is unverified, and runs
      // `after` inside a transaction. Any other failure is a real error.
      if (
        attempt === 0 &&
        err instanceof StorageError &&
        err.code === "unique_violation" &&
        (err.model === "user" || err.model === "identity")
      ) {
        continue;
      }
      throw err;
    }
  }
}

function createOrFindInTransaction<T>(
  storage: StorageAdapter,
  email: string,
  now: Date,
  verified: VerifySteps,
  after: AfterResolve<T> | undefined,
  ended: SessionRow[] | undefined,
  before: BeforeResolveWrite | undefined,
  steps: CreateSteps | undefined,
): Promise<{ user: UserRow; created: boolean; after?: T }> {
  return storage.transaction(async (tx) => {
    // A retry runs the claim again. The rows of an attempt that rolled back did not end.
    if (ended) ended.length = 0;
    // A retry forgets the user and the identity of the attempt that rolled back.
    steps?.begin();
    verified.begin();
    const { user, created } = await resolveInTransaction(
      tx,
      email,
      now,
      verified,
      ended,
      before,
      steps,
    );
    if (!after) return { user, created };
    return { user, created, after: await after(tx, user, created) };
  });
}

async function resolveInTransaction(
  tx: StorageAdapter,
  email: string,
  now: Date,
  verified: VerifySteps,
  ended: SessionRow[] | undefined,
  before: BeforeResolveWrite | undefined,
  steps: CreateSteps | undefined,
): Promise<{ user: UserRow; created: boolean }> {
  const existing = await tx.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (existing) {
    const resolved = existing.emailVerified
      ? existing
      : { ...existing, emailVerified: true, updatedAt: now };
    // `user.beforeVerify`, then the session hook, before the identity repair
    // and the claim: the D1 undo (`BeforeResolveWrite`).
    if (!existing.emailVerified) await verified.before(existing);
    if (before) await before(tx, resolved, false);
    // An isolate that died between the user create and the identity
    // create left a user with no email identity. Repair it here. A
    // concurrent repair fails unique_violation, which the caller catches
    // outside this transaction.
    await ensureEmailIdentity(tx, existing.id, email, now);
    if (!existing.emailVerified) {
      await claimEmail(tx, existing.id, null, now, verified, ended);
    }
    return { user: resolved, created: false };
  }
  const drafted: UserRow = {
    id: newId(now),
    email,
    emailVerified: true,
    name: null,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  // The sign-up rule and `user.beforeCreate`, then the session hook, all
  // before the user create (plan 12a, spec 8.9): the D1 undo (`BeforeResolveWrite`).
  const minted = steps ? await steps.user(tx, drafted) : drafted;
  if (before) await before(tx, minted, true);
  const user = await tx.create("user", minted);
  await tx.create("identity", {
    id: newId(now),
    userId: user.id,
    provider: "email",
    subject: email,
    linkedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { user, created: true };
}

/**
 * The sign-up rule at a create (plan 12b): stops the flow with
 * `sign_up_closed` unless `signUp` lets `email` become a user. It reads the
 * invitation in the create's transaction, so an invitation revoked before
 * the commit refuses it.
 */
export async function mayCreateUser(
  config: ResolvedConfig,
  tx: StorageAdapter,
  email: string,
): Promise<void> {
  if (config.signUp === "open") return;
  if (config.signUp === "invited") {
    const [pending] = await tx.findMany(
      "invitation",
      [
        { field: "email", op: "eq", value: email },
        { field: "acceptedAt", op: "eq", value: null },
        { field: "expiresAt", op: "gt", value: config.clock.now() },
      ],
      { limit: 1 },
    );
    if (pending) return;
  }
  stopWith("sign_up_closed");
}

/**
 * The sign-up rule of a user that a sign-in creates (plan 12b): stops the
 * flow with `sign_up_closed` unless `signUp` lets `user` become a user.
 * Under `"invited"` the created user needs a proved address (owner ruling,
 * 2026-10-15). Else a stranger who knows an invited address gets a
 * signed-in user through a social account with that address unverified. The
 * magic link and the email code create a verified user, so only social
 * meets this check. `createSteps` runs it before `user.beforeCreate` (plan
 * 12a), so no hook sees a create that the rule refuses.
 */
export async function signUpRule(
  config: ResolvedConfig,
  tx: StorageAdapter,
  user: UserRow,
): Promise<void> {
  if (config.signUp === "invited" && !user.emailVerified) stopWith("sign_up_closed");
  await mayCreateUser(config, tx, user.email);
}

/** The `email` identity means "this address signs in by magic link". It exists once the address is proved. */
export async function ensureEmailIdentity(
  tx: StorageAdapter,
  userId: string,
  email: string,
  now: Date,
): Promise<void> {
  const found = await tx.findOne("identity", [
    { field: "provider", op: "eq", value: "email" },
    { field: "subject", op: "eq", value: email },
  ]);
  if (!found) {
    await tx.create("identity", {
      id: newId(now),
      userId,
      provider: "email",
      subject: email,
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
}
