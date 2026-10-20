import type { ResolvedConfig } from "../../config.js";
import { hasControlChar } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import type { UserRow } from "../../schema.js";
import type { Where } from "../../storage/port.js";
import { sessionIsLive } from "../sessions.js";
import { normalizeEmail, normalizeEmailPrefix } from "../users.js";
import { activeBan } from "./ban-rule.js";
import { type OperatorActor, requireScope } from "./guards.js";

/**
 * One user as an operator reads it (spec 26 item 4). It holds no password
 * hash, no sealed value, no token, no backup code, and no provider subject.
 */
export interface OperatorUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  createdAt: string;
  /** The ban while it holds, else null. */
  ban: { at: string; reason: string | null; until: string | null } | null;
  /** True when the user holds the platform role in the platform organization. */
  platformOperator: boolean;
  /** The method names of the second factor (plan 12c), never a secret. */
  secondFactor: string[];
  /** The count of live sessions, at most `SESSION_COUNT_MAX`. */
  sessions: number;
  /** The provider names of the linked identities, never a subject. */
  identities: string[];
}

/** The page size of a list and a prefix search: 1 to 100 users, 50 by default. */
export const LIST_LIMIT = { default: 50, max: 100 };

/**
 * The shortest address prefix, after the address rule. A shorter prefix
 * matches too many users to help a support person.
 */
export const PREFIX_MIN = 3;

/**
 * The highest session count that a read gives. A support person needs to
 * know "a few" or "many", not the exact count.
 */
const SESSION_COUNT_MAX = 100;

/**
 * The longest id input, the rule of `listAudit`. A core id is 26
 * characters; the compat package keeps the ids of Better Auth.
 */
const ID_MAX = 64;

type Page = { users: OperatorUser[]; next: string | null };

/** An optional id input: absent, or a string of 1 to `ID_MAX` characters with no control character. */
function idInput(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= ID_MAX &&
      !hasControlChar(value))
  );
}

/** The page size, or null for a value outside 1 to `LIST_LIMIT.max`. */
function pageLimit(value: number | undefined): number | null {
  const limit = value ?? LIST_LIMIT.default;
  return Number.isInteger(limit) && limit >= 1 && limit <= LIST_LIMIT.max ? limit : null;
}

/**
 * The checks of each read, in this order: the tool is on (else
 * `not_found`), and the actor holds the scope `users` (else
 * `operator_required`). A user actor passed `requireOperatorUser`, which
 * counts on `operator:user:<userId>`; a route counts a secret before it
 * calls a read (spec 26 item 12).
 */
function readGuard(config: ResolvedConfig, actor: OperatorActor): Result<true> {
  if (!config.operator?.users) return fail("not_found");
  return requireScope(actor, "users");
}

/**
 * One log line per read with the actor and the function name, and no
 * address and no query value (ASVS 5.0.0 16.2.5). A read writes no audit
 * row (spec 26 item 4).
 */
function logRead(actor: OperatorActor, fn: string): void {
  const actorId = actor.kind === "user" ? actor.user.id : actor.name;
  console.error("authtempo: operator read", actor.kind, actorId, fn);
}

/** The id of the platform organization, or null when the config has no platform role. */
async function platformOrganizationId(config: ResolvedConfig): Promise<string | null> {
  const o = config.organizations;
  if (!o || o.platformRole === null || o.platformOrganization === null) return null;
  const organization = await config.storage.findOne("organization", [
    { field: "slug", op: "eq", value: o.platformOrganization },
  ]);
  return organization?.id ?? null;
}

/**
 * The `OperatorUser` of each row, in the order of the rows. A call costs
 * a fixed count of storage calls, whatever the count of rows: one read
 * finds the platform organization, and one `in` read each takes the
 * member, second-factor, session, and identity rows of every user of the
 * page. That is 5 calls, or 4 with no platform role. A list or a search
 * adds its user reads, so a page costs at most 7.
 *
 * Each `in` read binds only the user ids: at most 100, the page bound.
 * The D1 limit is 100 bound parameters per query and 1000 queries per
 * invocation on Workers Paid, 50 on Workers Free (D1 limits page updated
 * 21 April 2026, read 2026-10-20). The Workers limits page (updated 12
 * October 2026, read 2026-10-20) gives Free 50 subrequests and 1,000 to
 * internal services. A page fits both Free figures.
 *
 * So the reads filter the platform organization and the live sessions
 * here, not in storage. The session read takes every session row of the
 * page users: the sweep deletes the rows past `expiresAt`, and the count
 * stops at `SESSION_COUNT_MAX`.
 */
async function operatorUsers(config: ResolvedConfig, rows: UserRow[]): Promise<OperatorUser[]> {
  if (rows.length === 0) return [];
  const storage = config.storage;
  const now = config.clock.now();
  const platformId = await platformOrganizationId(config);
  const platformRole = config.organizations?.platformRole ?? null;
  const ids = rows.map((user) => user.id);
  const [members, factors, sessions, identities] = await Promise.all([
    platformId === null
      ? []
      : storage.findMany("member", [{ field: "userId", op: "in", value: ids }]),
    storage.findMany("secondFactor", [{ field: "userId", op: "in", value: ids }]),
    storage.findMany("session", [{ field: "userId", op: "in", value: ids }]),
    storage.findMany("identity", [{ field: "userId", op: "in", value: ids }]),
  ]);
  return rows.map((user) => {
    const member = members.find((m) => m.userId === user.id && m.organizationId === platformId);
    const factor = factors.find((f) => f.userId === user.id);
    const live = sessions.filter((s) => s.userId === user.id && sessionIsLive(config, s, now));
    const providers = identities.filter((i) => i.userId === user.id).map((i) => i.provider);
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
      ban:
        user.bannedAt !== null && activeBan(user, now)
          ? {
              at: user.bannedAt.toISOString(),
              reason: user.banReason,
              until: user.banUntil?.toISOString() ?? null,
            }
          : null,
      platformOperator:
        platformRole !== null && (member?.role.split(",").includes(platformRole) ?? false),
      secondFactor: factor ? [...factor.methods] : [],
      sessions: Math.min(live.length, SESSION_COUNT_MAX),
      identities: [...new Set(providers)],
    };
  });
}

/**
 * The users by `id` ascending. For a core id (a ULID) this is about the
 * order of creation: two ids of one millisecond sort by their random part,
 * and a compat id has no time part. `after` is the `next` of the page before. `limit` is 1 to 100, default 50. The
 * read takes `limit + 1` rows, so `next` is set only when more users
 * follow. No total count: a count of every row scans the table on D1.
 * Needs `operator.users` (else `not_found`) and the scope `users`. A page
 * costs at most 6 storage calls, whatever its size (`operatorUsers`).
 */
export async function listUsers(
  config: ResolvedConfig,
  input: { actor: OperatorActor; after?: string; limit?: number },
): Promise<Result<Page>> {
  const guard = readGuard(config, input.actor);
  if (!guard.ok) return guard;
  const limit = pageLimit(input.limit);
  if (limit === null || !idInput(input.after)) return fail("invalid_body");
  logRead(input.actor, "listUsers");
  const rows = await config.storage.findMany(
    "user",
    input.after === undefined ? [] : [{ field: "id", op: "gt", value: input.after }],
    { sort: { field: "id", dir: "asc" }, limit: limit + 1 },
  );
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
  return ok({ users: await operatorUsers(config, page), next });
}

/**
 * A search by one key, exactly one of:
 *
 * - `email`: the exact address, after `normalizeEmail`. Zero or one user.
 * - `id`: the exact user id. Zero or one user.
 * - `emailPrefix`: the users whose address starts with the prefix, after
 *   `normalizeEmailPrefix`, `PREFIX_MIN` to 254 characters. By `email`,
 *   then `id`. `after` is the last id of the page before; the search reads
 *   that user's address and goes on after it. The address is unique, so
 *   the address alone orders the page. `limit` is 1 to 100, default 50,
 *   and `next` is set only when more users follow.
 *
 * Two keys, no key, or a bad value answers `invalid_body`. An `after`
 * that names no user, or a user whose address no longer starts with the
 * prefix, answers `invalid_body`: start the search again. No match answers
 * `{ users: [], next: null }`, the shape of a match.
 *
 * One race stays. When the cursor user moves to another address inside the
 * prefix between two pages, the next page starts after the new address. It
 * skips or repeats the users between the two addresses.
 *
 * Cost: a prefix search reads the whole user table on D1 and Postgres
 * (`startsWith` compiles to `substr`, which no index serves). On a table
 * of 10 000 users a miss reads 10 000 rows. `limit` bounds the rows that
 * come back, not the rows read. The per-IP limit of the route
 * (`OPERATOR_USERS_PER_IP`) and the per-user limit of a platform operator
 * bound the scans per hour. A page costs at most 7 storage calls
 * (`operatorUsers`).
 *
 * Needs `operator.users` (else `not_found`) and the scope `users`.
 */
export async function searchUsers(
  config: ResolvedConfig,
  input: {
    actor: OperatorActor;
    email?: string;
    emailPrefix?: string;
    id?: string;
    after?: string;
    limit?: number;
  },
): Promise<Result<Page>> {
  const guard = readGuard(config, input.actor);
  if (!guard.ok) return guard;
  const keys = [input.email, input.emailPrefix, input.id].filter((k) => k !== undefined);
  const limit = pageLimit(input.limit);
  if (keys.length !== 1 || limit === null || !idInput(input.after)) return fail("invalid_body");

  if (input.email !== undefined || input.id !== undefined) {
    let where: Where<"user">;
    if (input.email !== undefined) {
      const email = typeof input.email === "string" ? normalizeEmail(input.email) : null;
      if (email === null) return fail("invalid_body");
      where = { field: "email", op: "eq", value: email };
    } else {
      if (!idInput(input.id)) return fail("invalid_body");
      where = { field: "id", op: "eq", value: input.id };
    }
    logRead(input.actor, "searchUsers");
    const row = await config.storage.findOne("user", [where]);
    return ok({ users: row ? await operatorUsers(config, [row]) : [], next: null });
  }

  const prefix =
    typeof input.emailPrefix === "string" ? normalizeEmailPrefix(input.emailPrefix) : null;
  // `normalizeEmailPrefix` refuses a prefix longer than the longest address (254).
  if (prefix === null || prefix.length < PREFIX_MIN) return fail("invalid_body");
  logRead(input.actor, "searchUsers");
  const where: Where<"user">[] = [{ field: "email", op: "startsWith", value: prefix }];
  if (input.after !== undefined) {
    const last = await config.storage.findOne("user", [
      { field: "id", op: "eq", value: input.after },
    ]);
    // A cursor user who moved out of the prefix would skip the rest of the
    // prefix and answer `next: null` (review 12f Task 5 L2).
    if (!last?.email.startsWith(prefix)) return fail("invalid_body");
    where.push({ field: "email", op: "gt", value: last.email });
  }
  const rows = await config.storage.findMany("user", where, {
    sort: [
      { field: "email", dir: "asc" },
      { field: "id", dir: "asc" },
    ],
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
  return ok({ users: await operatorUsers(config, page), next });
}

/** One user by id, or `not_found`. Needs `operator.users` (else `not_found`) and the scope `users`. */
export async function getUser(
  config: ResolvedConfig,
  input: { actor: OperatorActor; userId: string },
): Promise<Result<OperatorUser>> {
  const guard = readGuard(config, input.actor);
  if (!guard.ok) return guard;
  if (input.userId === undefined || !idInput(input.userId)) return fail("invalid_body");
  logRead(input.actor, "getUser");
  const row = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: input.userId },
  ]);
  if (!row) return fail("not_found");
  const [user] = await operatorUsers(config, [row]);
  return user ? ok(user) : fail("not_found");
}
