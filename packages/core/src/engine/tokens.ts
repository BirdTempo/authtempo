import type { ResolvedConfig } from "../config.js";
import { readCookie } from "../http/cookies.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { hasControlChar } from "../primitives/text.js";
import { fail, ok, type Result } from "../result.js";
import type { ApiTokenRow, UserRow } from "../schema.js";
import { membership } from "./organizations.js";
import { type ResolvedSession, readBearer, resolveSession } from "./sessions.js";

export const API_TOKEN_PREFIX = "tk_";
const API_TOKEN_RE = /^tk_[A-Za-z0-9_-]{43}$/;
const HINT_LENGTH = 8;
const DAY_MS = 86_400_000;
const NAME_MAX = 80;
const DEFAULT_EXPIRES_IN_DAYS = 90;
const MAX_EXPIRES_IN_DAYS = 3650;
/** A busy script must not write the row on every request. */
const LAST_USED_EVERY_MS = 3_600_000;
/** Per user. More is a list nobody reviews. */
export const API_TOKEN_CAP = 50;
// 20 per hour per user: a person makes a few tokens; a stolen session that mints many is slowed.
const CREATE_PER_USER = { seconds: 3600, max: 20 };

/** What a list shows. Never the hash, never the token. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  hint: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  organizationId: string | null;
  createdAt: Date;
}

export interface ResolvedApiToken {
  user: UserRow;
  apiToken: ApiTokenSummary;
  /** The token's organization. Null for a token with none. */
  activeOrganizationId: string | null;
}

/** Who called: a person with a session, or a script with an API token. */
export type Caller =
  | ({ kind: "session" } & ResolvedSession)
  | ({ kind: "token" } & ResolvedApiToken);

export interface ApiTokenCreate {
  user: UserRow;
  /** 1 to 80 UTF-16 code units, no control character, not trimmed. */
  name: string;
  /** An integer from 1 to 3650. Default 90. `null`: the token never expires. */
  expiresInDays?: number | null | undefined;
  /** An organization the user is a member of. The token then acts in it only. */
  organizationId?: string | null | undefined;
}

/** The rule of `validUserName`, with 80 for the maximum. */
export function validTokenName(name: string): boolean {
  return name.length >= 1 && name.length <= NAME_MAX && !hasControlChar(name);
}

export function publicApiToken(row: ApiTokenRow): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    organizationId: row.organizationId,
    createdAt: row.createdAt,
  };
}

/**
 * A new token for a verified user. The answer holds the clear token, the one
 * time it leaves the server; the row holds its SHA-256. The caller's session
 * is the route's check: core's token routes take a session only, so a token
 * never mints a token.
 */
export async function createApiToken(
  config: ResolvedConfig,
  input: ApiTokenCreate,
): Promise<Result<{ token: string; apiToken: ApiTokenSummary }>> {
  const { user } = input;
  if (!user.emailVerified) return fail("email_unverified");
  if (!validTokenName(input.name)) return fail("invalid_body");
  const days = input.expiresInDays === undefined ? DEFAULT_EXPIRES_IN_DAYS : input.expiresInDays;
  if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > MAX_EXPIRES_IN_DAYS))
    return fail("invalid_body");
  // The limiter runs before every storage read, in every flow. So a flood with
  // a wrong organization costs one read per request at most, not one per try.
  if (!(await config.limiter.allow(`token-create:user:${user.id}`, CREATE_PER_USER)))
    return fail("rate_limited");
  const organizationId = input.organizationId ?? null;
  // `membership` answers null with organizations off, for a missing
  // organization, and for a non-member. The answer is the same for each.
  if (organizationId !== null && !(await membership(config, organizationId, user.id)))
    return fail("not_found");
  const now = config.clock.now();
  // The user's expired tokens go first, so they do not count against the cap.
  await config.storage.delete("apiToken", [
    { field: "userId", op: "eq", value: user.id },
    { field: "expiresAt", op: "lte", value: now },
  ]);
  // A count, then a create, not one statement: two creates at once can both
  // pass at 49 and make 51. The per-user limit above bounds the overshoot.
  const held = await config.storage.findMany(
    "apiToken",
    [{ field: "userId", op: "eq", value: user.id }],
    { limit: API_TOKEN_CAP },
  );
  if (held.length >= API_TOKEN_CAP) return fail("token_limit");
  const token = randomToken(API_TOKEN_PREFIX);
  const row = await config.storage.create("apiToken", {
    id: newId(now),
    userId: user.id,
    name: input.name,
    tokenHash: await sha256Hex(token),
    hint: token.slice(API_TOKEN_PREFIX.length, API_TOKEN_PREFIX.length + HINT_LENGTH),
    expiresAt: days === null ? null : new Date(now.getTime() + days * DAY_MS),
    lastUsedAt: null,
    organizationId,
    createdAt: now,
    updatedAt: now,
  });
  return ok({ token, apiToken: publicApiToken(row) });
}

/**
 * Null for a malformed, unknown, or expired token, a token whose user is
 * gone, and a token whose organization membership is gone. An expired row is
 * deleted on the way out. A row whose membership is gone stays, so the list
 * still shows it and the person sees why it stopped. No limit applies: a
 * token is 32 random bytes, as a session token is, and the session path has
 * none either.
 */
export async function resolveApiToken(
  config: ResolvedConfig,
  token: string,
): Promise<ResolvedApiToken | null> {
  if (!API_TOKEN_RE.test(token)) return null;
  const row = await config.storage.findOne("apiToken", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  if (!row) return null;
  const now = config.clock.now();
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    await config.storage.delete("apiToken", [{ field: "id", op: "eq", value: row.id }]);
    return null;
  }
  const user = await config.storage.findOne("user", [{ field: "id", op: "eq", value: row.userId }]);
  if (!user) return null;
  if (row.organizationId !== null && !(await membership(config, row.organizationId, user.id)))
    return null;
  let lastUsedAt = row.lastUsedAt;
  if (lastUsedAt === null || now.getTime() - lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
    await config.storage.update("apiToken", [{ field: "id", op: "eq", value: row.id }], {
      lastUsedAt: now,
      updatedAt: now,
    });
    lastUsedAt = now;
  }
  return {
    user,
    apiToken: publicApiToken({ ...row, lastUsedAt }),
    activeOrganizationId: row.organizationId,
  };
}

/** `resolveApiToken` as a Result: `unauthorized` for anything it answers null to. */
export async function currentApiToken(
  config: ResolvedConfig,
  input: { token: string },
): Promise<Result<ResolvedApiToken>> {
  const resolved = await resolveApiToken(config, input.token);
  return resolved ? ok(resolved) : fail("unauthorized");
}

/** The caller's tokens, newest first. */
export async function listApiTokens(
  config: ResolvedConfig,
  input: { user: UserRow },
): Promise<Result<ApiTokenSummary[]>> {
  if (!input.user.emailVerified) return fail("email_unverified");
  const rows = await config.storage.findMany(
    "apiToken",
    [{ field: "userId", op: "eq", value: input.user.id }],
    {
      sort: [
        { field: "createdAt", dir: "desc" },
        { field: "id", dir: "desc" },
      ],
    },
  );
  return ok(rows.map(publicApiToken));
}

/** Deletes the caller's token by id and user id. Another user's id answers not_found. */
export async function revokeApiToken(
  config: ResolvedConfig,
  input: { user: UserRow; id: string },
): Promise<Result<{ ok: true }>> {
  if (!input.user.emailVerified) return fail("email_unverified");
  const n = await config.storage.delete("apiToken", [
    { field: "id", op: "eq", value: input.id },
    { field: "userId", op: "eq", value: input.user.id },
  ]);
  return n === 0 ? fail("not_found") : ok({ ok: true });
}

/**
 * The cookie first, then the bearer header, as `readSessionToken` reads
 * them: a present cookie wins and the header is not read. A cookie resolves
 * as a session only. A `tk_` value counts only in the bearer header: a
 * browser sends a cookie on a cross-site request, and a script never has one.
 */
export async function callerFromRequest(
  config: ResolvedConfig,
  request: Request,
): Promise<Caller | null> {
  const cookie = readCookie(request, config.cookieName);
  if (cookie) {
    const s = await resolveSession(config, cookie);
    return s ? { kind: "session", ...s } : null;
  }
  const bearer = readBearer(request);
  if (bearer === null) return null;
  if (bearer.startsWith(API_TOKEN_PREFIX)) {
    const t = await resolveApiToken(config, bearer);
    return t ? { kind: "token", ...t } : null;
  }
  const s = await resolveSession(config, bearer);
  return s ? { kind: "session", ...s } : null;
}
