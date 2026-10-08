import type { ResolvedConfig } from "../config.js";
import { readCookie } from "../http/cookies.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import type { SessionRow, UserRow } from "../schema.js";

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
}

export async function createSession(
  config: ResolvedConfig,
  input: SessionInput,
): Promise<{ token: string; session: SessionRow }> {
  const now = config.clock.now();
  const token = randomToken(SESSION_TOKEN_PREFIX);
  const session = await config.storage.create("session", {
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
    return { user, session: { ...session, expiresAt, lastSeenAt: now, updatedAt: now } };
  }
  return { user, session };
}

export async function destroySession(config: ResolvedConfig, token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) return;
  await config.storage.delete("session", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
}

/** The cookie wins over the bearer header, so a web page cannot be overridden by a stray header. */
export function readSessionToken(config: ResolvedConfig, request: Request): string | null {
  const cookie = readCookie(request, config.cookieName);
  if (cookie) return cookie;
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return m?.[1] ?? null;
}

/** The public shape of a session. Never the hash, never internal ids a client does not need. */
export function publicSession(resolved: ResolvedSession): {
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    name: string | null;
    image: string | null;
  };
  session: { id: string; expiresAt: string; activeOrganizationId: string | null };
} {
  const { user, session } = resolved;
  return {
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      image: user.image,
    },
    session: {
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
      activeOrganizationId: session.activeOrganizationId,
    },
  };
}
