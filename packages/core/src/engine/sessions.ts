import type { ResolvedConfig } from "../config.js";
import { readCookie, sessionCookie } from "../http/cookies.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import type { SessionRow, UserRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";

const DAY_MS = 86_400_000;
export const SESSION_TOKEN_PREFIX = "ts_";
const TOKEN_RE = /^ts_[A-Za-z0-9_-]{43}$/;

export interface SessionInput {
  userId: string;
  ip: string | null;
  userAgent: string | null;
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
    activeOrganizationId: null,
    createdAt: now,
    updatedAt: now,
  });
  return { token, session };
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
    await config.storage.delete("session", [{ field: "id", op: "eq", value: session.id }]);
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
  await config.storage.delete("session", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
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
