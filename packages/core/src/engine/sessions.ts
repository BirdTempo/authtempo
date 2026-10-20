import type { ResolvedConfig } from "../config.js";
import { readCookie, sessionCookie } from "../http/cookies.js";
import {
  readBearer,
  readSessionToken,
  SESSION_TOKEN_PREFIX,
  sessionCookieToken,
} from "../primitives/credentials.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import type { SessionRow, UserRow } from "../schema.js";
import type { StorageAdapter, Where } from "../storage/port.js";
import {
  patchFields,
  runAfter,
  runBefore,
  type SessionDraft,
  type SessionEndReason,
  type SessionVia,
  stopWith,
} from "./hooks.js";
import { endSessionById, writeLogouts } from "./oauth-outbox.js";
import { activeBan, bannedFor } from "./operator/ban-rule.js";
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

export interface SessionInput {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  /** Set only through `openSession`, after the membership check of a hook's patch (plan 9d). */
  activeOrganizationId?: string | null;
  /** The last sign-in, when it is older than the session: a handoff (plan 12e ruling 41). Default now. */
  freshAt?: Date;
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
  const session = await storage.create("session", {
    id: newId(now),
    userId: input.userId,
    tokenHash: await sha256Hex(token),
    expiresAt: sessionExpiry(config, now, now),
    lastSeenAt: now,
    ip: input.ip,
    userAgent: input.userAgent,
    activeOrganizationId: input.activeOrganizationId ?? null,
    freshAt: input.freshAt ?? now,
    actorId: null,
    createdAt: now,
    updatedAt: now,
  });
  return { token, session };
}

const PATCH_KEYS: ReadonlySet<string> = new Set(["ip", "userAgent", "activeOrganizationId"]);

function nullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

/** One line that says what was wrong, never a value: a value can be an address or an agent string. */
function refusePatch(what: string): never {
  console.error("authtempo: session patch refused", what);
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
): Promise<SessionInput> {
  const input: SessionInput = { userId: draft.userId, ip: draft.ip, userAgent: draft.userAgent };
  const fields = patchFields(patch, refusePatch);
  if (!fields) return input;
  for (const key of Object.keys(fields))
    if (!PATCH_KEYS.has(key)) return refusePatch(`the field ${key}`);
  const { ip, userAgent, activeOrganizationId } = fields;
  if (ip !== undefined) {
    if (!nullableString(ip)) return refusePatch("an ip that is not a string or null");
    input.ip = ip;
  }
  if (userAgent !== undefined) {
    if (!nullableString(userAgent)) return refusePatch("a userAgent that is not a string or null");
    input.userAgent = userAgent;
  }
  if (activeOrganizationId !== undefined) {
    if (!nullableString(activeOrganizationId))
      return refusePatch("an activeOrganizationId that is not a string or null");
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
  const patch = await runBefore("session.beforeCreate", config.hooks.session.beforeCreate, {
    session: draft,
    user: input.user,
    via: input.via,
  });
  const patched = await patchedInput(config, storage, draft, patch);
  const prepared = {
    input: input.signedInAt ? { ...patched, freshAt: input.signedInAt } : patched,
  };
  // After the hook: the hold is a write, and a before hook runs before the
  // first write (the D1 undo). Before the flow's other writes: the lock order.
  // Not for an unverified user: a claim can verify that row during the
  // sign-in, and the sign-in must not write it (sessions-claim.test.ts,
  // re-review finding B). The read in `writeSession` still runs.
  if (input.user.emailVerified) await holdUser(storage, input.user.id);
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

/** `session.afterCreate` for a sign-in that committed (plan 9d). */
export async function sessionOpened(
  config: ResolvedConfig,
  session: SessionRow,
  user: UserRow,
  via: SessionVia,
): Promise<void> {
  await runAfter(
    "session.afterCreate",
    config.hooks.session.afterCreate,
    { session, user, via },
    session.id,
  );
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
): Promise<number> {
  // The outbox reads the user's links; every flow ends the sessions of one user.
  const user = where.find((w) => w.field === "userId" && w.op === "eq")?.value;
  if (typeof user !== "string") throw new Error("authtempo: endSessions needs a userId term");
  const links = await tx.findMany("oauthSessionClient", [
    { field: "userId", op: "eq", value: user },
  ]);
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
  if (ended)
    for (const row of await tx.findMany("session", where)) {
      if ((await tx.delete("session", [{ field: "id", op: "eq", value: row.id }])) === 1) {
        ended.push(row);
        n++;
      }
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

/** `session.afterEnd` once per row, in order, after the commit that deleted them (plan 9d). No list: no hook listens. */
export async function sessionsEnded(
  config: ResolvedConfig,
  sessions: readonly SessionRow[] | undefined,
  reason: SessionEndReason,
): Promise<void> {
  for (const session of sessions ?? [])
    await runAfter(
      "session.afterEnd",
      config.hooks.session.afterEnd,
      { session, reason },
      session.id,
    );
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
 */
export type SessionReadMode = "write" | "read-only";

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
 * `needsRefresh`. No mode changes `freshAt`.
 *
 * A session from before the end of the user's last ban answers null (plan
 * 12f, `bannedFor`). The ban ended every session in its transaction, so
 * such a row is one that a sign-in wrote in a race with the ban. It stays
 * ended after the unban and after `banUntil` (ruling 28). In `"write"` mode
 * the call deletes it by id; in `"read-only"` mode it writes nothing
 * (ruling 4).
 */
export async function resolveSession(
  config: ResolvedConfig,
  token: string,
  mode: SessionReadMode = "write",
): Promise<ResolvedSession | null> {
  const write = mode === "write";
  if (!TOKEN_RE.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const now = config.clock.now();
  const session = await config.storage.findOne("session", [
    { field: "tokenHash", op: "eq", value: tokenHash },
  ]);
  if (!session) return null;
  // The absolute cap ends a session whose expiresAt is later: a row written
  // before `absoluteDays` was set (plan 12b).
  if (!sessionIsLive(config, session, now)) {
    if (!write) return null;
    // The links of the row go to the outbox before the delete (plan 12e Task 16). The sweep delivers them.
    const n = await endSessionById(config.storage, session, now);
    // One row: this call ended it. Zero: another call or the sweep did, and the sweep fires no hook.
    if (n === 1) await sessionsEnded(config, [session], "expired");
    return null;
  }
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: session.userId },
  ]);
  if (!user) return null;
  if (bannedFor(user, session.createdAt)) {
    if (!write) return null;
    // As for an expired row: the links go to the outbox, and the sweep delivers them.
    const n = await endSessionById(config.storage, session, now);
    if (n === 1) await sessionsEnded(config, [session], "banned");
    return null;
  }
  const sinceSeen = now.getTime() - session.lastSeenAt.getTime();
  const due = sinceSeen >= config.session.slidingRefreshDays * DAY_MS;
  if (!write) return { user, session, refreshed: false, needsRefresh: due };
  if (due) {
    const expiresAt = sessionExpiry(config, session.createdAt, now);
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
  const n = await endSessionById(config.storage, session, config.clock.now());
  if (n !== 1) return null;
  await sessionsEnded(config, [session], "sign_out");
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

/** The caller's session from the cookie or the bearer header, or null. */
export async function sessionFromRequest(
  config: ResolvedConfig,
  request: Request,
  options: SessionReadOptions = {},
): Promise<ResolvedSession | null> {
  const token = readSessionToken(config, request);
  return token ? resolveSession(config, token, readModeOf(config, request, options)) : null;
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
  email: string;
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

/** The public shape of a session. Never the hash, never internal ids a client does not need. */
export function publicSession(resolved: ResolvedSession): {
  user: ReturnType<typeof publicUser>;
  session: { id: string; expiresAt: string; activeOrganizationId: string | null };
} {
  const { user, session } = resolved;
  return {
    user: publicUser(user),
    session: {
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
      activeOrganizationId: session.activeOrganizationId,
    },
  };
}

/**
 * The JSON shape of a session answer: `GET /session`, the verify routes, and
 * the redeem. `needsRefresh` is in the answer of `GET /session` with
 * `session.deferRefresh` on only (plan 12a).
 */
export type PublicSession = ReturnType<typeof publicSession> & { needsRefresh?: boolean };
