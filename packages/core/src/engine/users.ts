import type { ResolvedConfig } from "../config.js";
import { newId } from "../primitives/ids.js";
import { hasControlChar } from "../primitives/text.js";
import type { SessionRow, UserRow } from "../schema.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import { stopWith } from "./hooks.js";
import { endSessions } from "./sessions.js";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
const USER_NAME_MAX = 200;

/**
 * The user name rule: 1 to 200 UTF-16 code units, no control character.
 * The password sign-up applies it, and the importer (plan 9b) applies it
 * too, so one rule holds for both.
 */
export function validUserName(name: string): boolean {
  return name.length >= 1 && name.length <= USER_NAME_MAX && !hasControlChar(name);
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
 * session.afterEnd after the commit (plan 9d).
 */
export async function claimEmail(
  tx: StorageAdapter,
  userId: string,
  keep: ClaimKeep | null,
  now: Date,
  ended?: SessionRow[],
): Promise<void> {
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
): Promise<{ user: UserRow; created: boolean }>;
export function findOrCreateUserByEmail<T>(
  storage: StorageAdapter,
  email: string,
  now: Date,
  after: AfterResolve<T>,
  ended?: SessionRow[],
  before?: BeforeResolveWrite,
): Promise<{ user: UserRow; created: boolean; after: T }>;
export async function findOrCreateUserByEmail<T>(
  storage: StorageAdapter,
  email: string,
  now: Date,
  after?: AfterResolve<T>,
  ended?: SessionRow[],
  before?: BeforeResolveWrite,
): Promise<{ user: UserRow; created: boolean; after?: T }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await createOrFindInTransaction(storage, email, now, after, ended, before);
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
  after: AfterResolve<T> | undefined,
  ended: SessionRow[] | undefined,
  before: BeforeResolveWrite | undefined,
): Promise<{ user: UserRow; created: boolean; after?: T }> {
  return storage.transaction(async (tx) => {
    // A retry runs the claim again. The rows of an attempt that rolled back did not end.
    if (ended) ended.length = 0;
    const { user, created } = await resolveInTransaction(tx, email, now, ended, before);
    if (!after) return { user, created };
    return { user, created, after: await after(tx, user, created) };
  });
}

async function resolveInTransaction(
  tx: StorageAdapter,
  email: string,
  now: Date,
  ended: SessionRow[] | undefined,
  before: BeforeResolveWrite | undefined,
): Promise<{ user: UserRow; created: boolean }> {
  const existing = await tx.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (existing) {
    const resolved = existing.emailVerified
      ? existing
      : { ...existing, emailVerified: true, updatedAt: now };
    // Before the identity repair and the claim: the D1 undo (`BeforeResolveWrite`).
    if (before) await before(tx, resolved, false);
    // An isolate that died between the user create and the identity
    // create left a user with no email identity. Repair it here. A
    // concurrent repair fails unique_violation, which the caller catches
    // outside this transaction.
    await ensureEmailIdentity(tx, existing.id, email, now);
    if (!existing.emailVerified) {
      await claimEmail(tx, existing.id, null, now, ended);
    }
    return { user: resolved, created: false };
  }
  const minted: UserRow = {
    id: newId(now),
    email,
    emailVerified: true,
    name: null,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  // Before the user create: the D1 undo (`BeforeResolveWrite`).
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

/** A `BeforeResolveWrite` that applies the sign-up rule to a created user, then runs `before`. */
export function signUpGuard(
  config: ResolvedConfig,
  before?: BeforeResolveWrite,
): BeforeResolveWrite {
  return async (tx, user, created) => {
    if (created) await mayCreateUser(config, tx, user.email);
    if (before) await before(tx, user, created);
  };
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
