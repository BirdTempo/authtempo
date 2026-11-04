import type { ResolvedConfig } from "../config.js";
import { newId } from "../primitives/ids.js";
import { hasRefusedChar } from "../primitives/text.js";
import { fail, ok, type Result } from "../result.js";
import type { IdentityRow, SessionRow, UserRow } from "../schema.js";
import { findManyIn, IN_CHUNK } from "../storage/batch.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";
import type { CreateSteps, VerifySteps } from "./create-steps.js";
import { stopWith } from "./hooks.js";
import { endSessions } from "./sessions.js";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;
const USER_NAME_MAX = 200;

/**
 * The rule of a name that other people or other devices show. It is a
 * string of 1 to `max` UTF-16 code units with no character of
 * `hasRefusedChar`. The user
 * name and the passkey name (plan 12a Task 19) apply it, so one character
 * rule holds for both.
 */
export function validShownName(name: string, max: number): boolean {
  // A JS caller can pass any value; an array has a length and reads as text (review L1).
  if (typeof name !== "string") return false;
  return name.length >= 1 && name.length <= max && !hasRefusedChar(name);
}

/**
 * The user name rule: `validShownName` with at most 200 code units. The
 * password sign-up, the profile update, the social fill, the
 * `user.beforeCreate` patch, and the importer (plan 9b) apply it, so one
 * rule holds for all.
 */
export function validUserName(name: string): boolean {
  return validShownName(name, USER_NAME_MAX);
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

/** The longest address, in UTF-16 code units. */
const EMAIL_MAX = 254;

/**
 * The steps that an address and an address prefix share: trimmed,
 * lowercase, at most `EMAIL_MAX` long, and with no control character. Or
 * null. One function, so the address rule and the prefix rule cannot drift.
 */
function normalizeAddressText(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (text.length > EMAIL_MAX) return null;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return text;
}

/**
 * Lowercase, trimmed, and shaped like an address, or null. The shape check
 * is loose on purpose: the magic link proves the address. A control
 * character is never part of an address, and storage rejects U+0000.
 */
export function normalizeEmail(raw: string): string | null {
  const email = normalizeAddressText(raw);
  if (email === null || !EMAIL_RE.test(email)) return null;
  return email;
}

/**
 * The start of an address for a prefix search (plan 12f): the steps of
 * `normalizeEmail` with no shape check, or null. An empty prefix is null.
 * A lone surrogate is null too, because the `startsWith` rule of the
 * storage port refuses it. NUL is a control character, so it is null.
 */
export function normalizeEmailPrefix(raw: string): string | null {
  const prefix = normalizeAddressText(raw);
  if (prefix === null || prefix === "" || /\p{Cs}/u.test(prefix)) return null;
  return prefix;
}

export interface ClaimKeep {
  /** The identity that carries the proof. */
  identityId?: string;
  /** The password row that the proof confirms (the sign-up verify link). */
  passwordId?: string;
  /**
   * Keep the username. Only the sign-up's own confirm sets it: its proof is
   * of the address that the sign-up named with that username.
   */
  username?: true;
}

/**
 * The user row as `claimEmail` with no `keep.username` leaves it: verified,
 * with no username and no phone.
 */
export function claimedUser(user: UserRow, now: Date): UserRow {
  return {
    ...user,
    emailVerified: true,
    username: null,
    displayUsername: null,
    phone: null,
    updatedAt: now,
  };
}

/**
 * A user created through an unverified email is a claim, not proof. When a
 * sign-in proves the address, every identity that came in before (except
 * the one that carries the proof, and the `email` identity), every password
 * row (except the one `keep.passwordId` names), every passkey, every
 * pending passkey challenge, every unredeemed handoff code, and every
 * session are deleted, in that order. The username is cleared, except
 * where `keep.username` says so. The phone is always cleared.
 * The claimant's sessions were made before the proof, so their `proved`
 * flag is false (plan 12p). Each check of a verified address reads that
 * flag, so such a session makes no token, grant, factor, or address change
 * between the flip and its delete. So the claimant keeps no way in.
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
  // Only an unverified row: of two proofs of one user at once, one claims (plan 12a Task 18, review M1).
  const flipped = await tx.update(
    "user",
    [
      { field: "id", op: "eq", value: userId },
      { field: "emailVerified", op: "eq", value: false },
    ],
    // A claimant chose the username, and the owner must not inherit it: a
    // username is a way in and the name of each passkey (ruling 16 M2).
    // A phone is a way in too. Core sets none on an unverified user, but a
    // Better Auth store can hold one (final review A M2 of plan 12i).
    keep?.username
      ? { emailVerified: true, phone: null, updatedAt: now }
      : { emailVerified: true, username: null, displayUsername: null, phone: null, updatedAt: now },
  );
  if (flipped === 0) {
    // An account delete took the row: `conflict`, as the read after a session insert answers (user-hold.ts).
    if (!(await tx.findOne("user", [{ field: "id", op: "eq", value: userId }])))
      stopWith("conflict");
    throw new ClaimLostError();
  }
  const where: Where<"identity">[] = [
    { field: "userId", op: "eq", value: userId },
    { field: "provider", op: "ne", value: "email" },
  ];
  if (keep?.identityId) where.push({ field: "id", op: "ne", value: keep.identityId });
  // Every row that a sign-in trusts goes before the sessions (plan 12p).
  // The flip comes first for the guards of the sign-ins that read the user.
  // A sign-in that trusts a row ends its transaction with a conditional
  // update on that row: the identity, the password, the passkey, or the
  // handoff code. When that update still finds the row, its delete below
  // has not run, so the session delete after it still removes the session.
  await tx.delete("identity", where);
  const passwords: Where<"password">[] = [{ field: "userId", op: "eq", value: userId }];
  if (keep?.passwordId) passwords.push({ field: "id", op: "ne", value: keep.passwordId });
  await tx.delete("password", passwords);
  // A claimant's passkeys would keep the account open after the claim.
  // Registration already needs a proved session; this closes any other path.
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
  // The sessions last (plan 12p), so a sign-in whose guard passed above has
  // its session removed here.
  // With an `afterEnd` hook, one read and one `deleteRows` of the read ids
  // per chunk; with none, one statement (plan 9h). So the claimant's session
  // count adds no query (final review B M of plan 12i). The ended list holds
  // the rows that each chunk removed (plan 12o). A session that another flow
  // ended after the read is not in it, and no race throws. The last
  // delete is by user id, so a session that another request adds after the
  // read goes too. The count goes to the event `session.end` of the claim
  // (plan 12h Task 5).
  verified.sessionsEnded(
    await endSessions(
      tx,
      [{ field: "userId", op: "eq", value: userId }],
      ended ?? null,
      now,
      verified.stops,
      true,
    ),
  );
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
 * The claim retries of one flow (ruling 46 of plan 12i). A flow retries a
 * `ClaimLostError` while its count of claim retries is below this count.
 * Since plan 12o a claim throws it on a lost flip only: no session race
 * throws. A flow counts its claim retries apart from a unique-key retry
 * (decision 13 of plan 12n). On a store with a query limit per invocation,
 * a flow runs none (`claimRetry`).
 */
export const CLAIM_RUNS = 3;

/**
 * Thrown by `claimEmail` when another flow verified the user after this
 * transaction read it as unverified (plan 12a Task 18, review M1). The throw
 * undoes this transaction. Each flow catches it outside and runs once more.
 * The retry finds a verified user and claims nothing. So the verify pair
 * fires once, for the flow that claimed.
 *
 * It is the one race that a claim throws on (plan 12o). Another flow can
 * end a session between the claim's read and its delete. Then `deleteRows`
 * does not answer that row, and the claim goes on (`endSessions`).
 */
export class ClaimLostError extends Error {
  constructor() {
    super("authtempo: another flow claimed this user first");
    this.name = "ClaimLostError";
  }
}

/**
 * The step of a claim flow after an attempt threw `err`, outside the
 * transaction that the throw undid. "retry" runs the attempt again,
 * "conflict" answers 409 `conflict`, and null passes `err` on. `lost` is
 * the count of claim retries that the flow ran before this throw.
 *
 * On a store with `queryLimitPerInvocation`, a flow runs no claim retry
 * (ruling 32 of plan 12n). There a second run does not fit the 50 queries
 * of one invocation. The D1 measure of 2026-11-03 used the worst claim join:
 * an ID-token claim with a full bag, 11 claimant sessions, and every hook.
 * It sent 39 queries with no race, 58 with one race, and 85 with two.
 * Since plan 12o only a lost flip throws `ClaimLostError`, and a lost flip
 * writes nothing. So the answer `conflict` comes after the undo of the
 * writes before the flip, and no claim write stays. A session race ends no
 * claim: on 2026-11-04 that join signed in through one race in 39 queries
 * (adapter-d1 test anonymous-upgrade-budget.test.ts). The magic link and the
 * email code spent their proof before the claim, so each mails a new one of
 * its kind. The sign-up confirm mails nothing: the address is verified, so
 * its answer says to sign in. A provider token needs a new sign-in. The
 * reset and the invitation confirm keep their link, so the same request
 * works again.
 *
 * The unique-key retry of a flow is no claim retry, and it runs on every
 * store. The same D1 join after one unique-key retry sent 46 queries on
 * 2026-11-03, inside the cap (the same adapter-d1 test file). After a claim
 * that `keep` made final, a flow runs no retry of any kind.
 */
export function claimRetry(
  storage: StorageAdapter,
  err: unknown,
  lost: number,
): "retry" | "conflict" | null {
  if (!(err instanceof ClaimLostError)) return null;
  if (storage.queryLimitPerInvocation === true) return "conflict";
  return lost < CLAIM_RUNS ? "retry" : null;
}

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
  // The claim retries, apart from the unique-key retry (CLAIM_RUNS).
  let lost = 0;
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
      // A kept claim cannot run again (plan 12o): the error passes on.
      if (verified.kept()) throw err;
      if (
        attempt === 0 &&
        err instanceof StorageError &&
        err.code === "unique_violation" &&
        (err.model === "user" || err.model === "identity")
      ) {
        continue;
      }
      // Another proof claimed the user first (review M1): the retry signs in
      // the verified user.
      const next = claimRetry(storage, err, lost++);
      if (next === "retry") continue;
      // The callers run this resolution inside `hookGuard`.
      if (next === "conflict") {
        verified.flipLost();
        stopWith("conflict");
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
    const resolved = existing.emailVerified ? existing : claimedUser(existing, now);
    // `user.beforeVerify`, then the session hook, before the identity repair
    // and the claim: the D1 undo (`BeforeResolveWrite`).
    if (!existing.emailVerified) await verified.before(existing);
    if (before) await before(tx, resolved, false);
    // An isolate that died between the user create and the identity
    // create left a user with no email identity. Repair it here. A
    // concurrent repair fails unique_violation, which the caller catches
    // outside this transaction.
    await ensureEmailIdentity(tx, existing.id, email, now, verified);
    if (!existing.emailVerified) {
      await claimEmail(tx, existing.id, null, now, verified, ended);
      // The claim's last write: a later throw keeps the claim (plan 12o).
      // The `email` identity came before the claim, so it stays too.
      await verified.keep(tx, resolved);
    }
    return { user: resolved, created: false };
  }
  // The sign-up rule and `user.beforeCreate`, then the session hook, all
  // before the user create (plan 12a, spec 8.9): the D1 undo (`BeforeResolveWrite`).
  // The read above found no user, so the shared create sends it no second time.
  const made = await createUserIn(
    tx,
    steps ?? NO_CREATE_HOOKS,
    { email, emailVerified: true, name: null, image: null },
    now,
    {
      addressRead: true,
      ...(before
        ? {
            before: async (t: StorageAdapter, minted: UserRow) => {
              await before(t, minted, true);
              return ok(true);
            },
          }
        : {}),
    },
  );
  if (!made.ok) stopWith(made.code);
  return { user: made.value, created: true };
}

/** The steps of a resolve with no hook (a test that calls the resolver directly). */
const NO_CREATE_HOOKS: CreateSteps = {
  begin() {},
  user: async (_tx, user) => user,
  identity: async () => {},
  after: async () => {},
};

/** The fields of a new user row that a writer names; `draftUserRow` sets the rest. */
export type UserDraftFields = Pick<UserRow, "email" | "emailVerified" | "name"> &
  Partial<Pick<UserRow, "id" | "image" | "username" | "displayUsername" | "phone" | "isAnonymous">>;

/**
 * The one builder of a new user row (plan 12i Task 1). Each writer of a
 * user row drafts it here, runs its sign-up rule and its hooks on the
 * draft, and then creates it. So every new field of the row has one
 * default: no ban, no username, no phone, not anonymous. Two writers
 * build the row by hand: `writeUser` of the importer
 * (packages/import/src/import.ts) and the compat sign-up answer
 * (packages/compat-better-auth/src/server/api.ts). The type fails their
 * compile when a field is new, so a new field needs a value there too.
 */
export function draftUserRow(fields: UserDraftFields, now: Date): UserRow {
  return {
    id: fields.id ?? newId(now),
    email: fields.email,
    emailVerified: fields.emailVerified,
    name: fields.name,
    image: fields.image ?? null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    username: fields.username ?? null,
    displayUsername: fields.displayUsername ?? null,
    phone: fields.phone ?? null,
    isAnonymous: fields.isAnonymous ?? false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The fields of a new user that `createUserIn` writes (plan 12f2 Task 1).
 * `email` is normalized, or null with `phone`. `emailVerified: true` needs
 * `email`. `phone` is E.164 and checked by the caller. It needs a verified
 * address or none: a proof of the address clears the phone
 * (`claimEmail`), so core sets no phone on an unverified address (plan 12i).
 */
export interface NewUserInput {
  /** The id, when the caller names the user first (the audit draft of `createAdmin`). */
  id?: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
  phone?: string;
}

/**
 * A step of the caller after the hooks of `createUserIn` and before its
 * first write, for the before hooks of the caller's other rows: the D1 undo
 * needs every before hook first (plan 9d). A refusal answers through
 * `createUserIn`, and the create writes nothing.
 */
export type BeforeUserWrite = (tx: StorageAdapter, user: UserRow) => Promise<Result<unknown>>;

export interface CreateUserOptions {
  before?: BeforeUserWrite;
  /**
   * The caller read `email` in this transaction and found no user, so the
   * create does not send that read again. The unique key of the address
   * still refuses a parallel create.
   */
  addressRead?: true;
}

/**
 * The one create of a new user with its address checks (plan 12f2 Task
 * 1), in the caller's transaction. It reads the address and the phone
 * first: a match answers `email_taken` or `phone_taken`, and nothing is
 * written. Then it drafts the row (`draftUserRow`) and runs `steps.user`
 * (the sign-up rule of the steps and `user.beforeCreate` with its `via`,
 * which may patch the name and the image). Then the caller's `before`.
 * Then it writes the row and, for a verified address, the `email`
 * identity. It reads no sign-up rule of its own: each caller decides it
 * first or through its steps. The loser of a race throws `StorageError`
 * with `unique_violation`, which the caller maps with `takenCode` after
 * the transaction. Callers: the operator create (plan 12f2), `createAdmin`
 * (plan 12f), and the create of `findOrCreateUserByEmail` (the magic link,
 * the email code, and the SCIM create of plan 12d).
 */
export async function createUserIn(
  tx: StorageAdapter,
  steps: CreateSteps,
  input: NewUserInput,
  now: Date,
  options: CreateUserOptions = {},
): Promise<Result<UserRow>> {
  // Programming errors, not answers: each caller checks its input first.
  if (input.emailVerified && input.email === null)
    throw new Error("authtempo: createUserIn: a verified user needs an address");
  if (input.email === null && input.phone === undefined)
    throw new Error("authtempo: createUserIn: a user needs an address or a phone");
  if (input.phone !== undefined && input.email !== null && !input.emailVerified)
    throw new Error("authtempo: createUserIn: a phone needs a verified address or none");
  if (
    input.email !== null &&
    !options.addressRead &&
    (await tx.findOne("user", [{ field: "email", op: "eq", value: input.email }]))
  )
    return fail("email_taken");
  if (
    input.phone !== undefined &&
    (await tx.findOne("user", [{ field: "phone", op: "eq", value: input.phone }]))
  )
    return fail("phone_taken");
  const drafted = draftUserRow(
    {
      ...(input.id !== undefined ? { id: input.id } : {}),
      email: input.email,
      emailVerified: input.emailVerified,
      name: input.name,
      image: input.image,
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
    },
    now,
  );
  const minted = await steps.user(tx, drafted);
  if (options.before) {
    const ready = await options.before(tx, minted);
    if (!ready.ok) return ready;
  }
  const user = await tx.create("user", minted);
  // The `email` identity follows the address (email-change.ts), and no user
  // holds this one, so no identity holds it: one create, not `ensureEmailIdentity`.
  if (user.emailVerified && user.email !== null)
    await tx.create("identity", {
      id: newId(now),
      userId: user.id,
      provider: "email",
      subject: user.email,
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  return ok(user);
}

/**
 * The code of a create that lost a unique-key race, read after the
 * transaction: inside it, Postgres has already aborted it (spec 8.14 item
 * 6). Null for any other error, which the caller throws again.
 */
export function takenCode(error: unknown): "email_taken" | "phone_taken" | null {
  if (!(error instanceof StorageError) || error.code !== "unique_violation") return null;
  if (error.model !== "user") return null;
  if (error.fields.includes("email")) return "email_taken";
  if (error.fields.includes("phone")) return "phone_taken";
  return null;
}

/**
 * The sign-up rule at a create (plan 12b): stops the flow with
 * `sign_up_closed` unless `signUp` lets `email` become a user. It reads the
 * invitations and their organizations in the create's transaction. So an
 * invitation revoked before the commit refuses it, and so does an
 * invitation of a deleted organization. A null address (plan 12i) passes
 * `"open"` and stops under `"invited"`, because an invitation names an
 * address.
 */
export async function mayCreateUser(
  config: ResolvedConfig,
  tx: StorageAdapter,
  email: string | null,
): Promise<void> {
  if (config.signUp === "open") return;
  if (config.signUp === "invited" && email !== null) {
    const pending = await tx.findMany(
      "invitation",
      [
        { field: "email", op: "eq", value: email },
        { field: "acceptedAt", op: "eq", value: null },
        { field: "expiresAt", op: "gt", value: config.clock.now() },
      ],
      { limit: IN_CHUNK },
    );
    // An account delete leaves the invitations of its solo organizations to the sweep (ruling
    // 78 of plan 12d). So an invitation counts only while its organization stays: one read.
    if (
      pending.length > 0 &&
      (
        await findManyIn(
          tx,
          "organization",
          "id",
          pending.map((x) => x.organizationId),
        )
      ).length > 0
    )
      return;
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

/**
 * The `email` identity means "this address signs in by magic link". It
 * exists once the address is proved. A claim flow passes `verified`: after
 * a claim that `keep` made final, a parallel proof can write the row first
 * (`createIdentity`).
 */
export async function ensureEmailIdentity(
  tx: StorageAdapter,
  userId: string,
  email: string,
  now: Date,
  verified?: VerifySteps,
): Promise<void> {
  const found = await tx.findOne("identity", [
    { field: "provider", op: "eq", value: "email" },
    { field: "subject", op: "eq", value: email },
  ]);
  if (!found) {
    await createIdentity(
      tx,
      {
        id: newId(now),
        userId,
        provider: "email",
        subject: email,
        linkedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      verified,
    );
  }
}

/**
 * Creates the identity `row`. After a claim that `keep` made final, the flow
 * runs no retry (plan 12o). So there a unique-key error counts as present
 * when one read finds a row of the same user, provider, and subject. A
 * parallel proof wrote that row first, and the flow goes on to its session.
 * Any other error passes on. Before a kept claim, the error passes on, and the
 * flow's unique-key retry reads the winner's row. Only D1, SQLite, and
 * memory keep a claim. So the read never runs in a Postgres transaction
 * that the error aborted.
 */
export async function createIdentity(
  tx: StorageAdapter,
  row: IdentityRow,
  verified?: VerifySteps,
): Promise<void> {
  try {
    await tx.create("identity", row);
  } catch (err) {
    if (!verified?.kept() || !(err instanceof StorageError) || err.code !== "unique_violation")
      throw err;
    const present = await tx.findOne("identity", [
      { field: "userId", op: "eq", value: row.userId },
      { field: "provider", op: "eq", value: row.provider },
      { field: "subject", op: "eq", value: row.subject },
    ]);
    if (!present) throw err;
  }
}
