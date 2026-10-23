import { scimCallerOf } from "../../compat-seams.js";
import type { ResolvedConfig } from "../../config.js";
import { ERRORS } from "../../errors.js";
import { ipKey } from "../../limiter/ip-key.js";
import { SCIM_TOKEN_PREFIX } from "../../primitives/credentials.js";
import { randomToken, sha256Hex } from "../../primitives/crypto.js";
import { newId } from "../../primitives/ids.js";
import { hasControlChar } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import type { OperatorAuditRow, ScimScope, ScimTokenRow } from "../../schema.js";
import { writeAuditIn } from "../operator/audit.js";
import { afterAudit, type SsoActMeta } from "../sso/domains.js";
import { type SsoActor, ssoDraft } from "../sso/guard.js";
import { lockOrganization } from "../teams.js";
import { tokenHint } from "../tokens.js";

/**
 * The SCIM tokens of an organization (plan 12d Task 9, spec 30 item 17).
 * A directory sends one as its bearer. A SCIM token is a credential. Core
 * stores its SHA-256 only and finds the row by that hash. It never logs the
 * token or the hash, and never puts either in an audit row. The token is hashed,
 * not sealed, so the secret rewrap of plan 12b has nothing of it to move.
 * Only the SCIM routes read it: no other lookup of core reads this table.
 */

// The prefix lives with the other credential facts (primitives/credentials.ts); still exported here.
export { SCIM_TOKEN_PREFIX };
/** `sk_` and 32 random bytes as base64url, the form of `randomToken`. */
export const SCIM_TOKEN_RE = /^sk_[A-Za-z0-9_-]{43}$/;
export const SCIM_SCOPES: readonly ScimScope[] = Object.freeze([
  "scim.users.read",
  "scim.users.write",
  "scim.groups.read",
  "scim.groups.write",
]);
/**
 * The live tokens of one organization: the one in use and the next one of a
 * rollover. An expired token does not count.
 */
export const SCIM_TOKENS_LIVE_MAX = 2;
/**
 * The most rows of one list: 100. An organization holds at most 2 live
 * tokens, and the sweep deletes each expired row. A token lives one day at
 * least, so 100 rows need about 49 days with no sweep. The list reads the
 * live tokens first, so each live token stays in it past the bound.
 */
export const SCIM_TOKENS_LIST_MAX = 100;
/**
 * The failed SCIM auth checks of one IP: 60 per 15 minutes (deviation 18).
 * A token holds 256 random bits, so no count makes a guess likely. The
 * limit bounds the work of a flood: each failure costs one hash lookup.
 * A valid token never counts here, so a directory that sends bursts from
 * few addresses is not throttled by its own calls.
 */
export const SCIM_AUTH_FAILURES = { seconds: 900, max: 60 };
/** The calls of one token: 1200 per 10 minutes. Task 12 reads the burst sizes of Entra ID and Okta. */
export const SCIM_PER_TOKEN = { seconds: 600, max: 1200 };

const NAME_MAX = 64;
const EXPIRES_IN_DAYS_MAX = 730;
const DAY_MS = 86_400_000;
/** A directory calls in bursts: the row must not take one write per call. */
const LAST_USED_EVERY_MS = 60_000;

/** The token of a SCIM request: its organization comes from the row, never from the path or the body. */
export interface ScimCaller {
  tokenId: string;
  tokenName: string;
  organizationId: string;
  scopes: ReadonlySet<ScimScope>;
}

/** One token as a list answers it. It never holds the token or its hash. */
export interface ScimTokenSummary {
  id: string;
  name: string;
  hint: string;
  scopes: ScimScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** The answer form of a row. It names each field, so the hash never reaches an answer. */
function publicScimToken(row: ScimTokenRow): ScimTokenSummary {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint,
    scopes: [...row.scopes],
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/** `invalid_body` with a message that names the field. */
function refuse(message: string): Result<never> {
  return { ok: false, code: "invalid_body", status: ERRORS.invalid_body, message };
}

/** `not_found` while SCIM is off. */
function scimOn(config: ResolvedConfig): Result<true> {
  return config.scim ? ok(true) : fail("not_found");
}

/** The scopes of an input: absent gives all four; else a non-empty list of distinct scopes. */
function checkScopes(value: unknown): Result<ScimScope[]> {
  if (value === undefined) return ok([...SCIM_SCOPES]);
  const rule = `scopes must be a non-empty list of distinct scopes of ${SCIM_SCOPES.join(", ")}`;
  if (!Array.isArray(value) || value.length === 0) return refuse(rule);
  if (!value.every((s) => (SCIM_SCOPES as readonly unknown[]).includes(s))) return refuse(rule);
  if (new Set(value).size !== value.length) return refuse(rule);
  return ok([...(value as ScimScope[])]);
}

/**
 * Creates a SCIM token (plan 12d Task 9 Behavior 2). A route runs the
 * manager guard first; the app calls it through `api.scim.tokens`. One
 * transaction locks the organization row, counts the live tokens against
 * `SCIM_TOKENS_LIVE_MAX` (`token_limit`), writes the row, and writes the
 * `scim_token_create` audit row. The answer holds the clear token, the one
 * time it leaves core.
 */
export async function createScimToken(
  config: ResolvedConfig,
  actor: SsoActor,
  input: {
    organizationId: string;
    name: string;
    scopes?: ScimScope[] | undefined;
    expiresInDays?: number | undefined;
  },
  meta: SsoActMeta = {},
): Promise<Result<{ token: string; id: string; hint: string }>> {
  const on = scimOn(config);
  if (!on.ok) return on;
  const name: unknown = input.name;
  if (typeof name !== "string" || name.length < 1 || name.length > NAME_MAX || hasControlChar(name))
    return refuse(`name must be 1 to ${NAME_MAX} characters with no control character`);
  const scopes = checkScopes(input.scopes);
  if (!scopes.ok) return scopes;
  const days: unknown = input.expiresInDays;
  if (
    days !== undefined &&
    (typeof days !== "number" ||
      !Number.isSafeInteger(days) ||
      days < 1 ||
      days > EXPIRES_IN_DAYS_MAX)
  )
    return refuse(`expiresInDays must be an integer from 1 to ${EXPIRES_IN_DAYS_MAX}`);
  const now = config.clock.now();
  const token = randomToken(SCIM_TOKEN_PREFIX);
  const row: ScimTokenRow = {
    id: newId(now),
    createdAt: now,
    updatedAt: now,
    organizationId: input.organizationId,
    name,
    tokenHash: await sha256Hex(token),
    hint: tokenHint(SCIM_TOKEN_PREFIX, token),
    scopes: scopes.value,
    expiresAt: typeof days === "number" ? new Date(now.getTime() + days * DAY_MS) : null,
    lastUsedAt: null,
  };
  const created = await config.storage.transaction(
    async (tx): Promise<Result<OperatorAuditRow>> => {
      const organization = await tx.findOne("organization", [
        { field: "id", op: "eq", value: input.organizationId },
      ]);
      // The lock holds the count below against a parallel create (the 12k limit form).
      if (!organization || !(await lockOrganization(tx, organization))) return fail("not_found");
      // The port has no OR: the tokens with no expiry, then the tokens that expire after now.
      const at = { field: "organizationId", op: "eq", value: organization.id } as const;
      const live = [
        ...(await tx.findMany("scimToken", [at, { field: "expiresAt", op: "eq", value: null }], {
          limit: SCIM_TOKENS_LIVE_MAX,
        })),
        ...(await tx.findMany("scimToken", [at, { field: "expiresAt", op: "gt", value: now }], {
          limit: SCIM_TOKENS_LIVE_MAX,
        })),
      ];
      if (live.length >= SCIM_TOKENS_LIVE_MAX) return fail("token_limit");
      await tx.create("scimToken", row);
      const draft = ssoDraft(actor, "scim_token_create", {
        targetUserId: null,
        data: { organizationId: row.organizationId, tokenId: row.id, name, scopes: row.scopes },
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      if (!draft.ok) return draft;
      return ok(await writeAuditIn(tx, draft.value, now));
    },
  );
  if (!created.ok) return created;
  await afterAudit(config, created.value);
  return ok({ token, id: row.id, hint: row.hint });
}

/**
 * The tokens of an organization, at most `SCIM_TOKENS_LIST_MAX`, oldest
 * first. The live tokens come first, then the newest expired rows fill the
 * rest. A token with no expiry thus stays in the list after many expired
 * rows. An organization that does not exist answers `not_found`.
 */
export async function listScimTokens(
  config: ResolvedConfig,
  _actor: SsoActor,
  input: { organizationId: string },
): Promise<Result<ScimTokenSummary[]>> {
  const on = scimOn(config);
  if (!on.ok) return on;
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: input.organizationId },
  ]);
  if (!organization) return fail("not_found");
  const now = config.clock.now();
  // The port has no OR: the same two live reads as createScimToken.
  const at = { field: "organizationId", op: "eq", value: organization.id } as const;
  const live = [
    ...(await config.storage.findMany(
      "scimToken",
      [at, { field: "expiresAt", op: "eq", value: null }],
      { limit: SCIM_TOKENS_LIVE_MAX },
    )),
    ...(await config.storage.findMany(
      "scimToken",
      [at, { field: "expiresAt", op: "gt", value: now }],
      {
        limit: SCIM_TOKENS_LIVE_MAX,
      },
    )),
  ].slice(0, SCIM_TOKENS_LIVE_MAX);
  const expired = await config.storage.findMany(
    "scimToken",
    [at, { field: "expiresAt", op: "lte", value: now }],
    { sort: { field: "id", dir: "desc" }, limit: SCIM_TOKENS_LIST_MAX - live.length },
  );
  const rows = [...live, ...expired].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ok(rows.map(publicScimToken));
}

/** The organization of a token, or null when no row has the id. A route reads it for the manager guard. */
export async function scimTokenOrganization(
  config: ResolvedConfig,
  id: string,
): Promise<string | null> {
  if (!config.scim) return null;
  const row = await config.storage.findOne("scimToken", [{ field: "id", op: "eq", value: id }]);
  return row?.organizationId ?? null;
}

/** Deletes a token and writes `scim_token_revoke` in one transaction. The next call with it answers 401. */
export async function revokeScimToken(
  config: ResolvedConfig,
  actor: SsoActor,
  input: { id: string },
  meta: SsoActMeta = {},
): Promise<Result<{ ok: true }>> {
  const on = scimOn(config);
  if (!on.ok) return on;
  const now = config.clock.now();
  const revoked = await config.storage.transaction(
    async (tx): Promise<Result<OperatorAuditRow>> => {
      const row = await tx.findOne("scimToken", [{ field: "id", op: "eq", value: input.id }]);
      if (!row) return fail("not_found");
      const n = await tx.delete("scimToken", [{ field: "id", op: "eq", value: row.id }]);
      if (n === 0) return fail("not_found");
      const draft = ssoDraft(actor, "scim_token_revoke", {
        targetUserId: null,
        data: { organizationId: row.organizationId, tokenId: row.id, name: row.name },
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      if (!draft.ok) return draft;
      return ok(await writeAuditIn(tx, draft.value, now));
    },
  );
  if (!revoked.ok) return revoked;
  await afterAudit(config, revoked.value);
  return ok({ ok: true });
}

/** `Authorization: Bearer <token>`: the scheme in any case (RFC 7235 section 2.1), one space, one token. */
const BEARER_RE = /^Bearer ([^ ]+)$/i;

/**
 * The auth check of each SCIM route (plan 12d Task 9 Behavior 3, deviation
 * 18). The order: the form of the header and the token, then one lookup by
 * the SHA-256 of the token, then the expiry. A failure at any step counts
 * once on `scim-auth:ip:<ip>` and answers 401, or 429 when that count is
 * refused. A pass counts on `scim:token:<id>` and never on the IP key; a
 * refused count answers 429. `lastUsedAt` moves by one conditional update,
 * only when it is null or older than 60 seconds. A caller that
 * `scimRequestAs` set skips the token steps and counts on its own key.
 */
export async function authenticateScim(
  config: ResolvedConfig,
  request: Request,
  ip: string | null,
): Promise<{ ok: true; caller: ScimCaller } | { ok: false; status: 401 | 429 }> {
  const failed = async (): Promise<{ ok: false; status: 401 | 429 }> => ({
    ok: false,
    status: (await config.limiter.allow(`scim-auth:ip:${ipKey(ip)}`, SCIM_AUTH_FAILURES))
      ? 401
      : 429,
  });
  // A caller that a compat package checked (plan 12d Task 14): the limit of its credential, no row.
  const checked = scimCallerOf(request);
  if (checked !== null)
    return (await config.limiter.allow(`scim:token:${checked.tokenId}`, SCIM_PER_TOKEN))
      ? { ok: true, caller: checked }
      : { ok: false, status: 429 };
  const token = BEARER_RE.exec(request.headers.get("authorization") ?? "")?.[1];
  if (token === undefined || !SCIM_TOKEN_RE.test(token)) return failed();
  const row = await config.storage.findOne("scimToken", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  const now = config.clock.now();
  if (!row || (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime())) return failed();
  if (!(await config.limiter.allow(`scim:token:${row.id}`, SCIM_PER_TOKEN)))
    return { ok: false, status: 429 };
  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS)
    // The where holds the value that was read, so two parallel calls write one update.
    await config.storage.update(
      "scimToken",
      [
        { field: "id", op: "eq", value: row.id },
        { field: "lastUsedAt", op: "eq", value: row.lastUsedAt },
      ],
      { lastUsedAt: now, updatedAt: now },
    );
  return {
    ok: true,
    caller: {
      tokenId: row.id,
      tokenName: row.name,
      organizationId: row.organizationId,
      scopes: new Set(row.scopes),
    },
  };
}
