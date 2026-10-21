import { can, isSubset, type Statements } from "../access.js";
import type { ResolvedConfig } from "../config.js";
import type { LimitWindow } from "../limiter/port.js";
import { ORGANIZATION_TOKEN_PREFIX } from "../primitives/credentials.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { OrganizationTokenRow, UserRow } from "../schema.js";
import { findManyIn } from "../storage/batch.js";
import { type OrganizationSummary, publicOrganization, standing } from "./organizations.js";
import { effectiveIn } from "./permissions.js";
import { lockOrganization } from "./teams.js";
import {
  spendUse,
  type TokenQuota,
  useWindow,
  validQuota,
  validWindow,
  windowOf,
} from "./token-use.js";
import {
  copySet,
  expiryOf,
  HINT_LENGTH,
  knownSet,
  lastUsedDue,
  movedFormed,
  movedPrefixOf,
  narrowFormed,
  narrowPatch,
  spendTokenCreate,
  type TokenNarrow,
  tokenDays,
  validMetadata,
  validTokenName,
} from "./tokens.js";

/**
 * Tokens that an organization owns (plan 12k, spec 29 items 14 to 16). A
 * `to_` token acts for its organization with its own fixed set, never as a
 * user. It stays when its creator leaves or deletes the account (owner
 * decision 2). The row has `createdById`, not `userId`, so the account delete
 * of plan 12a leaves it. Only a person with a session manages one, through
 * the rights of `apiToken`; a creator has no right of their own. The window
 * and the quota are the ones of a user token (`token-use.ts`).
 */

export { ORGANIZATION_TOKEN_PREFIX };

/** Live rows per organization. More is a list nobody reviews. */
export const ORGANIZATION_TOKEN_CAP = 50;

// Built from the prefix, so the pattern and the prefix cannot drift (the prefix has no regex character).
const ORGANIZATION_TOKEN_RE = new RegExp(`^${ORGANIZATION_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

const READ: Statements = { apiToken: ["read"] };
const CREATE: Statements = { apiToken: ["create"] };
const UPDATE: Statements = { apiToken: ["update"] };
const REVOKE: Statements = { apiToken: ["revoke"] };

/** What a list shows. Never the hash, never the token. */
export interface OrganizationTokenSummary {
  id: string;
  organizationId: string;
  name: string;
  hint: string;
  /** The token's own set. It never follows a role of its creator. */
  permissions: Statements;
  /** The app's own data on the token. Core never reads it. */
  metadata: Record<string, unknown> | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  /** The per-token window, or null for none. */
  rateLimit: LimitWindow | null;
  /** The calls that the quota still allows, or null for no quota. */
  remaining: number | null;
  /** True for a retired row. A retired row never acts. */
  retired: boolean;
  /** The user who made the token. The id stays after the person leaves. */
  createdById: string;
  /** True while that user has a member row in the organization. */
  creatorIsMember: boolean;
  createdAt: Date;
}

/** The answer of a `to_` bearer: its organization and its summary. No user. */
export interface ResolvedOrganizationToken {
  organization: OrganizationSummary;
  apiToken: OrganizationTokenSummary;
}

export interface OrganizationTokenCreate {
  user: UserRow;
  organizationId: string;
  /** 1 to 80 UTF-16 code units, no control character, not trimmed. */
  name: string;
  /**
   * A set of names that `organizations.statements` knows, and a subset of the
   * creator's set in the organization, else `forbidden_rank`. `{}` grants
   * nothing. Null is `invalid_body`: the token has no user whose rights it could take.
   */
  permissions: Statements;
  /** An integer from 1 to 3650. Default 90. `null`: the token never expires. */
  expiresInDays?: number | null | undefined;
  /** The app's own data, at most 4096 bytes as JSON. Core never reads it, and no log line holds it. */
  metadata?: Record<string, unknown> | null | undefined;
  /** In process only. Absent: `tokens.defaultRateLimit`. Null: no window. */
  rateLimit?: LimitWindow | null | undefined;
  /** In process only. Null or absent: no quota. */
  quota?: TokenQuota | null | undefined;
}

/** The narrow-only change of an organization token. An absent field stays as it is. */
export interface OrganizationTokenUpdate extends Omit<TokenNarrow, "permissions"> {
  user: UserRow;
  organizationId: string;
  id: string;
  /** A subset of the old set. */
  permissions?: Statements | undefined;
}

export function publicOrganizationToken(
  row: OrganizationTokenRow,
  creatorIsMember: boolean,
): OrganizationTokenSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    hint: row.hint,
    permissions: row.permissions,
    metadata: row.metadata,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    rateLimit: windowOf(row),
    remaining: row.remaining,
    retired: row.retiredAt !== null,
    createdById: row.createdById,
    creatorIsMember,
    createdAt: row.createdAt,
  };
}

/** True while the creator of `row` has a member row in its organization. One findOne. */
async function creatorIn(config: ResolvedConfig, row: OrganizationTokenRow): Promise<boolean> {
  const member = await config.storage.findOne("member", [
    { field: "organizationId", op: "eq", value: row.organizationId },
    { field: "userId", op: "eq", value: row.createdById },
  ]);
  return member !== null;
}

/**
 * A new token of the organization, made by a verified member with
 * `apiToken:create`. The answer holds the clear token, the one time it leaves
 * the server; the row holds its SHA-256. The route checks the fresh rule; an
 * in-process call is the app's own act (ruling 8 of plan 12k).
 *
 * The cap is a limit that the product sells. So the count and the create run
 * in one transaction after a lock of the organization row (ruling 27 of plan
 * 12k). The lock is an update by id that writes `createdAt` to its own value. On Postgres
 * a second create waits for the first commit and counts again. D1 runs no
 * isolated transaction, so there two creates at once can pass at 49; the
 * per-user limit bounds that overshoot.
 *
 * The standing read runs before the transaction. A removal with
 * `revokeTokens` takes the same lock, so after the lock the create reads the
 * creator's member row again through `tx`. A gone row, or a role without the
 * right or the set, answers `forbidden_rank` as `standing` does (ruling 32).
 *
 * Storage calls: three findOne of `standing`, then the transaction. In it run
 * one update (the lock) and one findOne of the member row. Then the role read
 * of `effectiveIn` runs, none for a role of the config. Last run one delete of
 * the expired rows, one findMany (the count), and one create. One limiter
 * call runs before every storage call.
 */
export async function createOrganizationToken(
  config: ResolvedConfig,
  input: OrganizationTokenCreate,
): Promise<Result<{ token: string; apiToken: OrganizationTokenSummary }>> {
  if (!config.organizations) return fail("not_found");
  const { user, organizationId } = input;
  if (!user.emailVerified) return fail("email_unverified");
  if (!validTokenName(input.name)) return fail("invalid_body");
  const days = tokenDays(input.expiresInDays);
  if (!days.ok) return days;
  if (!knownSet(config, input.permissions)) return fail("invalid_body");
  const metadata = input.metadata ?? null;
  if (metadata !== null && !validMetadata(metadata)) return fail("invalid_body");
  const window = input.rateLimit === undefined ? config.tokens.defaultRateLimit : input.rateLimit;
  if (window !== null && !validWindow(window)) return fail("invalid_body");
  const quota = input.quota ?? null;
  if (quota !== null && !validQuota(quota)) return fail("invalid_body");
  // The key of the user tokens: one bound of creates per person, for both kinds.
  if (!(await spendTokenCreate(config, user.id))) return fail("rate_limited");
  const s = await standing(config, user, organizationId, CREATE);
  if (!s.ok) return s;
  // A token never holds more than its creator holds in the organization (spec 29 item 14).
  if (!isSubset(input.permissions, s.value.granted)) return fail("forbidden_rank");
  const now = config.clock.now();
  const token = randomToken(ORGANIZATION_TOKEN_PREFIX);
  const row: OrganizationTokenRow = {
    id: newId(now),
    organizationId,
    createdById: user.id,
    name: input.name,
    tokenHash: await sha256Hex(token),
    hint: token.slice(
      ORGANIZATION_TOKEN_PREFIX.length,
      ORGANIZATION_TOKEN_PREFIX.length + HINT_LENGTH,
    ),
    permissions: copySet(input.permissions),
    metadata,
    expiresAt: expiryOf(days.value, now),
    lastUsedAt: null,
    rateLimitSeconds: window === null ? null : window.seconds,
    rateLimitMax: window === null ? null : window.max,
    remaining: quota === null ? null : quota.remaining,
    refillAmount: quota?.refillAmount ?? null,
    refillSeconds: quota?.refillSeconds ?? null,
    lastRefillAt: null,
    retiredAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const made = await config.storage.transaction(async (tx): Promise<Result<true>> => {
    // False: the organization went after the standing read.
    if (!(await lockOrganization(tx, s.value.organization))) return fail("not_found");
    // A removal that committed before the lock is seen here; a later one waits for this commit.
    const member = await tx.findOne("member", [
      { field: "organizationId", op: "eq", value: organizationId },
      { field: "userId", op: "eq", value: user.id },
    ]);
    if (!member) return fail("forbidden_rank");
    const { granted } = await effectiveIn(config, tx, organizationId, member.role);
    if (!can(granted, CREATE) || !isSubset(input.permissions, granted))
      return fail("forbidden_rank");
    // The organization's expired tokens go first, so they do not count against the cap.
    await tx.delete("organizationToken", [
      { field: "organizationId", op: "eq", value: organizationId },
      { field: "expiresAt", op: "lte", value: now },
    ]);
    const held = await tx.findMany(
      "organizationToken",
      [
        { field: "organizationId", op: "eq", value: organizationId },
        { field: "retiredAt", op: "eq", value: null },
      ],
      { limit: ORGANIZATION_TOKEN_CAP },
    );
    if (held.length >= ORGANIZATION_TOKEN_CAP) return fail("organization_token_limit");
    await tx.create("organizationToken", row);
    return ok(true);
  });
  if (!made.ok) return made;
  config.observe.emit({
    name: "api_token.create",
    kind: "to",
    tokenId: row.id,
    organizationId,
    outcome: "success",
  });
  return ok({ token, apiToken: publicOrganizationToken(row, true) });
}

/**
 * The organization's tokens, newest first, for a verified member with
 * `apiToken:read`. Storage calls: three findOne of `standing`, one findMany of
 * the tokens, and one findMany of the creators' member rows. That last read
 * runs only for a list with rows, and the cap keeps it to one chunk.
 */
export async function listOrganizationTokens(
  config: ResolvedConfig,
  input: { user: UserRow; organizationId: string },
): Promise<Result<OrganizationTokenSummary[]>> {
  if (!config.organizations) return fail("not_found");
  if (!input.user.emailVerified) return fail("email_unverified");
  const s = await standing(config, input.user, input.organizationId, READ);
  if (!s.ok) return s;
  const rows = await config.storage.findMany(
    "organizationToken",
    [{ field: "organizationId", op: "eq", value: input.organizationId }],
    {
      sort: [
        { field: "createdAt", dir: "desc" },
        { field: "id", dir: "desc" },
      ],
    },
  );
  const members = await findManyIn(
    config.storage,
    "member",
    "userId",
    rows.map((r) => r.createdById),
    [{ field: "organizationId", op: "eq", value: input.organizationId }],
  );
  const present = new Set(members.map((m) => m.userId));
  return ok(rows.map((r) => publicOrganizationToken(r, present.has(r.createdById))));
}

/**
 * Narrows a token of the organization, for a verified member with
 * `apiToken:update`, by the rules of a user token (spec 29 item 11). A token
 * of another organization answers `not_found`. The route checks the fresh
 * rule. The write is one update on `updatedAt` as read, and on the quota as
 * read when the quota changes. Zero rows answers `conflict`. Storage calls:
 * three findOne of `standing`, one findOne of the row, at most one update, and
 * one findOne of the creator's member row.
 */
export async function updateOrganizationToken(
  config: ResolvedConfig,
  input: OrganizationTokenUpdate,
): Promise<Result<OrganizationTokenSummary>> {
  if (!config.organizations) return fail("not_found");
  if (!input.user.emailVerified) return fail("email_unverified");
  if (!narrowFormed(config, input)) return fail("invalid_body");
  const s = await standing(config, input.user, input.organizationId, UPDATE);
  if (!s.ok) return s;
  const row = await config.storage.findOne("organizationToken", [
    { field: "id", op: "eq", value: input.id },
    { field: "organizationId", op: "eq", value: input.organizationId },
  ]);
  if (!row) return fail("not_found");
  // Null over the set widens the token, so narrowPatch refuses it.
  const patch = narrowPatch(row, input);
  if (!patch.ok) return patch;
  const data: Partial<Omit<OrganizationTokenRow, "id">> = patch.value;
  if (Object.keys(data).length === 0)
    return ok(publicOrganizationToken(row, await creatorIn(config, row)));
  data.updatedAt = config.clock.now();
  const n = await config.storage.update(
    "organizationToken",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "updatedAt", op: "eq", value: row.updatedAt },
      // A spend between the read and the write changes the count; the change then answers conflict.
      ...(input.quota != null
        ? [
            { field: "remaining", op: "eq", value: row.remaining } as const,
            { field: "lastRefillAt", op: "eq", value: row.lastRefillAt } as const,
          ]
        : []),
    ],
    data,
  );
  if (n === 0) return fail("conflict");
  config.observe.emit({
    name: "api_token.update",
    kind: "to",
    tokenId: row.id,
    organizationId: row.organizationId,
    outcome: "success",
  });
  const changed = { ...row, ...data };
  return ok(publicOrganizationToken(changed, await creatorIn(config, changed)));
}

/**
 * Deletes a token of the organization, for a verified member with
 * `apiToken:revoke`. The creator has no right of their own. A token of
 * another organization answers `not_found`. Storage calls: three findOne of
 * `standing` and one delete.
 */
export async function revokeOrganizationToken(
  config: ResolvedConfig,
  input: { user: UserRow; organizationId: string; id: string },
): Promise<Result<{ ok: true }>> {
  if (!config.organizations) return fail("not_found");
  if (!input.user.emailVerified) return fail("email_unverified");
  const s = await standing(config, input.user, input.organizationId, REVOKE);
  if (!s.ok) return s;
  const n = await config.storage.delete("organizationToken", [
    { field: "id", op: "eq", value: input.id },
    { field: "organizationId", op: "eq", value: input.organizationId },
  ]);
  if (n === 0) return fail("not_found");
  config.observe.emit({
    name: "api_token.revoke",
    kind: "to",
    tokenId: input.id,
    organizationId: input.organizationId,
    outcome: "success",
  });
  return ok({ ok: true });
}

/**
 * The organization and the summary of a `to_` token or of a moved key. The
 * checks run in the order of a user token. The order is the form, the hash
 * lookup, the expiry, the retired mark, the organization, the window, and the
 * spend. So a refused call spends nothing.
 * `unauthorized` for a malformed, unknown, or expired token, a token whose
 * organization is gone, and any token while organizations are off. A moved
 * key with no row answers `token_retired` (ruling 28 of plan 12k). An
 * expired row is deleted on the way out. The creator does not count: the
 * token acts for the organization (owner decision 2 of plan 12k).
 *
 * Storage calls: none for a malformed bearer. Else one findOne of the hash
 * and one findOne of the organization. Then the spend of `spendUse` runs,
 * none with no quota. One update of `lastUsedAt` runs at most once per hour.
 * Last, one findOne of the creator's member row. One limiter call runs for a
 * token with a window.
 *
 * On D1 a resolve runs at most 44 statements. It runs 4 of its own and the
 * 39 of the worst spend (20 updates and 19 reads). A cold isolate adds 1, the
 * schema version check. A D1 test holds the count at 50 or fewer, the queries
 * of one Workers Free invocation. A moved key reads the user token table
 * first, so it runs 1 more, 45 at most.
 */
export async function authenticateOrganizationToken(
  config: ResolvedConfig,
  token: string,
): Promise<Result<ResolvedOrganizationToken>> {
  const moved = movedPrefixOf(config, token);
  const formed =
    moved === undefined ? ORGANIZATION_TOKEN_RE.test(token) : movedFormed(moved, token);
  if (!config.organizations || !formed) return fail("unauthorized");
  const row = await config.storage.findOne("organizationToken", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  if (!row) return fail(moved === undefined ? "unauthorized" : "token_retired");
  const now = config.clock.now();
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    await config.storage.delete("organizationToken", [{ field: "id", op: "eq", value: row.id }]);
    return fail("unauthorized");
  }
  if (row.retiredAt !== null) return fail("token_retired");
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: row.organizationId },
  ]);
  if (!organization) return fail("unauthorized");
  if (!(await useWindow(config, "to", row))) return fail("rate_limited");
  const spent = await spendUse(config, "organizationToken", row);
  if (!spent.ok) return spent;
  let lastUsedAt = row.lastUsedAt;
  if (lastUsedDue(lastUsedAt, now)) {
    await config.storage.update("organizationToken", [{ field: "id", op: "eq", value: row.id }], {
      lastUsedAt: now,
      updatedAt: now,
    });
    lastUsedAt = now;
  }
  const used = { ...row, lastUsedAt, remaining: spent.value };
  return ok({
    organization: publicOrganization(organization),
    apiToken: publicOrganizationToken(used, await creatorIn(config, used)),
  });
}

/** The token's organization and summary, or the code of `authenticateOrganizationToken`. It spends one call. */
export function currentOrganizationToken(
  config: ResolvedConfig,
  input: { token: string },
): Promise<Result<ResolvedOrganizationToken>> {
  return authenticateOrganizationToken(config, input.token);
}
