import type { ResolvedConfig } from "../config.js";
import { readCookie, sessionCookie } from "../http/cookies.js";
import type { Observer } from "../observe/observer.js";
import {
  readBearer,
  readSessionToken,
  SESSION_TOKEN_PREFIX,
  sessionCookieToken,
} from "../primitives/credentials.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import type { SessionRow, UserRow } from "../schema.js";
import { IN_CHUNK } from "../storage/batch.js";
import type { StorageAdapter, Where } from "../storage/port.js";
import { hasAddress } from "./address.js";
import {
  type PatchShapeRefusal,
  patchFields,
  runAfter,
  runBefore,
  type SessionDraft,
  type SessionEndReason,
  type SessionPatchRefusal,
  type SessionVia,
  stopWith,
} from "./hooks.js";
import { endSessionById, writeLogouts } from "./oauth-outbox.js";
import {
  type ImpersonationStops,
  impersonationStops,
  operatorActed,
  writeStopRow,
} from "./operator/audit.js";
import { activeBan, bannedFor } from "./operator/ban-rule.js";
import { impersonationLoss, revokedFor } from "./operator/guards.js";
import { holdUser } from "./user-hold.js";

// The credential facts moved to primitives/credentials.ts (plan 11d). They stay exported here, so no importer changes.
export { readBearer, readSessionToken, SESSION_TOKEN_PREFIX, sessionCookieToken };

const DAY_MS = 86_400_000;

/**
 * The expiry of a session at `now`: `ttlDays` from now, and never past
 * `createdAt + absoluteDays` (plan 12b). Create and the sliding refresh use it.
 */
export function sessionExpiry(config: ResolvedConfig, createdAt: Date, now: Date): Date {
  const sliding = now.getTime() + config.session.ttlDays * DAY_MS;
  return new Date(Math.min(sliding, sessionCapMs(config, createdAt)));
}

/**
 * The time in ms at which a session ends whatever its expiresAt:
 * `createdAt + absoluteDays`, or Infinity when `absoluteDays` is off
 * (plan 12b). The one copy of the cap rule.
 */
export function sessionCapMs(config: ResolvedConfig, createdAt: Date): number {
  return config.session.absoluteDays === null
    ? Number.POSITIVE_INFINITY
    : createdAt.getTime() + config.session.absoluteDays * DAY_MS;
}

/**
 * True while `session` is live at `now`: before its expiry and before the
 * cap. `resolveSession` reads it. `liveSessionWhere` is the same rule as a
 * storage condition, for a list (plan 12a review M4).
 */
export function sessionIsLive(
  config: ResolvedConfig,
  session: Pick<SessionRow, "createdAt" | "expiresAt">,
  now: Date,
): boolean {
  const t = now.getTime();
  return session.expiresAt.getTime() > t && sessionCapMs(config, session.createdAt) > t;
}

/**
 * The live sessions of `userId` at `now`, as storage conditions: the where
 * form of `sessionIsLive`. `createdAt + absoluteDays > now` is
 * `createdAt > now - absoluteDays`, so the edge is the same.
 */
export function liveSessionWhere(
  config: ResolvedConfig,
  userId: string,
  now: Date,
): Where<"session">[] {
  const where: Where<"session">[] = [
    { field: "userId", op: "eq", value: userId },
    { field: "expiresAt", op: "gt", value: now },
  ];
  const days = config.session.absoluteDays;
  if (days !== null)
    where.push({ field: "createdAt", op: "gt", value: new Date(now.getTime() - days * DAY_MS) });
  return where;
}

/**
 * Deletes the ended sessions of `userId` at `now`, with no hook: the
 * complement of `liveSessionWhere`, one delete per bound. A row that a
 * sign-in writes now is live, so no delete here can take it. The sweep
 * deletes such rows with no hook too (plan 12a review L3).
 */
export async function deleteEndedSessions(
  tx: StorageAdapter,
  config: ResolvedConfig,
  userId: string,
  now: Date,
): Promise<void> {
  // The row locks of every session of the user first, by id (ruling 36 of plan 12f).
  await tx.lockInOrder?.("session", [{ field: "userId", op: "eq", value: userId }]);
  await tx.delete("session", [
    { field: "userId", op: "eq", value: userId },
    { field: "expiresAt", op: "lte", value: now },
  ]);
  const days = config.session.absoluteDays;
  if (days !== null)
    await tx.delete("session", [
      { field: "userId", op: "eq", value: userId },
      { field: "createdAt", op: "lte", value: new Date(now.getTime() - days * DAY_MS) },
    ]);
}

/** The `Max-Age` of the cookie of a new session: its life, in whole seconds (plan 12b). */
export function sessionMaxAgeSeconds(config: ResolvedConfig): number {
  const days = Math.min(config.session.ttlDays, config.session.absoluteDays ?? Infinity);
  return Math.floor((days * DAY_MS) / 1000);
}
// Built from the prefix, so the pattern and the prefix cannot drift (the prefix has no regex character).
const TOKEN_RE = new RegExp(`^${SESSION_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

/** True when `token` has the form of a session token (plan 12i: the bag of multi-session reads it). */
export function isSessionTokenForm(token: string): boolean {
  return TOKEN_RE.test(token);
}

export interface SessionInput {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * The proof flag of the row (plan 12p, spec 8.9). Core sets it once at the
   * session's creation: `prepareSession` computes it (`provedAtOpen`). Only
   * the confirm of a change of address changes it later, to true on the
   * session it keeps. Required, so the type check names each caller. No hook
   * can set it.
   */
  proved: boolean;
  /** Set only through `openSession`, after the membership check of a hook's patch (plan 9d). */
  activeOrganizationId?: string | null;
  /** The last sign-in, when it is older than the session: a handoff (plan 12e ruling 41). Default now. */
  freshAt?: Date;
  /** Set only through `openSession` for an impersonation (plan 12f). */
  impersonation?: SessionImpersonation;
  /** The latest expiry that the sign-in allows: a SAML `SessionNotOnOrAfter` (plan 12d). */
  notAfter?: Date;
}

/**
 * The marks of an impersonation session (plan 12f, spec 26 item 9): the
 * operator's user id and the fixed expiry. The row gets no fresh time, so
 * every change behind the fresh rule refuses it.
 */
export interface SessionImpersonation {
  actorId: string;
  expiresAt: Date;
}

/** What an engine flow passes to `openSession` (plan 9d). */
export interface SessionOpen {
  user: UserRow;
  ip: string | null;
  userAgent: string | null;
  via: SessionVia;
  /**
   * The time of the sign-in that this session carries on, when no
   * credential was checked now. A handoff takes the browser session's
   * sign-in (plan 12e ruling 41). Default now.
   */
  signedInAt?: Date;
  /** The marks of an impersonation session, with `via: "impersonation"` (plan 12f). */
  impersonation?: SessionImpersonation;
  /** The latest expiry that the sign-in allows: a SAML `SessionNotOnOrAfter` (plan 12d). */
  notAfter?: Date;
  /**
   * The flow checked the address of `user` before the hold of the user row
   * (ruling 78 of plan 12d): the SSO domain rule. The read after the insert
   * answers `conflict` when the row holds another address by then.
   */
  sameAddress?: boolean;
  /**
   * The flag of the session that this one carries on: the browser session
   * of a handoff (plan 12p). It sets `proved` in place of the user's state,
   * so a handoff never gains what its browser session did not have.
   */
  carriedProved?: boolean;
}

/**
 * The `proved` flag of a new session (ruling 20 of plan 12p, spec 8.9). A
 * handoff gives the flag of its browser session. An anonymous user gives
 * false. A user with an address gives its verified flag. Any other user
 * gives true.
 *
 * The flag marks a session made before the proof of its address. A user
 * with no address has nothing to claim, so its sessions start proved. The
 * gates still read its user row: `handleProved` needs a verified handle. An
 * anonymous session stays unproved, because an upgrade can give it an
 * address. The owner's claim must not find it proved then.
 */
export function provedAtOpen(input: SessionOpen): boolean {
  if (input.carriedProved !== undefined) return input.carriedProved;
  if (input.user.isAnonymous) return false;
  return hasAddress(input.user) ? input.user.emailVerified : true;
}

export interface ResolvedSession {
  user: UserRow;
  session: SessionRow;
  /** True when this call moved the expiry forward. A cookie must then be set again, or it expires at its old Max-Age. */
  refreshed: boolean;
  /**
   * Set by a read-only resolve only (plan 12a): true when the sliding
   * refresh is due and this read did not do it. `POST /session/refresh` does it.
   */
  needsRefresh?: boolean;
}

/**
 * The `valueHash` of the `session-cap` row of a session (ruling 38 Q1 of
 * plan 12d): the SHA-256 hex of `session-cap:<sessionId>`.
 */
export function sessionCapHash(sessionId: string): Promise<string> {
  return sha256Hex(`session-cap:${sessionId}`);
}

/**
 * `storage` is the adapter to write through. A sign-in that resolves the
 * user in a transaction passes its `tx`, so the session commits with the
 * claim that deletes a claimant's sessions (plan 7 input).
 * It runs no hook: an engine flow calls openSession (plan 9d).
 */
export async function createSession(
  config: ResolvedConfig,
  input: SessionInput,
  storage: StorageAdapter = config.storage,
): Promise<{ token: string; session: SessionRow }> {
  const now = config.clock.now();
  const token = randomToken(SESSION_TOKEN_PREFIX);
  const expiry = input.impersonation?.expiresAt ?? sessionExpiry(config, now, now);
  const id = newId(now);
  // The cap row goes in the handle of the session, so both commit or neither does.
  if (input.notAfter) {
    await storage.create("verification", {
      id: newId(now),
      purpose: "session-cap",
      identifier: input.userId,
      valueHash: await sessionCapHash(id),
      expiresAt: input.notAfter,
      consumedAt: null,
      data: null,
      createdAt: now,
      updatedAt: now,
      secretVersion: config.keyring.current,
    });
  }
  const session = await storage.create("session", {
    id,
    userId: input.userId,
    tokenHash: await sha256Hex(token),
    // The IdP's cap holds when it is earlier (plan 12d Task 5 Behavior 9).
    expiresAt:
      input.notAfter && input.notAfter.getTime() < expiry.getTime() ? input.notAfter : expiry,
    lastSeenAt: now,
    ip: input.ip,
    userAgent: input.userAgent,
    activeOrganizationId: input.activeOrganizationId ?? null,
    // An impersonation session is never fresh (plan 12f, spec 26 item 9).
    freshAt: input.impersonation ? null : (input.freshAt ?? now),
    actorId: input.impersonation?.actorId ?? null,
    activeTeamId: null,
    // Once, at the insert: only the confirm of a change of address sets it later (plan 12p).
    proved: input.proved,
    createdAt: now,
    updatedAt: now,
  });
  return { token, session };
}

const PATCH_KEYS: ReadonlySet<string> = new Set(["ip", "userAgent", "activeOrganizationId"]);

function nullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

/**
 * One line that says what was wrong, never a value: a value can be an
 * address or an agent string. A key outside the patch keys is named.
 */
function refusePatch(
  observe: Observer,
  what: PatchShapeRefusal | SessionPatchRefusal | { field: string },
): never {
  observe.emit(
    typeof what === "string"
      ? { name: "session.patch_refused", what }
      : { name: "session.patch_refused", what: "field", field: what.field },
  );
  return stopWith("hook_failed");
}

/**
 * The session fields after `session.beforeCreate`'s answer (plan 9d). Only
 * `ip`, `userAgent`, and `activeOrganizationId` may change. A set
 * organization must be one the user is a member of, read on the flow's
 * transaction, as `POST /organizations/active` requires; else `not_found`.
 */
async function patchedInput(
  config: ResolvedConfig,
  storage: StorageAdapter,
  draft: SessionDraft,
  patch: unknown,
  proved: boolean,
): Promise<SessionInput> {
  // `proved` is not a patch key, so a hook that names it is refused below (plan 12p).
  const input: SessionInput = {
    userId: draft.userId,
    ip: draft.ip,
    userAgent: draft.userAgent,
    proved,
  };
  const refuse = (what: PatchShapeRefusal | SessionPatchRefusal | { field: string }) =>
    refusePatch(config.observe, what);
  const fields = patchFields(patch, refuse);
  if (!fields) return input;
  for (const key of Object.keys(fields)) if (!PATCH_KEYS.has(key)) return refuse({ field: key });
  const { ip, userAgent, activeOrganizationId } = fields;
  if (ip !== undefined) {
    if (!nullableString(ip)) return refuse("an ip that is not a string or null");
    input.ip = ip;
  }
  if (userAgent !== undefined) {
    if (!nullableString(userAgent)) return refuse("a userAgent that is not a string or null");
    input.userAgent = userAgent;
  }
  if (activeOrganizationId !== undefined) {
    if (!nullableString(activeOrganizationId))
      return refuse("an activeOrganizationId that is not a string or null");
    if (activeOrganizationId !== null) {
      const member = config.organizations
        ? await storage.findOne("member", [
            { field: "organizationId", op: "eq", value: activeOrganizationId },
            { field: "userId", op: "eq", value: draft.userId },
          ])
        : null;
      if (!member) stopWith("not_found");
    }
    input.activeOrganizationId = activeOrganizationId;
  }
  return input;
}

/** The session fields after `session.beforeCreate` and its patch check, not yet written (plan 9d). */
export interface PreparedSession {
  readonly input: SessionInput;
  /** The address that `writeSession` compares again, with `sameAddress`. */
  readonly address?: string | null;
}

/**
 * The hook step of `openSession` (plan 9d): it runs `session.beforeCreate`
 * and checks the patch on the flow's transaction (`storage`), and writes
 * nothing. A refusal or a bad patch throws `HookStop`, which undoes the
 * flow's transaction; the flow's `hookGuard` answers it. A flow calls it
 * apart from `writeSession` only when the hook must run before its first
 * write: the password sign-up.
 *
 * An active ban stops it with `account_banned` before the hook (plan 12f,
 * spec 26 item 6). Every flow calls it after its credential check, so only
 * a person who proved the credential learns of the ban.
 */
export async function prepareSession(
  config: ResolvedConfig,
  input: SessionOpen,
  storage: StorageAdapter = config.storage,
): Promise<PreparedSession> {
  if (activeBan(input.user, config.clock.now())) stopWith("account_banned");
  const draft: SessionDraft = {
    userId: input.user.id,
    ip: input.ip,
    userAgent: input.userAgent,
    activeOrganizationId: null,
  };
  const patch = await runBefore(
    config.observe,
    "session.beforeCreate",
    config.hooks.session.beforeCreate,
    {
      session: draft,
      user: input.user,
      via: input.via,
    },
  );
  const patched = await patchedInput(config, storage, draft, patch, provedAtOpen(input));
  const signedIn = input.signedInAt ? { ...patched, freshAt: input.signedInAt } : patched;
  const capped = input.notAfter ? { ...signedIn, notAfter: input.notAfter } : signedIn;
  const prepared = {
    input: input.impersonation ? { ...capped, impersonation: input.impersonation } : capped,
    ...(input.sameAddress ? { address: input.user.email } : {}),
  };
  // After the hook: the hold is a write, and a before hook runs before the
  // first write (the D1 undo). Before the flow's other writes: the lock order.
  // Not for an unverified user: a claim can verify that row during the
  // sign-in, and the sign-in must not write it (sessions-claim.test.ts,
  // re-review finding B). The read in `writeSession` still runs.
  if (input.user.emailVerified) await holdUser(config.observe, storage, input.user.id);
  return prepared;
}

/**
 * The write step of `openSession`: the session row of a `prepareSession`
 * answer. The user row is read after the insert (plan 12a Task 11). No row
 * means that an account delete took the user, and the stop undoes the
 * session and every other write of the flow. D1 has no lock. The delete
 * removes the user row before the sessions, and this read follows the
 * insert. So one of the two always sees the other.
 *
 * The same read stops an active ban with `account_banned` (ruling 3 of plan
 * 12f). The ban writes the user row before it deletes the sessions. So a
 * ban that commits after the flow read the user still stops this session.
 */
export async function writeSession(
  config: ResolvedConfig,
  prepared: PreparedSession,
  storage: StorageAdapter = config.storage,
): Promise<{ token: string; session: SessionRow }> {
  const written = await createSession(config, prepared.input, storage);
  const user = await storage.findOne("user", [
    { field: "id", op: "eq", value: prepared.input.userId },
  ]);
  if (!user) stopWith("conflict");
  if (activeBan(user, config.clock.now())) stopWith("account_banned");
  // This read follows the hold, so a change of address since the flow's check shows here.
  if (prepared.address !== undefined && user.email !== prepared.address) stopWith("conflict");
  return written;
}

/**
 * The one way an engine flow opens a session (plan 9d): `prepareSession`,
 * then `writeSession`, on the flow's transaction. The flow calls
 * `sessionOpened` after its commit.
 */
export async function openSession(
  config: ResolvedConfig,
  input: SessionOpen,
  storage: StorageAdapter = config.storage,
): Promise<{ token: string; session: SessionRow }> {
  return writeSession(config, await prepareSession(config, input, storage), storage);
}

/**
 * `session.afterCreate` for a sign-in that committed (plan 9d), and the
 * event `sign_in` with the outcome success (plan 12h Task 5). A social
 * sign-in names its provider.
 */
export async function sessionOpened(
  config: ResolvedConfig,
  session: SessionRow,
  user: UserRow,
  via: SessionVia,
  provider?: string,
  // The app payload of a social sign-in (plan 12i Task 19): the hook event only, never the line.
  stateData?: Record<string, unknown> | null,
): Promise<void> {
  config.observe.emit({
    name: "sign_in",
    method: via,
    ...(provider === undefined ? {} : { provider }),
    outcome: "success",
    userId: user.id,
    sessionId: session.id,
    // For the opt-in hash only: the observer never writes a raw address (spec 31 item 8).
    email: user.email,
  });
  await runAfter(
    config.observe,
    "session.afterCreate",
    config.hooks.session.afterCreate,
    { session, user, via, ...(stateData ? { stateData } : {}) },
    session.id,
  );
}

/**
 * The event `sign_in` of a sign-in that committed a second-factor challenge
 * in place of a session (plan 12h Task 5). `via` is the first factor. No
 * session exists yet, so the event has no `sessionId`.
 */
export function challengeOpened(
  config: ResolvedConfig,
  user: Pick<UserRow, "id" | "email">,
  via: SessionVia,
): void {
  config.observe.emit({
    name: "sign_in",
    method: via,
    outcome: "second_factor_required",
    userId: user.id,
    email: user.email,
  });
}

/**
 * Deletes the sessions that `where` matches, inside the flow's transaction.
 * It answers the count of rows it deleted (plan 12a: the revoke of the other
 * sessions answers it). With a list, an `afterEnd` hook listens (see
 * `endedList`). Then each read row is deleted by id, and goes to `ended` only
 * when its delete count is 1. A sign-out between the read and the delete
 * already fired `afterEnd` for that row. A second event would name a row that
 * this flow did not end (final fix wave M-1). The last delete still matches
 * `where`. So a session that another request adds between the read and the
 * delete goes too, with no hook. With `ended` null, only the last delete
 * runs: one statement for any number of sessions (plan 9h).
 *
 * With `byChunks` (a claim, final review B M of plan 12i), the read rows go
 * by chunks of `IN_CHUNK` ids. Each chunk is one `deleteRows`, not one delete
 * per row. So the count of the claimant's sessions adds no query on D1. Each chunk
 * puts in `ended` the rows that its delete answered (plan 12o). A row that
 * another flow ended after the read is not in the answer. That flow fired
 * its hook, and this flow fires nothing more for it (spec 8.9, plan 9d).
 * Postgres and MySQL lock the rows before the read (`lockInOrder`), so there
 * no other flow ends a read row.
 *
 * The back-channel outbox (plan 12e Task 16): first the user's client links.
 * With none, nothing more runs. With some, each linked session that `where`
 * matches gets one `oauthLogout` row per link, and its links go, in this
 * transaction. A link whose session is gone gets its row too: that session
 * ended, by an expiry or by a race with another end (ruling 49).
 */
export async function endSessions(
  tx: StorageAdapter,
  where: Where<"session">[],
  ended: SessionRow[] | null,
  now: Date,
  stops: ImpersonationStops | null,
  byChunks = false,
): Promise<number> {
  // The outbox reads the user's links; every flow ends the sessions of one user.
  const user = where.find((w) => w.field === "userId" && w.op === "eq")?.value;
  if (typeof user !== "string") throw new Error("authtempo: endSessions needs a userId term");
  // The row locks first, by id. One DELETE locks in the order of its scan.
  // Then endAll waits on this flow while it waits on endAll (ruling 36).
  await tx.lockInOrder?.("session", where);
  // Each read that drives a delete sorts by id, so every flow takes the
  // rows of a table in one order. An unsorted read answers in the order of
  // the index or the heap. On Postgres an update can move a row, and two
  // flows then wait on each other (plan 12f Task 7 review m1).
  const links = await tx.findMany(
    "oauthSessionClient",
    [{ field: "userId", op: "eq", value: user }],
    { sort: { field: "id", dir: "asc" } },
  );
  const ending = new Set<string>();
  for (const id of new Set(links.map((l) => l.sessionId))) {
    const byId: Where<"session"> = { field: "id", op: "eq", value: id };
    if (await tx.findOne("session", [...where, byId])) ending.add(id);
    else if (!(await tx.findOne("session", [byId]))) ending.add(id);
  }
  await writeLogouts(
    tx,
    links.filter((l) => ending.has(l.sessionId)),
    now,
  );
  let n = 0;
  // One read serves the stop rows and the list (ruling 79 of plan 12d): on D1 each read is
  // a query of the 50 of one invocation. With neither, the tool is off and no hook listens.
  const rows =
    stops || ended
      ? await tx.findMany(
          "session",
          ended ? where : [...where, { field: "actorId", op: "ne", value: null }],
          { sort: { field: "id", dir: "asc" } },
        )
      : [];
  // Each impersonation session goes by id first, with its stop row in this
  // transaction (ruling 43 of plan 12f). With `stops` null, the tool is off.
  if (stops)
    for (const row of rows)
      if (
        row.actorId !== null &&
        (await tx.delete("session", [{ field: "id", op: "eq", value: row.id }])) === 1
      ) {
        ended?.push(row);
        n++;
        await writeStopRow(tx, stops, row, now);
      }
  const plain = rows.filter((row) => !(stops && row.actorId !== null));
  if (ended && byChunks)
    for (let i = 0; i < plain.length; i += IN_CHUNK) {
      const chunk = plain.slice(i, i + IN_CHUNK);
      const ids = { field: "id", op: "in", value: chunk.map((row) => row.id) } as const;
      const gone = new Map(
        (await tx.deleteRows("session", [...where, ids])).map((row) => [row.id, row]),
      );
      // The answered rows, in the id order of the read.
      for (const row of chunk) {
        const removed = gone.get(row.id);
        if (removed) ended.push(removed);
      }
      n += gone.size;
    }
  else if (ended)
    for (const row of plain)
      if ((await tx.delete("session", [{ field: "id", op: "eq", value: row.id }])) === 1) {
        ended.push(row);
        n++;
      }
  return n + (await tx.delete("session", where));
}

/**
 * The list a flow collects its ended sessions in, for `session.afterEnd`
 * (plan 9h, index line 179). Undefined when no `afterEnd` hook is set: no
 * code reads the rows then, so `endSessions` deletes them in one statement,
 * and an account with many sessions pays one statement, not one per row.
 */
export function endedList(config: ResolvedConfig): SessionRow[] | undefined {
  return config.hooks.session.afterEnd ? [] : undefined;
}

/**
 * `session.afterEnd` once per row, in order, after the commit that deleted
 * them (plan 9d). No list: no hook listens. Then `operator.afterAction`
 * once per stop row of the flow (ruling 43 of plan 12f), as for the row of
 * an operator act.
 *
 * First the one event `session.end` of the act, with `count`: the rows
 * that the deletes answered (plan 12h Task 5). With no `count`, the count
 * is the length of the list. With neither, the count is not known, and no
 * event goes. A count of 0 ended nothing, so no event goes then either.
 */
export async function sessionsEnded(
  config: ResolvedConfig,
  sessions: readonly SessionRow[] | undefined,
  reason: SessionEndReason,
  stops: ImpersonationStops | null,
  count?: number,
): Promise<void> {
  const n = count ?? sessions?.length ?? 0;
  if (n > 0) config.observe.emit({ name: "session.end", reason, count: n });
  for (const session of sessions ?? [])
    await runAfter(
      config.observe,
      "session.afterEnd",
      config.hooks.session.afterEnd,
      { session, reason },
      session.id,
    );
  // The hook and the event operator.action of each stop row (plan 12h Task 6).
  for (const audit of stops?.rows ?? []) await operatorActed(config, audit);
}

/**
 * How a session read runs. `refresh: false` is a read with no write: it
 * applies the expiry and the absolute cap, but it neither slides the expiry
 * nor deletes an ended row (plan 11d Task 11 review, J1). A server render
 * reads with it, so the sliding refresh stays for the browser's own read of
 * `GET /session`, the one answer that sends the renewed cookie.
 */
export interface SessionReadOptions {
  /** Default true: slide the expiry and delete an ended row, as every route does. */
  refresh?: boolean | undefined;
}

/**
 * How `resolveSession` runs. `"write"` slides the expiry and deletes an
 * ended row. `"read-only"` writes nothing (plan 12a). `readModeOf` decides it.
 * `"no-slide"` deletes an ended row as `"write"` does, but never slides the
 * expiry (ruling 34 of plan 12i). A bag session of multi-session reads with
 * it: the session is idle, so a list must not extend its life.
 */
export type SessionReadMode = "write" | "read-only" | "no-slide";

/**
 * The one place that decides the read mode of a request (plan 12a, plan
 * 11d ruling 8). `refresh: false` reads with no write. With
 * `session.deferRefresh` on, a GET reads with no write too, and
 * `POST /session/refresh` slides the expiry. Every other request writes.
 */
export function readModeOf(
  config: ResolvedConfig,
  request: Pick<Request, "method">,
  options: SessionReadOptions = {},
): SessionReadMode {
  if (options.refresh === false) return "read-only";
  return config.session.deferRefresh && request.method === "GET" ? "read-only" : "write";
}

/**
 * Null for an unknown, malformed, or expired token. An expired row is
 * deleted on the way out. After `slidingRefreshDays` the expiry moves
 * forward by a full ttl. In `"read-only"` mode the call writes nothing: an
 * ended row answers null and stays for the sweep, and a due refresh sets
 * `needsRefresh`. In `"no-slide"` mode the call ends an ended row and
 * never slides. No mode changes `freshAt`. An impersonation session (with
 * `actorId`) is never due: its expiry is fixed at the start (plan 12f).
 *
 * A session from before the end of the user's last ban answers null (plan
 * 12f, `bannedFor`). The ban ended every session in its transaction, so
 * such a row is one that a sign-in wrote in a race with the ban. It stays
 * ended after the unban and after `banUntil` (ruling 28). In `"write"` mode
 * the call deletes it by id; in `"read-only"` mode it writes nothing
 * (ruling 4). A session that a SCIM deactivate left for the sweep answers
 * null in the same way (`revokedFor`, ruling 50 of plan 12d).
 */
export async function resolveSession(
  config: ResolvedConfig,
  token: string,
  mode: SessionReadMode = "write",
  peeked: SessionRow | null = null,
  peekedUser: UserRow | null = null,
): Promise<ResolvedSession | null> {
  const write = mode !== "read-only";
  if (!TOKEN_RE.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const now = config.clock.now();
  // The row that the impersonation step of the router read for this request, else a read.
  const session =
    peeked?.tokenHash === tokenHash
      ? peeked
      : await config.storage.findOne("session", [
          { field: "tokenHash", op: "eq", value: tokenHash },
        ]);
  if (!session) return null;
  // The absolute cap ends a session whose expiresAt is later: a row written
  // before `absoluteDays` was set (plan 12b).
  if (!sessionIsLive(config, session, now)) {
    if (!write) return null;
    // The links of the row go to the outbox before the delete (plan 12e Task 16). The sweep delivers them.
    // An expiry writes no stop row (spec 26 item 9).
    const n = await endSessionById(config.storage, session, now, null);
    // One row: this call ended it. Zero: another call or the sweep did, and the sweep fires no hook.
    if (n === 1) await sessionsEnded(config, [session], "expired", null, n);
    return null;
  }
  // The user that the anonymous step of the router read for this request (plan 12i Task 6), else a read.
  const user =
    peekedUser?.id === session.userId
      ? peekedUser
      : await config.storage.findOne("user", [{ field: "id", op: "eq", value: session.userId }]);
  if (!user) return null;
  if (bannedFor(user, session.createdAt)) {
    if (!write) return null;
    // As for an expired row: the links go to the outbox, and the sweep delivers them.
    const stops = impersonationStops(config, "ban");
    const n = await endSessionById(config.storage, session, now, stops);
    if (n === 1) await sessionsEnded(config, [session], "banned", stops, n);
    return null;
  }
  // A SCIM deactivate left this session for the sweep (ruling 50 of plan 12d).
  if (await revokedFor(config, user, session)) {
    if (!write) return null;
    const stops = impersonationStops(config, "deprovision");
    const n = await endSessionById(config.storage, session, now, stops);
    if (n === 1) await sessionsEnded(config, [session], "revoked", stops, n);
    return null;
  }
  // The door of the operator of an impersonation session (the plan 12f Task 11 fix).
  const lost = await impersonationLoss(config, session);
  if (lost !== null) {
    if (!write) return null;
    const stops = impersonationStops(config, lost);
    const n = await endSessionById(config.storage, session, now, stops);
    if (n === 1) await sessionsEnded(config, [session], "impersonation_end", stops, n);
    return null;
  }
  const sinceSeen = now.getTime() - session.lastSeenAt.getTime();
  const due = session.actorId === null && sinceSeen >= config.session.slidingRefreshDays * DAY_MS;
  if (!write) return { user, session, refreshed: false, needsRefresh: due };
  if (due && mode === "write") {
    const slid = sessionExpiry(config, session.createdAt, now);
    // A SAML cap holds through every refresh (ruling 38 Q1 of plan 12d). The
    // row goes with the cap, and the session ends at the cap too, so a
    // missing row means no cap. Only `sso.saml` writes a cap, so an app with
    // it off sends no read. An app that turns it off ends its SAML sessions
    // first, or they slide again.
    const cap = config.sso?.saml
      ? await config.storage.findOne("verification", [
          { field: "valueHash", op: "eq", value: await sessionCapHash(session.id) },
          { field: "purpose", op: "eq", value: "session-cap" },
        ])
      : null;
    const expiresAt = cap && cap.expiresAt.getTime() < slid.getTime() ? cap.expiresAt : slid;
    await config.storage.update("session", [{ field: "id", op: "eq", value: session.id }], {
      expiresAt,
      lastSeenAt: now,
      updatedAt: now,
    });
    return {
      user,
      session: { ...session, expiresAt, lastSeenAt: now, updatedAt: now },
      refreshed: true,
    };
  }
  return { user, session, refreshed: false };
}

/**
 * The sign-out of one session, with the outbox rows of its client links
 * first (`endSessionById`, plan 12e Task 16). Answers the ended row, or null
 * when this call ended nothing. The caller delivers the user's back-channel
 * logouts after it (`deliverLogouts`).
 */
export async function destroySession(
  config: ResolvedConfig,
  token: string,
): Promise<SessionRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const session = await config.storage.findOne("session", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  if (!session) return null;
  // By id, so the row the after hook names is the row this call deleted.
  // The route refuses an impersonation session; `api.signOut` cannot tell,
  // so its end writes a stop row (ruling 43 of plan 12f).
  const stops = impersonationStops(config, "sign_out");
  const n = await endSessionById(config.storage, session, config.clock.now(), stops);
  if (n !== 1) return null;
  config.observe.emit({
    name: "sign_out",
    outcome: "success",
    userId: session.userId,
    sessionId: session.id,
  });
  await sessionsEnded(config, [session], "sign_out", stops, n);
  return session;
}

/** The live session row of `token`, with no write: no refresh, no delete (plan 12b, the cookie move). */
export async function peekSession(
  config: ResolvedConfig,
  token: string,
): Promise<SessionRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const row = await config.storage.findOne("session", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  if (!row) return null;
  // Live as `resolveSession` reads it: the one rule, `sessionIsLive`.
  return sessionIsLive(config, row, config.clock.now()) ? row : null;
}

/**
 * The live session row that the impersonation step of the router read for a
 * request (ruling 78 of plan 12d). The first session read of the handler
 * takes it in place of a second read of the same row. On D1 each read is a
 * query of the 50 of one invocation. The map holds no row after the request.
 */
const peekedRows = new WeakMap<Request, SessionRow>();
/** The user row of the peeked session, read by the anonymous step of the router (plan 12i Task 6). */
const peekedUsers = new WeakMap<Request, UserRow>();

/**
 * `peekSession` for the token of `request`, kept for the handler's session
 * read. A second call for the request answers the kept row with no read.
 */
export async function peekRequestSession(
  config: ResolvedConfig,
  request: Request,
): Promise<SessionRow | null> {
  const kept = peekedRows.get(request);
  if (kept) return kept;
  const token = readSessionToken(config, request);
  if (token === null) return null;
  const row = await peekSession(config, token);
  if (row) peekedRows.set(request, row);
  return row;
}

/**
 * The user of the live session of `request`, kept for the handler's session
 * read (plan 12i Task 6). The anonymous step of the router reads it, and
 * `resolveSession` takes it in place of a second read of the same row. So a
 * refused route pays no query more on D1. It writes nothing.
 */
export async function peekRequestUser(
  config: ResolvedConfig,
  request: Request,
): Promise<UserRow | null> {
  const row = await peekRequestSession(config, request);
  if (row === null) return null;
  const kept = peekedUsers.get(request);
  if (kept?.id === row.userId) return kept;
  const user = await config.storage.findOne("user", [{ field: "id", op: "eq", value: row.userId }]);
  if (user) peekedUsers.set(request, user);
  return user;
}

/**
 * The user of the session row that the token of a request names (decision
 * 17 and ruling 49 of plan 12n). The router reads it into the `request`
 * event. The map holds no id after the request.
 */
const resolvedUsers = new WeakMap<Request, string>();

/**
 * Marks `request` with the user of the session row that its token names
 * (rulings 37 and 49 of plan 12n). A step reads the row in full or by a peek.
 * A handler's session read, the two refusal steps of the router, the
 * sign-out, and the link callback call it. `anonymousCaller` calls it when it
 * finds an anonymous caller. A peek checks the expiry of the row only, so a
 * refusal names the account of the token, a banned one too. The move of an
 * old cookie peeks its row and sets no mark.
 */
export function markRequestUser(request: Request, userId: string): void {
  resolvedUsers.set(request, userId);
}

/** The user id that a step marked for `request`, or undefined when no step marked one. */
export function resolvedUserOf(request: Request): string | undefined {
  return resolvedUsers.get(request);
}

/** The caller's session from the cookie or the bearer header, or null. */
export async function sessionFromRequest(
  config: ResolvedConfig,
  request: Request,
  options: SessionReadOptions = {},
): Promise<ResolvedSession | null> {
  const token = readSessionToken(config, request);
  // The row of the router serves one read: a later read of the request reads again.
  const peeked = peekedRows.get(request) ?? null;
  const peekedUser = peekedUsers.get(request) ?? null;
  peekedRows.delete(request);
  peekedUsers.delete(request);
  if (!token) return null;
  const resolved = await resolveSession(
    config,
    token,
    readModeOf(config, request, options),
    peeked,
    peekedUser,
  );
  if (resolved) markRequestUser(request, resolved.user.id);
  return resolved;
}

/**
 * The Set-Cookie value that renews the session cookie after a sliding
 * refresh, or null. Null when nothing was refreshed, and null when the
 * request carries no session cookie, so a bearer client never gets a cookie.
 * The cookie wins in `readSessionToken`, so a present cookie is the
 * credential that resolved.
 */
export function renewedSessionCookie(
  config: ResolvedConfig,
  request: Request,
  resolved: ResolvedSession,
): string | null {
  if (!resolved.refreshed) return null;
  const token = readCookie(request, config.cookieName);
  if (!token) return null;
  const msLeft = resolved.session.expiresAt.getTime() - config.clock.now().getTime();
  return sessionCookie(
    config.cookieName,
    token,
    Math.max(0, Math.floor(msLeft / 1000)),
    config.cookie.sameSite,
  );
}

/** The public shape of a user. Never an internal field. */
export function publicUser(user: UserRow): {
  id: string;
  /** Null for a user with no address (plan 12i). */
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
} {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
    image: user.image,
  };
}

/** The public shape of a user (plan 12a: the profile and the change of address answer it). */
export type PublicUser = ReturnType<typeof publicUser>;

/**
 * The public shape of a session. Never the hash, never internal ids a client
 * does not need. `actorId` is the operator's user id for an impersonation
 * session, else null (plan 12f): the page of the app shows the mark.
 */
export function publicSession(resolved: ResolvedSession): {
  user: ReturnType<typeof publicUser>;
  session: {
    id: string;
    expiresAt: string;
    activeOrganizationId: string | null;
    actorId: string | null;
    activeTeamId: string | null;
  };
} {
  const { user, session } = resolved;
  return {
    user: publicUser(user),
    session: {
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
      activeOrganizationId: session.activeOrganizationId,
      actorId: session.actorId,
      // A team of the active organization (plan 12k). Null with teams off.
      activeTeamId: session.activeTeamId,
    },
  };
}

/**
 * The JSON shape of a session answer: `GET /session`, the verify routes, and
 * the redeem. `needsRefresh` is in the answer of `GET /session` with
 * `session.deferRefresh` on only (plan 12a).
 */
export type PublicSession = ReturnType<typeof publicSession> & { needsRefresh?: boolean };
