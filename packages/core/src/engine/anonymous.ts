import { checkCaptcha } from "../captcha.js";
import type { ResolvedConfig } from "../config.js";
import type { RouteKey } from "../http/route-list.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow } from "../schema.js";
import type { Meter } from "../storage/meter.js";
import type { StorageAdapter, Where } from "../storage/port.js";
import { createSteps } from "./create-steps.js";
import {
  type AnonymousLinkEvent,
  hookGuard,
  runAfter,
  runAfterChecked,
  runBefore,
  type SessionVia,
} from "./hooks.js";
import {
  endedList,
  endSessions,
  liveSessionWhere,
  peekRequestSession,
  peekRequestUser,
  prepareSession,
  type ResolvedSession,
  sessionIsLive,
  sessionOpened,
  sessionsEnded,
  writeSession,
} from "./sessions.js";
import { holdUsers } from "./user-hold.js";
import { draftUserRow } from "./users.js";

/**
 * Anonymous sign-in (plan 12i Task 6, spec 32 item 8). An anonymous user
 * has no address, no phone, no passkey, and no password: zero ways in. Its
 * session is the only key to its data. A sign-in of Task 7 replaces it.
 */

/**
 * The routes that answer 403 `anonymous_refused` to an anonymous session,
 * before the handler. An anonymous user has zero ways in (12a). Each entry
 * is a privilege or a credential change that needs one. A change of address
 * or phone on an anonymous user would keep its id. That is the in-place
 * upgrade that owner decision 2 refuses (plan 12i). The account delete has
 * its own route for an anonymous user, `POST /anonymous/delete`. Each entry
 * declares the code in `ROUTES`, and anonymous.test.ts holds both ways.
 *
 * Not listed: each sign-in route (the phone code, every social preset, and
 * the passkey-first sign-up too), because a sign-in leaves the anonymous
 * user and changes nothing of it. The sign-up makes a new user and replaces
 * the anonymous user through the upgrade (plan 12i Task 8). Also not
 * listed: the remove of a passkey or a phone, because an anonymous user can
 * hold neither, so the route finds nothing to remove.
 * Also not listed: the three multi-session routes. They change no account
 * and grant no privilege. A switch leaves the anonymous user as a sign-in
 * does, and its token never enters the bag. The sign-out of one ends a
 * session of the browser, as `POST /sign-out` does.
 * Also not listed: the operator routes, the update and the delete of plan
 * 12f2 too. The operator guard needs the platform role, a second factor,
 * and a verified address, so it refuses an anonymous session with
 * `operator_required`. anonymous.test.ts holds the two routes of 12f2.
 */
export const ANONYMOUS_REFUSED: ReadonlySet<RouteKey> = new Set<RouteKey>([
  // The re-authentication: an anonymous user has no proof to give.
  "POST /reauth",
  "POST /reauth/passkey/options",
  "POST /reauth/email",
  // The profile, the address, and the username: each keeps the id (owner decision 2).
  "POST /user/update",
  "POST /user/change-email",
  "POST /user/change-email/verify",
  "POST /user/username",
  // The account delete of a user with a way in; the anonymous user has its own.
  "POST /user/delete",
  "POST /user/delete/confirm",
  // The ways in: a social link, a passkey, a password, and a phone.
  "POST /social/:provider/link",
  "POST /passkey/register/options",
  "POST /passkey/register/verify",
  "POST /password/change",
  "POST /phone/add",
  "POST /phone/add/verify",
  // The second factor: a factor needs a first way in.
  "POST /totp/setup",
  "POST /totp/enable",
  "POST /second-factor/passkey/options",
  "POST /second-factor/passkey/enable",
  "POST /second-factor/email/enable",
  // The privileges: an organization, an API token, and an OAuth grant.
  "POST /organizations/create",
  "POST /organizations/invitations/accept",
  "POST /tokens",
  "POST /oauth/authorize",
  "POST /oauth/device",
]);

/**
 * Each model with a `userId` field (`USER_CHILD_MODELS`), and what the
 * anonymous delete does with it. `delete` names the rows that it deletes.
 * Each other entry states the guard that keeps the rows from an anonymous
 * user, in the route list and in the engine. anonymous.test.ts holds the
 * keys to `USER_CHILD_MODELS`, so a new model fails until it gets an entry.
 */
export const ANONYMOUS_ROWS: Readonly<Record<string, string>> = {
  session: "delete",
  identity:
    "The social link is refused, and linkSocial needs a verified address; a sign-in finds or makes another user.",
  passkey: "The passkey register is refused, and provedAccount refuses it in process.",
  member:
    "The organization create and the invitation accept are refused; each needs a verified address in process, as a member add does.",
  password:
    "The password change is refused, and provedAccount refuses a first password in process.",
  apiToken: "The token create is refused, and handleProved refuses it in process.",
  totp: "The TOTP setup is refused, and provedAccount refuses it in process.",
  trustedDevice: "A trusted device comes from a challenge, and an anonymous user has no factor.",
  oauthConsent: "The OAuth authorize is refused, and provedAccount refuses a grant in process.",
  oauthToken: "The OAuth authorize is refused, and provedAccount refuses a grant in process.",
  oauthSubject: "The OAuth authorize is refused, and provedAccount refuses a grant in process.",
  oauthSessionClient:
    "The OAuth authorize is refused, and provedAccount refuses a grant in process.",
  oauthDevice: "The device approve is refused, and provedAccount refuses it in process.",
  oauthLogout: "An outbox row comes from a client link, and an anonymous session has none.",
  secondFactor: "Each method enable is refused, and provedAccount refuses it in process.",
  teamMember: "A team member is a member of the organization first.",
  scimUser: "A SCIM user links by address, and an anonymous user has none.",
};

// Per hour, per IP (spec 32 item 8): each sign-in writes a user row.
export const ANONYMOUS_PER_IP = { seconds: 3600, max: 10 };
// Per hour, per user, as the account delete (plan 12a): a delete succeeds once.
export const ANONYMOUS_DELETE_PER_USER = { seconds: 3600, max: 5 };
/** The window of the daily cap (ruling 25 M4). The max is `anonymous.dailyCap`. */
const CAP_WINDOW_SECONDS = 86_400;
/** The subject of the daily cap: one count for the deployment. */
const CAP_SUBJECT = "deployment";

/**
 * The users of one page of the anonymous delete. A query with 50 ids stays
 * under the 100 bound parameters of D1. The source is the D1 limits page,
 * updated 21 April 2026, read 2026-10-24.
 */
export const ANONYMOUS_PAGE = 50;
/** The top of `anonymous.sweepBatch`: the most anonymous users of one sweep (spec 32 item 8). */
export const ANONYMOUS_SWEEP_MAX = 100;
/**
 * The calls of one page of the sweep step: the read of the users, the read
 * of their sessions, and in one transaction the read of the users again,
 * the user delete, and the session delete. The lock reads of Postgres do
 * not count: the budget is the D1 budget, and D1 has no lock read.
 */
export const ANONYMOUS_PAGE_CALLS = 5;

export interface AnonymousSignIn {
  /** The caller's live session and its token, or null. */
  current: { session: ResolvedSession; token: string } | null;
  ip: string | null;
  userAgent: string | null;
  /** The captcha token (plan 12b). Undefined in process: no check. Null or "": the request had none. */
  captchaToken?: string | null | undefined;
}

export interface AnonymousSession {
  token: string;
  user: UserRow;
  session: SessionRow;
}

/**
 * `POST /anonymous/sign-in` (spec 32 item 8). A live anonymous session
 * answers itself and writes nothing. A live session of another kind answers
 * `conflict`. Else the per-IP limit, the captcha, and the daily cap of the
 * deployment run. A failed captcha does not count against the cap. Then one
 * transaction runs the sign-up rule and `user.beforeCreate` on the draft
 * (`createSteps`), and the session hook. Then it writes the user row and the
 * session row. There is no gate: an anonymous user can hold no factor
 * (Review Focus 1).
 */
export async function signInAnonymous(
  config: ResolvedConfig,
  input: AnonymousSignIn,
): Promise<Result<AnonymousSession>> {
  const { anonymous } = config;
  if (!anonymous) return fail("not_found");
  if (input.current) {
    const { session, token } = input.current;
    if (!session.user.isAnonymous) return fail("conflict");
    return ok({ token, user: session.user, session: session.session });
  }
  if (!(await limit(config, "anonymous:ip", ipKey(input.ip), ANONYMOUS_PER_IP)))
    return fail("rate_limited");
  const captcha = await checkCaptcha(config, "anonymous-sign-in", input.captchaToken, input.ip);
  if (captcha) return captcha;
  // The sweep deletes at most `sweepBatch` users a run. The cap bounds the users that wait for it.
  const cap = { seconds: CAP_WINDOW_SECONDS, max: anonymous.dailyCap };
  if (!(await limit(config, "anonymous:all-day", CAP_SUBJECT, cap))) return fail("rate_limited");
  const now = config.clock.now();
  const made = createSteps(config, "anonymous", { signUpRule: true });
  const opened = await hookGuard(async () =>
    ok(
      await config.storage.transaction(async (tx) => {
        made.begin();
        const user = await made.user(
          tx,
          draftUserRow({ email: null, emailVerified: false, name: null, isAnonymous: true }, now),
        );
        // Every hook runs before the first write: the D1 undo (`BeforeResolveWrite` in users.ts).
        const prepared = await prepareSession(
          config,
          { user, ip: input.ip, userAgent: input.userAgent, via: "anonymous" },
          tx,
        );
        await tx.create("user", user);
        return { user, ...(await writeSession(config, prepared, tx)) };
      }),
    ),
  );
  if (!opened.ok) return opened;
  const { user, token, session } = opened.value;
  await made.after(user);
  await sessionOpened(config, session, user, "anonymous");
  return ok({ token, user, session });
}

export interface AnonymousDelete {
  session: ResolvedSession;
}

/**
 * `POST /anonymous/delete` (spec 32 item 8). Only an anonymous session may
 * call it: another session answers `anonymous_refused`. It needs no fresh
 * session: the session is the only key of an anonymous user. It deletes
 * through `deleteAnonymousUsers`, with `user.beforeDelete` in the
 * transaction and `user.afterDelete` after the commit.
 */
export async function deleteAnonymous(
  config: ResolvedConfig,
  input: AnonymousDelete,
): Promise<Result<{ ok: true }>> {
  if (!config.anonymous) return fail("not_found");
  const { user, session } = input.session;
  if (!user.isAnonymous) return fail("anonymous_refused");
  if (!(await limit(config, "anonymous-delete:user", user.id, ANONYMOUS_DELETE_PER_USER)))
    return fail("rate_limited");
  const ended = endedList(config);
  const done = await hookGuard(async () =>
    ok(
      await deleteAnonymousRows(config, [user.id], config.clock.now(), {
        proof: session.id,
        ended: ended ?? null,
      }),
    ),
  );
  if (!done.ok) return done;
  if (done.value.users.length === 0) return fail("unauthorized");
  await anonymousDeleted(config, done.value, ended);
  return ok({ ok: true });
}

/** What one call of `deleteAnonymousUsers` or of the route's delete deleted. */
export interface AnonymousDeleted {
  users: UserRow[];
  sessions: number;
}

/**
 * The one delete of anonymous users with no act of the user (ruling 25
 * L4): the sweep, and the sign-in of Task 7 that replaces an anonymous
 * user. The caller ends the sessions that it needs ended first. After the
 * commit, `user.afterDelete` runs once per deleted user. No
 * `user.beforeDelete` runs: the user did not ask, and a refusal would hold
 * the rows. A user that is no longer anonymous stays.
 */
export async function deleteAnonymousUsers(
  config: ResolvedConfig,
  ids: readonly string[],
): Promise<AnonymousDeleted> {
  const deleted = await deleteAnonymousRows(config, ids, config.clock.now());
  await anonymousDeleted(config, deleted, undefined);
  return deleted;
}

/**
 * The rows of the anonymous delete (plan 12i Task 6, the lane ruling). The
 * account delete of plan 12a costs about 40 queries for one user. So it
 * fits neither a page of the sweep nor its share of the D1 budget. This
 * delete costs 3 calls for a page of up to `ANONYMOUS_PAGE` users, plus
 * the session reads of a route call. It deletes the rows of
 * `ANONYMOUS_ROWS`: the user rows and their sessions.
 *
 * It runs in one transaction. First the hold of the user rows (a lock on
 * Postgres), and the read of the rows that are still anonymous. Then the
 * user delete, and then the session delete, in the order of user-hold.ts. A
 * parallel delete of the same user then finds no row. So each
 * `user.afterDelete` fires once.
 *
 * With `route`, the call is the route's, for one user. The session of the
 * proof must still be live, and `user.beforeDelete` runs before the first
 * write. `endSessions` ends the sessions with the outbox and the `afterEnd`
 * list. Without `route`, the call is that of `deleteAnonymousUsers`. No
 * user of it has a live session, so no client link and no hook of a
 * session end applies.
 */
async function deleteAnonymousRows(
  config: ResolvedConfig,
  ids: readonly string[],
  now: Date,
  route?: { proof: string; ended: SessionRow[] | null },
): Promise<AnonymousDeleted> {
  if (ids.length === 0 || ids.length > ANONYMOUS_PAGE)
    throw new RangeError(`authtempo: an anonymous delete takes 1 to ${ANONYMOUS_PAGE} users`);
  const byIds: Where<"user">[] = [
    { field: "id", op: "in", value: [...ids].sort() },
    { field: "isAnonymous", op: "eq", value: true },
  ];
  return config.storage.transaction(async (tx) => {
    if (route?.ended) route.ended.length = 0;
    // The user hold of user-hold.ts: the lock of the rows by id on Postgres.
    await holdUsers(tx, ids);
    const users = await tx.findMany("user", byIds, { sort: { field: "id", dir: "asc" } });
    if (users.length === 0) return { users, sessions: 0 };
    if (route) {
      const proof = await tx.findOne("session", [{ field: "id", op: "eq", value: route.proof }]);
      if (!proof || !sessionIsLive(config, proof, now)) return { users: [], sessions: 0 };
      for (const user of users)
        await runBefore(config.observe, "user.beforeDelete", config.hooks.user.beforeDelete, {
          user,
          organizations: [],
        });
    }
    const userIds = users.map((u) => u.id);
    await tx.delete("user", [{ field: "id", op: "in", value: userIds }]);
    const sessions = route
      ? await endSessionsOf(tx, userIds, route.ended, now)
      : await deleteSessionsOf(tx, userIds);
    return { users, sessions };
  });
}

/** The route's end of the sessions of one user, with the outbox and the `afterEnd` list. */
function endSessionsOf(
  tx: StorageAdapter,
  userIds: string[],
  ended: SessionRow[] | null,
  now: Date,
): Promise<number> {
  const [userId] = userIds;
  if (userId === undefined || userIds.length !== 1)
    throw new RangeError("authtempo: the route deletes one anonymous user");
  return endSessions(tx, [{ field: "userId", op: "eq", value: userId }], ended, now, null);
}

/**
 * The sweep's delete of the sessions of a page: none is live, so the rows
 * go in one statement, after the lock of Postgres. A client link of such a
 * session becomes an outbox row at the link step of the sweep.
 */
async function deleteSessionsOf(tx: StorageAdapter, userIds: string[]): Promise<number> {
  const where: Where<"session">[] = [{ field: "userId", op: "in", value: userIds }];
  await tx.lockInOrder?.("session", where);
  return tx.delete("session", where);
}

/** After the commit: the end of the sessions, then `user.afterDelete` once per user. */
async function anonymousDeleted(
  config: ResolvedConfig,
  deleted: AnonymousDeleted,
  ended: SessionRow[] | undefined,
): Promise<void> {
  await sessionsEnded(config, ended, "account_deleted", null, deleted.sessions);
  for (const user of deleted.users)
    await runAfter(
      config.observe,
      "user.afterDelete",
      config.hooks.user.afterDelete,
      { user },
      user.id,
    );
}

/**
 * The anonymous step of the sweep (spec 32 item 8): anonymous users made
 * more than `ttlDays` ago with no live session, at most
 * `anonymous.sweepBatch` per run, oldest first by `createdAt`. The index
 * on `(isAnonymous, createdAt)` of schema 15 serves the read (ruling 25
 * H1). Each page costs `ANONYMOUS_PAGE_CALLS` calls, and a page that does
 * not fit inside `cap` waits for the next sweep. A user with a live session
 * stays, and the next page of the run starts after it. The delete is
 * `deleteAnonymousUsers`.
 */
export async function sweepAnonymous(
  config: ResolvedConfig,
  now: Date,
  meter: Meter,
  cap: number,
): Promise<number> {
  const { anonymous } = config;
  if (!anonymous) return 0;
  const before = new Date(now.getTime() - anonymous.ttlDays * 24 * 60 * 60 * 1000);
  const most = Math.min(anonymous.sweepBatch, ANONYMOUS_SWEEP_MAX);
  let n = 0;
  // The createdAt of the last user of the page before. An imported id has no time order.
  let after: Date | null = null;
  // The users with a live session whose createdAt is `after`. The next read gets them again
  // first, and leaves them out, so a kept user never holds the next page of the run.
  let held = new Set<string>();
  while (n < most && meter.used + ANONYMOUS_PAGE_CALLS <= cap) {
    const take = Math.min(ANONYMOUS_PAGE, most - n);
    const where: Where<"user">[] = [
      { field: "isAnonymous", op: "eq", value: true },
      { field: "createdAt", op: "lt", value: before },
    ];
    if (after !== null) where.push({ field: "createdAt", op: "gte", value: after });
    // Both fields hold no null, so the SQL has no `IS NULL` term, and the index gives the
    // order: a page reads about `take` rows, not every old anonymous user (ruling 27).
    const read = await config.storage.findMany("user", where, {
      sort: [
        { field: "createdAt", dir: "asc", notNull: true },
        { field: "id", dir: "asc", notNull: true },
      ],
      limit: take + held.size,
    });
    meter.step(1);
    const page = read.filter((u) => !held.has(u.id)).slice(0, take);
    if (page.length === 0) break;
    const sessions = await config.storage.findMany("session", [
      { field: "userId", op: "in", value: page.map((u) => u.id) },
    ]);
    meter.step(1);
    const live = new Set(
      sessions.filter((s) => sessionIsLive(config, s, now)).map((s) => s.userId),
    );
    const going = page.filter((u) => !live.has(u.id)).map((u) => u.id);
    if (going.length > 0) {
      const deleted = await deleteAnonymousUsers(config, going);
      meter.step(ANONYMOUS_PAGE_CALLS - 2);
      n += deleted.users.length;
    }
    const last = page.at(-1);
    if (read.length < take + held.size || !last) break;
    const t = last.createdAt.getTime();
    if (after?.getTime() !== t) held = new Set();
    for (const u of page) if (live.has(u.id) && u.createdAt.getTime() === t) held.add(u.id);
    after = last.createdAt;
  }
  return n;
}

/**
 * The live anonymous session of a request, and its user (plan 12i Task 7).
 * A pathway reads it at its start and at its completion. An impersonation
 * session is not the person's own, so it never counts.
 */
export interface AnonymousCaller {
  user: UserRow;
  session: SessionRow;
}

/**
 * The live anonymous session of `request`, or null. It reads with no write
 * (`peekRequestSession`), so it moves no expiry, and the handler's later
 * session read takes the same row. With `anonymous` off it reads nothing: a
 * deployment that turned it off pays no query on each sign-in.
 */
export async function anonymousCaller(
  config: ResolvedConfig,
  request: Request,
): Promise<AnonymousCaller | null> {
  if (!config.anonymous) return null;
  const session = await peekRequestSession(config, request);
  if (session === null || session.actorId !== null) return null;
  const user = await peekRequestUser(config, request);
  return user?.isAnonymous && user.id === session.userId ? { user, session } : null;
}

/**
 * How a pathway completes (deviation 2 of plan 12i). `"mailed"`: the proof
 * went by mail or SMS, so a stranger can request it for another person. It
 * links only when the completing request carries the same anonymous
 * session as its start. `"bound"`: the completion is tied to the browser
 * of the start, by the binding cookie of a social flow or by the request
 * itself. It links the anonymous user that its row names, or with none,
 * the anonymous session of the request.
 */
export type UpgradeKind = "mailed" | "bound";

/** What a challenge row keeps for the upgrade at its verify (plan 12i Task 7). */
export interface CarriedUpgrade {
  anonymousUserId: string;
  kind: UpgradeKind;
}

/** The steps of an upgrade, as `upgradeSteps` answers them. */
export interface UpgradeSteps {
  /** The anonymous user that a challenge of this sign-in carries to its verify, or null. */
  carried(): CarriedUpgrade | null;
  /**
   * Inside the sign-in transaction, after the user is known, before the
   * session hook: the reads, then `beforeLink`. It writes and locks
   * nothing, and the flow calls it before the session hook holds the user
   * row. So no lock is held while the app's hook runs. A refusal throws
   * `HookStop`, and no session opens.
   */
  before(
    tx: StorageAdapter,
    user: UserRow,
    proof: "verified" | "unverified",
    via: SessionVia,
  ): Promise<void>;
  /**
   * Inside the same transaction, right before the session write: the claim
   * of the anonymous sessions. It comes after the user writes of the flow,
   * so the session rows lock after the user row (the order of
   * user-hold.ts). A sign-in that loses the claim to a parallel upgrade
   * opens its session and links nothing.
   */
  claim(tx: StorageAdapter): Promise<void>;
  /** After the commit: `afterLink`, then the end of the anonymous session, then the delete. */
  after(): Promise<void>;
}

/**
 * The proof of a sign-in for the anonymous upgrade (deviation 3 of plan
 * 12i). A user with an address that no proof verified is a claim: the real
 * owner of the address can claim it later. Every other user is
 * `"verified"`: the address is proved, or there is no address to claim.
 */
export function upgradeProof(user: UserRow): "verified" | "unverified" {
  return user.email !== null && !user.emailVerified ? "unverified" : "verified";
}

/**
 * The upgrade of a sign-in, always by replace (plan 12i Task 7, spec 32
 * item 9, owner decision 2). `anonymous` is the anonymous session of the
 * completing request. `recordedId` is the anonymous user that the
 * pathway's row recorded at its start. With no anonymous user to link, the
 * steps do nothing.
 *
 * The claim is the race guard. Inside the sign-in transaction, one
 * conditional update sets `freshAt` to null on the live anonymous sessions
 * that still hold one. A session with a null `freshAt` is never fresh, and
 * an anonymous session needs no fresh rule. The first upgrade takes the
 * sessions; a second one, parallel or later, matches no row and links
 * nothing. So `afterLink` runs for one sign-in only, and the anonymous data
 * goes to one account. A failure of the transaction undoes the claim.
 */
export function upgradeSteps(
  config: ResolvedConfig,
  anonymous: AnonymousCaller | null,
  recordedId: string | null,
  kind: UpgradeKind,
): UpgradeSteps {
  const callerId = anonymous?.user.isAnonymous ? anonymous.user.id : null;
  // With `anonymous` off, nothing links: not even a row that recorded an
  // anonymous user before the deployment turned it off (choice 7).
  const target = !config.anonymous
    ? null
    : kind === "mailed"
      ? recordedId !== null && callerId === recordedId
        ? recordedId
        : null
      : (recordedId ?? callerId);
  let linked: AnonymousLinkEvent | null = null;
  // The event and the sessions that `before` read, for `claim`.
  let pending: { event: AnonymousLinkEvent; sessions: SessionRow[] } | null = null;
  return {
    carried: () => (target === null ? null : { anonymousUserId: target, kind }),
    async before(tx, user, proof, via) {
      // A retry of the transaction runs this again; the rows of the attempt that rolled back are gone.
      linked = null;
      pending = null;
      if (target === null || target === user.id) return;
      const anonymousUser = await tx.findOne("user", [
        { field: "id", op: "eq", value: target },
        { field: "isAnonymous", op: "eq", value: true },
      ]);
      if (!anonymousUser) return;
      const now = config.clock.now();
      // The person's own live sessions of the anonymous user. An impersonation session is not theirs.
      const where: Where<"session">[] = [
        ...liveSessionWhere(config, target, now),
        { field: "actorId", op: "eq", value: null },
        { field: "freshAt", op: "ne", value: null },
      ];
      const sessions = await tx.findMany("session", where, { sort: { field: "id", dir: "asc" } });
      if (sessions.length === 0) return;
      const event: AnonymousLinkEvent = { anonymousUser, user, proof, via };
      await runBefore(
        config.observe,
        "anonymous.beforeLink",
        config.hooks.anonymous.beforeLink,
        event,
      );
      pending = { event, sessions };
    },
    async claim(tx) {
      linked = null;
      const read = pending;
      if (!read) return;
      const where: Where<"session">[] = [
        { field: "id", op: "in", value: read.sessions.map((r) => r.id) },
        { field: "freshAt", op: "ne", value: null },
      ];
      await tx.lockInOrder?.("session", where);
      // Zero rows: a parallel upgrade claimed the sessions first. It links, and this sign-in does not.
      if ((await tx.update("session", where, { freshAt: null })) > 0) linked = read.event;
    },
    async after() {
      const event = linked;
      linked = null;
      if (!event) return;
      const { anonymousUser } = event;
      // A throw keeps the anonymous user. The claim is spent, so the app acts on the line.
      const done = await runAfterChecked(
        config.observe,
        "anonymous.afterLink",
        config.hooks.anonymous.afterLink,
        event,
        anonymousUser.id,
      );
      if (!done) return;
      // The sign-in is committed, so a throw here must not fail its answer. A
      // store error, or query 51 on D1 Free, writes one line and keeps the
      // anonymous user. Its session is claimed, so the sweep removes it later.
      try {
        const ended = endedList(config);
        const now = config.clock.now();
        const count = await config.storage.transaction(async (tx) => {
          if (ended) ended.length = 0;
          return endSessions(
            tx,
            [{ field: "userId", op: "eq", value: anonymousUser.id }],
            ended ?? null,
            now,
            null,
          );
        });
        await sessionsEnded(config, ended, "anonymous_upgrade", null, count);
        // After the session end: the delete takes users with no session, so it runs as the sweep does.
        await deleteAnonymousUsers(config, [anonymousUser.id]);
      } catch (e) {
        config.observe.emit({
          name: "anonymous.cleanup_failed",
          rowId: anonymousUser.id,
          errorName: e,
        });
      }
    },
  };
}

/** The anonymous user that a pathway row recorded at its start, or null (plan 12i Task 7). */
export function recordedAnonymous(data: unknown): string | null {
  const id = (data as { anonymousUserId?: unknown } | null)?.anonymousUserId;
  return typeof id === "string" ? id : null;
}

/** The `data` field of a pathway row that records `caller`: empty for no anonymous caller. */
export function anonymousData(caller: AnonymousCaller | null | undefined): {
  anonymousUserId?: string;
} {
  return caller ? { anonymousUserId: caller.user.id } : {};
}
