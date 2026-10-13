import type { ResolvedConfig } from "../config.js";
import { readCookie, sessionCookie } from "../http/cookies.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import type { SessionRow, UserRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";
import {
  runAfter,
  runBefore,
  type SessionDraft,
  type SessionEndReason,
  type SessionVia,
  stopWith,
} from "./hooks.js";

const DAY_MS = 86_400_000;
export const SESSION_TOKEN_PREFIX = "ts_";
const TOKEN_RE = /^ts_[A-Za-z0-9_-]{43}$/;

export interface SessionInput {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  /** Set only through `openSession`, after the membership check of a hook's patch (plan 9d). */
  activeOrganizationId?: string | null;
}

/** What an engine flow passes to `openSession` (plan 9d). */
export interface SessionOpen {
  user: UserRow;
  ip: string | null;
  userAgent: string | null;
  via: SessionVia;
}

export interface ResolvedSession {
  user: UserRow;
  session: SessionRow;
  /** True when this call moved the expiry forward. A cookie must then be set again, or it expires at its old Max-Age. */
  refreshed: boolean;
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
    expiresAt: new Date(now.getTime() + config.session.ttlDays * DAY_MS),
    lastSeenAt: now,
    ip: input.ip,
    userAgent: input.userAgent,
    activeOrganizationId: input.activeOrganizationId ?? null,
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
  console.error("tempo-auth: session patch refused", what);
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
  if (patch === undefined || patch === null) return input;
  if (typeof patch !== "object" || Array.isArray(patch))
    return refusePatch("a value that is not an object");
  const fields = patch as Record<string, unknown>;
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
 */
export async function prepareSession(
  config: ResolvedConfig,
  input: SessionOpen,
  storage: StorageAdapter = config.storage,
): Promise<PreparedSession> {
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
  return { input: await patchedInput(config, storage, draft, patch) };
}

/** The write step of `openSession`: the session row of a `prepareSession` answer. */
export function writeSession(
  config: ResolvedConfig,
  prepared: PreparedSession,
  storage: StorageAdapter = config.storage,
): Promise<{ token: string; session: SessionRow }> {
  return createSession(config, prepared.input, storage);
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

/** `session.afterEnd` once per row, in order, after the commit that deleted them (plan 9d). */
export async function sessionsEnded(
  config: ResolvedConfig,
  sessions: readonly SessionRow[],
  reason: SessionEndReason,
): Promise<void> {
  for (const session of sessions)
    await runAfter(
      "session.afterEnd",
      config.hooks.session.afterEnd,
      { session, reason },
      session.id,
    );
}

/**
 * Null for an unknown, malformed, or expired token. An expired row is
 * deleted on the way out. After `slidingRefreshDays` the expiry moves
 * forward by a full ttl.
 */
export async function resolveSession(
  config: ResolvedConfig,
  token: string,
): Promise<ResolvedSession | null> {
  if (!TOKEN_RE.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const now = config.clock.now();
  const session = await config.storage.findOne("session", [
    { field: "tokenHash", op: "eq", value: tokenHash },
  ]);
  if (!session) return null;
  if (session.expiresAt.getTime() <= now.getTime()) {
    const n = await config.storage.delete("session", [
      { field: "id", op: "eq", value: session.id },
    ]);
    // One row: this call ended it. Zero: another call or the sweep did, and the sweep fires no hook.
    if (n === 1) await sessionsEnded(config, [session], "expired");
    return null;
  }
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: session.userId },
  ]);
  if (!user) return null;
  const sinceSeen = now.getTime() - session.lastSeenAt.getTime();
  if (sinceSeen >= config.session.slidingRefreshDays * DAY_MS) {
    const expiresAt = new Date(now.getTime() + config.session.ttlDays * DAY_MS);
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

export async function destroySession(config: ResolvedConfig, token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) return;
  const session = await config.storage.findOne("session", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  if (!session) return;
  // By id, so the row the after hook names is the row this call deleted.
  const n = await config.storage.delete("session", [{ field: "id", op: "eq", value: session.id }]);
  if (n === 1) await sessionsEnded(config, [session], "sign_out");
}

/** The value of `Authorization: Bearer <value>`, or null. The one copy of the bearer rule. */
export function readBearer(request: Pick<Request, "headers">): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return m?.[1] ?? null;
}

/**
 * The cookie wins over the bearer header, so a web page cannot be overridden by a stray header.
 * Public from `@tempo-auth/core` since plan 9 Task 4, 2026-10-10: the Better Auth shim reads
 * the session token with this function, so the cookie and bearer rule has one copy. It reads
 * only `cookieName` and the headers, so the shim passes `{ cookieName }` and `{ headers }`.
 */
export function readSessionToken(
  config: Pick<ResolvedConfig, "cookieName">,
  request: Pick<Request, "headers">,
): string | null {
  const cookie = readCookie(request, config.cookieName);
  if (cookie) return cookie;
  return readBearer(request);
}

/** The caller's session from the cookie or the bearer header, or null. */
export async function sessionFromRequest(
  config: ResolvedConfig,
  request: Request,
): Promise<ResolvedSession | null> {
  const token = readSessionToken(config, request);
  return token ? resolveSession(config, token) : null;
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

/** The JSON shape of a session answer: `GET /session`, the verify routes, and the redeem. */
export type PublicSession = ReturnType<typeof publicSession>;
