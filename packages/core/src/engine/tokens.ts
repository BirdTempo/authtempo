import { isSubset, type Statements, statementFault } from "../access.js";
import type { ResolvedConfig } from "../config.js";
import type { LimitWindow } from "../limiter/port.js";
import { API_TOKEN_PREFIX } from "../primitives/credentials.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { JWS_RE } from "../primitives/jwk.js";
import { hasControlChar } from "../primitives/text.js";
import { fail, ok, type Result } from "../result.js";
import type { ApiTokenRow, UserRow } from "../schema.js";
import type { OAuthClientAccess } from "./oauth-credentials.js";
import { readDpopToken, resourceProofHolds } from "./oauth-dpop.js";
import {
  type OAuthAccess,
  type ResolvedAccess,
  requestResource,
  resolveAccessToken,
} from "./oauth-token.js";
import { activeBan } from "./operator/ban-rule.js";
import { membership } from "./organizations.js";
import { effectiveIn } from "./permissions.js";
import {
  type ResolvedSession,
  readBearer,
  readModeOf,
  resolveSession,
  sessionCookieToken,
} from "./sessions.js";
import {
  spendUse,
  type TokenQuota,
  useWindow,
  validQuota,
  validWindow,
  windowOf,
} from "./token-use.js";

// Moved to primitives/credentials.ts (plan 11d); still exported here.
export { API_TOKEN_PREFIX };

// Built from the prefix, so the pattern and the prefix cannot drift (the prefix has no regex character).
const API_TOKEN_RE = new RegExp(`^${API_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);
/** The part of a moved key after its prefix (ruling 4 of plan 12k). */
const MOVED_REST_RE = /^[A-Za-z0-9_-]{1,256}$/;
/** The JSON of `metadata`, in UTF-8 bytes. */
const METADATA_MAX_BYTES = 4096;
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
  /** The statements the token may use (plan 12k). Null: the rights of its user. */
  permissions: Statements | null;
  /** The app's own data on the token. Core never reads it. */
  metadata: Record<string, unknown> | null;
  /** The per-token window, or null for none. */
  rateLimit: LimitWindow | null;
  /** The calls that the quota still allows, or null for no quota. */
  remaining: number | null;
  /** True for a retired row. A retired row never acts. */
  retired: boolean;
  createdAt: Date;
}

export interface ResolvedApiToken {
  user: UserRow;
  apiToken: ApiTokenSummary;
  /** The token's organization. Null for a token with none. */
  activeOrganizationId: string | null;
}

/**
 * Who called: a person with a session, a script with an API token, or an
 * OAuth client for a person (plan 9g). `oauth-client` is an OAuth client
 * that acts for itself, with no user (`client_credentials`, plan 12e).
 * The `subject` of an `oauth` caller is the token's `sub` (ruling 34 of plan
 * 12e). It is the user id for a public client, and the pairwise subject for
 * a pairwise client. `user` is always the user.
 */
export type Caller =
  | ({ kind: "session" } & ResolvedSession)
  | ({ kind: "token" } & ResolvedApiToken)
  | ({ kind: "oauth"; subject: string } & OAuthAccess)
  | ({ kind: "oauth-client" } & OAuthClientAccess);

export interface ApiTokenCreate {
  user: UserRow;
  /** 1 to 80 UTF-16 code units, no control character, not trimmed. */
  name: string;
  /** An integer from 1 to 3650. Default 90. `null`: the token never expires. */
  expiresInDays?: number | null | undefined;
  /** An organization the user is a member of. The token then acts in it only. */
  organizationId?: string | null | undefined;
  /**
   * A set that narrows the token, of names that `organizations.statements`
   * knows; `invalid_body` with organizations off. A token bound to an
   * organization holds a subset of its user's set there, else
   * `forbidden_rank`. Null or absent: the user's own rights.
   */
  permissions?: Statements | null | undefined;
  /** The app's own data, at most 4096 bytes as JSON. Core never reads it, and no log line holds it. */
  metadata?: Record<string, unknown> | null | undefined;
  /** In process only. Absent: `tokens.defaultRateLimit`. Null: no window. */
  rateLimit?: LimitWindow | null | undefined;
  /** In process only. Null or absent: no quota. */
  quota?: TokenQuota | null | undefined;
}

/** The narrow-only change of a token (spec 29 item 11). An absent field stays as it is. */
export interface ApiTokenUpdate {
  user: UserRow;
  id: string;
  name?: string | undefined;
  /** A subset of the old set. A set over null narrows; null over a set is `invalid_body`. */
  permissions?: Statements | null | undefined;
  /** Earlier than the old expiry. A token with no expiry may get one; null over a date is `invalid_body`. */
  expiresAt?: Date | null | undefined;
  /** In process only. Any window, or null for none; a change starts a new count. */
  rateLimit?: LimitWindow | null | undefined;
  /** In process only. It may lower `remaining` or drop the refill, and never more. */
  quota?: TokenQuota | null | undefined;
}

/** The codes of a failed token or caller resolve (spec 29 item 16). */
export type AuthCode =
  | "unauthorized"
  | "rate_limited"
  | "token_exhausted"
  | "token_retired"
  | "conflict";

/** 1 to 80 UTF-16 code units, with no C0 control character and no DEL. */
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
    permissions: row.permissions,
    metadata: row.metadata,
    rateLimit: windowOf(row),
    remaining: row.remaining,
    retired: row.retiredAt !== null,
    createdAt: row.createdAt,
  };
}

/** True for a set that `organizations.statements` knows. False with organizations off. */
function knownSet(config: ResolvedConfig, set: unknown): set is Statements {
  const o = config.organizations;
  return o !== null && statementFault(set, o.statements) === null;
}

/** A plain copy of a valid set, as the row stores it. */
function copySet(set: Statements): Record<string, string[]> {
  return Object.fromEntries(Object.entries(set).map(([k, v]) => [k, [...v]]));
}

/** True for a plain object whose JSON is at most 4096 bytes of UTF-8. */
function validMetadata(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const text = JSON.stringify(value);
    return new TextEncoder().encode(text).length <= METADATA_MAX_BYTES;
  } catch {
    // A cycle or a BigInt has no JSON.
    return false;
  }
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
  const permissions = input.permissions ?? null;
  if (permissions !== null && !knownSet(config, permissions)) return fail("invalid_body");
  const metadata = input.metadata ?? null;
  if (metadata !== null && !validMetadata(metadata)) return fail("invalid_body");
  const window = input.rateLimit === undefined ? config.tokens.defaultRateLimit : input.rateLimit;
  if (window !== null && !validWindow(window)) return fail("invalid_body");
  const quota = input.quota ?? null;
  if (quota !== null && !validQuota(quota)) return fail("invalid_body");
  // The limiter runs before every storage read, in every flow. So a flood with
  // a wrong organization costs one read per request at most, not one per try.
  if (!(await config.limiter.allow(`token-create:user:${user.id}`, CREATE_PER_USER)))
    return fail("rate_limited");
  const organizationId = input.organizationId ?? null;
  if (organizationId !== null) {
    // `membership` answers null with organizations off, for a missing
    // organization, and for a non-member. The answer is the same for each.
    const m = await membership(config, organizationId, user.id);
    if (!m) return fail("not_found");
    // A token never holds more than its user holds in its organization (spec 29 item 10).
    if (permissions !== null) {
      const { granted } = await effectiveIn(config, config.storage, organizationId, m.member.role);
      if (!isSubset(permissions, granted)) return fail("forbidden_rank");
    }
  }
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
    permissions: permissions === null ? null : copySet(permissions),
    metadata,
    rateLimitSeconds: window === null ? null : window.seconds,
    rateLimitMax: window === null ? null : window.max,
    remaining: quota === null ? null : quota.remaining,
    refillAmount: quota?.refillAmount ?? null,
    refillSeconds: quota?.refillSeconds ?? null,
    lastRefillAt: null,
    retiredAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return ok({ token, apiToken: publicApiToken(row) });
}

/** True when the bearer is a token form: `tk_`, or a prefix of `tokens.movedPrefixes`. */
export function isTokenBearer(config: ResolvedConfig, bearer: string): boolean {
  return (
    bearer.startsWith(API_TOKEN_PREFIX) ||
    config.tokens.movedPrefixes.some((p) => bearer.startsWith(p))
  );
}

/**
 * The token of a `tk_` bearer or of a moved key (ruling 4 of plan 12k). The
 * checks run in this order: the form, the hash lookup, the expiry, the retired
 * mark, the user, the ban, the membership, the window, and the spend. So a
 * refused call spends nothing. `unauthorized` for a malformed, unknown, or
 * expired token, a token whose user is gone or banned, and a token whose
 * membership is gone. A moved
 * key with no row answers `token_retired`, and so does a retired row. An
 * expired row is deleted on the way out. A row whose membership is gone
 * stays, so the list still shows it and the person sees why it stopped.
 *
 * Storage calls: none for a malformed bearer. Else one findOne of the hash, one
 * findOne of the user, and two findOne for a bound token (`membership`). Then
 * the spend of `spendUse` (none with no quota), and one update of
 * `lastUsedAt` at most once per hour. One limiter call for a token with a
 * window.
 */
export async function authenticateApiToken(
  config: ResolvedConfig,
  token: string,
): Promise<Result<ResolvedApiToken>> {
  const moved = config.tokens.movedPrefixes.find((p) => token.startsWith(p));
  const formed =
    moved === undefined ? API_TOKEN_RE.test(token) : MOVED_REST_RE.test(token.slice(moved.length));
  if (!formed) return fail("unauthorized");
  const row = await config.storage.findOne("apiToken", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  if (!row) return fail(moved === undefined ? "unauthorized" : "token_retired");
  const now = config.clock.now();
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    await config.storage.delete("apiToken", [{ field: "id", op: "eq", value: row.id }]);
    return fail("unauthorized");
  }
  if (row.retiredAt !== null) return fail("token_retired");
  const user = await config.storage.findOne("user", [{ field: "id", op: "eq", value: row.userId }]);
  if (!user) return fail("unauthorized");
  // A banned user's token answers unauthorized, and its row stays: it works
  // again after an unban (plan 12f, spec 26 item 6). The ban check runs before
  // the window and the spend, so a banned call spends nothing (ruling 7 of plan 12k).
  if (activeBan(user, now)) return fail("unauthorized");
  if (row.organizationId !== null && !(await membership(config, row.organizationId, user.id)))
    return fail("unauthorized");
  if (!(await useWindow(config, "tk", row))) return fail("rate_limited");
  const spent = await spendUse(config, "apiToken", row);
  if (!spent.ok) return spent;
  let lastUsedAt = row.lastUsedAt;
  if (lastUsedAt === null || now.getTime() - lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
    await config.storage.update("apiToken", [{ field: "id", op: "eq", value: row.id }], {
      lastUsedAt: now,
      updatedAt: now,
    });
    lastUsedAt = now;
  }
  return ok({
    user,
    apiToken: publicApiToken({ ...row, lastUsedAt, remaining: spent.value }),
    activeOrganizationId: row.organizationId,
  });
}

/** `authenticateApiToken` with null for each failure. Plan 8b's form. */
export async function resolveApiToken(
  config: ResolvedConfig,
  token: string,
): Promise<ResolvedApiToken | null> {
  const r = await authenticateApiToken(config, token);
  return r.ok ? r.value : null;
}

/** The token's user and summary, or the code of `authenticateApiToken`. It spends one call. */
export function currentApiToken(
  config: ResolvedConfig,
  input: { token: string },
): Promise<Result<ResolvedApiToken>> {
  return authenticateApiToken(config, input.token);
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
 * Narrows the caller's token by id and user id (spec 29 item 11). Another
 * user's id answers `not_found`. Each refused change answers
 * `invalid_body` and writes nothing. The route checks the fresh rule; an
 * in-process call is the app's own act (ruling 8 of plan 12k). The write is
 * one update on `updatedAt` as read, and on the quota as read when the quota
 * changes; zero rows answers `conflict`. Storage calls: one findOne and at
 * most one update.
 */
export async function updateApiToken(
  config: ResolvedConfig,
  input: ApiTokenUpdate,
): Promise<Result<ApiTokenSummary>> {
  if (!input.user.emailVerified) return fail("email_unverified");
  if (input.name !== undefined && !validTokenName(input.name)) return fail("invalid_body");
  const set = input.permissions;
  if (set != null && !knownSet(config, set)) return fail("invalid_body");
  const until = input.expiresAt;
  if (until != null && Number.isNaN(until.getTime())) return fail("invalid_body");
  if (input.rateLimit != null && !validWindow(input.rateLimit)) return fail("invalid_body");
  const quota = input.quota;
  if (quota != null && !validQuota(quota)) return fail("invalid_body");
  const row = await config.storage.findOne("apiToken", [
    { field: "id", op: "eq", value: input.id },
    { field: "userId", op: "eq", value: input.user.id },
  ]);
  if (!row) return fail("not_found");
  const data: Partial<Omit<ApiTokenRow, "id">> = {};
  if (input.name !== undefined) data.name = input.name;
  if (set === null) {
    // A set to null widens the token.
    if (row.permissions !== null) return fail("invalid_body");
  } else if (set !== undefined) {
    if (row.permissions !== null && !isSubset(set, row.permissions)) return fail("invalid_body");
    data.permissions = copySet(set);
  }
  if (until === null) {
    if (row.expiresAt !== null) return fail("invalid_body");
  } else if (until !== undefined) {
    if (row.expiresAt !== null && until.getTime() >= row.expiresAt.getTime())
      return fail("invalid_body");
    data.expiresAt = new Date(until.getTime());
  }
  if (input.rateLimit !== undefined) {
    data.rateLimitSeconds = input.rateLimit === null ? null : input.rateLimit.seconds;
    data.rateLimitMax = input.rateLimit === null ? null : input.rateLimit.max;
  }
  if (quota === null) {
    // Dropping the quota widens the token.
    if (row.remaining !== null) return fail("invalid_body");
  } else if (quota !== undefined) {
    if (row.remaining !== null) {
      if (quota.remaining > row.remaining) return fail("invalid_body");
      // The refill may stay as it is or go, and never change or come back.
      if (
        quota.refillAmount !== undefined &&
        (quota.refillAmount !== row.refillAmount || quota.refillSeconds !== row.refillSeconds)
      )
        return fail("invalid_body");
    }
    data.remaining = quota.remaining;
    data.refillAmount = quota.refillAmount ?? null;
    data.refillSeconds = quota.refillSeconds ?? null;
    if (quota.refillAmount === undefined) data.lastRefillAt = null;
  }
  if (Object.keys(data).length === 0) return ok(publicApiToken(row));
  const now = config.clock.now();
  data.updatedAt = now;
  const n = await config.storage.update(
    "apiToken",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "updatedAt", op: "eq", value: row.updatedAt },
      // A spend between the read and the write changes the count; the change then answers conflict.
      ...(quota != null
        ? [
            { field: "remaining", op: "eq", value: row.remaining } as const,
            { field: "lastRefillAt", op: "eq", value: row.lastRefillAt } as const,
          ]
        : []),
    ],
    data,
  );
  if (n === 0) return fail("conflict");
  return ok(publicApiToken({ ...row, ...data }));
}

/** The caller of a resolved access token. */
const accessCaller = (r: ResolvedAccess): Caller =>
  r.kind === "oauth"
    ? { kind: "oauth", ...r.access, subject: r.subject }
    : { kind: "oauth-client", ...r.access };

/**
 * The answer of each request with `Authorization: DPoP` or a token bearer,
 * by instance. So a second `auth.caller` or `auth.authenticate` of one request
 * answers the same. The first call spends the proof's `jti`. It also spends
 * one call of a token quota (ruling 3 of plan 12k). A replay is another
 * request. The key is the config first, so two instances never share an
 * answer (ruling 31 of plan 12e).
 */
const requestCallers = new WeakMap<ResolvedConfig, WeakMap<Request, Promise<Result<Caller>>>>();

/** The answer of `make` for this request and instance, made once. */
function once(
  config: ResolvedConfig,
  request: Request,
  make: () => Promise<Result<Caller>>,
): Promise<Result<Caller>> {
  let mine = requestCallers.get(config);
  if (!mine) {
    mine = new WeakMap();
    requestCallers.set(config, mine);
  }
  const seen = mine.get(request);
  if (seen) return seen;
  const answer = make();
  mine.set(request, answer);
  return answer;
}

/** The token caller of a bearer, once per request. */
function tokenCaller(config: ResolvedConfig, request: Request, bearer: string) {
  return once(config, request, async () => {
    const t = await authenticateApiToken(config, bearer);
    return t.ok ? ok<Caller>({ kind: "token", ...t.value }) : t;
  });
}

/**
 * The caller of `GET /tokens/current`: a token bearer only. A cookie or a
 * `ts_` bearer is a person, and answers `unauthorized`.
 */
export function apiTokenFromRequest(
  config: ResolvedConfig,
  request: Request,
): Promise<Result<Caller>> {
  const bearer = readBearer(request);
  if (bearer === null || !isTokenBearer(config, bearer))
    return Promise.resolve(fail("unauthorized"));
  return tokenCaller(config, request, bearer);
}

/**
 * A DPoP-bound access token with its proof (RFC 9449 section 7.1), for the
 * resource that this request falls under only. The proof is checked last,
 * so a request that fails another check spends no `jti`.
 */
async function dpopCaller(
  config: ResolvedConfig,
  request: Request,
  token: string,
): Promise<Caller | null> {
  if (!config.oauth) return null;
  const r = await resolveAccessToken(config, token);
  if (!r || r.access.dpopJkt === null) return null;
  if (r.access.resource !== requestResource(config, request)) return null;
  // The resource check above pins the origin, so the request URL is the target here.
  const bound = { token, jkt: r.access.dpopJkt };
  if (!(await resourceProofHolds(config, request, request.url, bound))) return null;
  return accessCaller(r);
}

/**
 * The cookie first, then the bearer header, as `readSessionToken` reads
 * them: both call `sessionCookieToken`, so the cookie is `cookieName`, then
 * the old `legacyCookieName` for one release (plan 12b). A present cookie
 * wins and the header is not read. A cookie resolves
 * as a session only. A `tk_` value counts only in the bearer header: a
 * browser sends a cookie on a cross-site request, and a script never has
 * one. A JWT bearer is an OAuth access token (plan 9g). `Authorization:
 * DPoP` carries a DPoP-bound access token with its proof (plan 12e).
 *
 * A failure of a token answers its code (spec 29 item 16); any other failure
 * answers `unauthorized`. A token resolve spends one call of its quota in
 * every read mode, once per request (rulings 3 and 17 of plan 12k).
 */
export async function authenticateRequest(
  config: ResolvedConfig,
  request: Request,
): Promise<Result<Caller>> {
  const cookie = sessionCookieToken(config, request);
  if (cookie) {
    const s = await resolveSession(config, cookie, readModeOf(config, request));
    return s ? ok({ kind: "session", ...s }) : fail("unauthorized");
  }
  const dpop = readDpopToken(request);
  if (dpop !== null)
    return once(config, request, async () => {
      const caller = await dpopCaller(config, request, dpop);
      return caller ? ok(caller) : fail("unauthorized");
    });
  const bearer = readBearer(request);
  if (bearer === null) return fail("unauthorized");
  if (isTokenBearer(config, bearer)) return tokenCaller(config, request, bearer);
  // Plan 9g: a JWT bearer is an OAuth access token, for the resource that
  // this request falls under only. No session token has this shape, so a
  // JWT bearer answered null here before; it still does while oauth is off.
  if (JWS_RE.test(bearer)) {
    if (!config.oauth) return fail("unauthorized");
    const r = await resolveAccessToken(config, bearer);
    if (!r || r.access.resource !== requestResource(config, request)) return fail("unauthorized");
    // RFC 9449 section 7.2: a bound token never passes as a Bearer token.
    if (r.access.dpopJkt !== null) return fail("unauthorized");
    return ok(accessCaller(r));
  }
  const s = await resolveSession(config, bearer, readModeOf(config, request));
  return s ? ok({ kind: "session", ...s }) : fail("unauthorized");
}

/** `authenticateRequest` with null for each failure. */
export async function callerFromRequest(
  config: ResolvedConfig,
  request: Request,
): Promise<Caller | null> {
  const r = await authenticateRequest(config, request);
  return r.ok ? r.value : null;
}
