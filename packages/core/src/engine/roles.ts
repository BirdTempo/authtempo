import { isSubset, type Statements, statementFault, union } from "../access.js";
import type { ResolvedConfig } from "../config.js";
import type { Observer } from "../observe/observer.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { OrganizationRoleRow, UserRow } from "../schema.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";
import { standing } from "./organizations.js";
import { grantCheck, roleRowDef, type Standing } from "./permissions.js";
import { type ResolvedOrganizations, ROLE_RE } from "./ranks.js";
import { lockOrganization } from "./teams.js";

/**
 * Dynamic roles (plan 12k, spec 29 item 6). An organization stores its own
 * roles beside the roles of the config. `effectiveIn` reads them at each
 * call, so no answer here is cached. Each operation answers `not_found`
 * while `organizations.dynamicRoles` is off.
 */

/** One stored role of an organization. */
export interface RoleSummary {
  id: string;
  name: string;
  rank: number;
  permissions: Statements;
  createdAt: Date;
  updatedAt: Date;
}

/** The most rows that the list reads: the top of the `maxPerOrganization` range. */
const LIST_MAX = 1000;

interface Scope {
  o: ResolvedOrganizations;
  max: number;
}

function scope(config: ResolvedConfig): Scope | null {
  const o = config.organizations;
  if (!o || o.dynamicRoles === null) return null;
  return { o, max: o.dynamicRoles.maxPerOrganization };
}

/** The summary of a row with a good shape, or null after the one warn line of rule 7. */
function summaryOf(
  observe: Observer,
  o: ResolvedOrganizations,
  row: OrganizationRoleRow,
): RoleSummary | null {
  const def = roleRowDef(o, row);
  if (def === null) {
    observe.emit({ name: "role.row_invalid", rowId: row.id });
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    rank: def.rank,
    permissions: def.permissions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The standing of a stored row. A row with a bad shape grants nothing, so it ranks 0. */
function rowStanding(o: ResolvedOrganizations, row: OrganizationRoleRow): Standing {
  const def = roleRowDef(o, row);
  return def === null ? { rank: 0, granted: {} } : { rank: def.rank, granted: def.permissions };
}

/** One part of the role rule: `ROLE_RE` with no comma. */
function oneRoleName(name: string): boolean {
  return typeof name === "string" && ROLE_RE.test(name) && !name.includes(",");
}

/**
 * Rule 1: a stored name is never a role of the config, the platform role, or
 * `owner`. So a stored row never widens a static role.
 */
function storableName(o: ResolvedOrganizations, name: string): boolean {
  // The config must name owner, and the platform role must be a role of the config, so one check refuses all three.
  return oneRoleName(name) && !Object.hasOwn(o.roles, name);
}

/**
 * Rules 2 and 3 for the rank and the permissions of a role that the caller
 * writes. The rank is an integer from 1 to the caller's rank and below the
 * owner rank (`invalid_body`). The permissions are known names
 * (`invalid_body`) and a subset of the caller's (`forbidden_rank`).
 */
function grantableDef(
  o: ResolvedOrganizations,
  caller: Standing,
  rank: unknown,
  permissions: unknown,
): Result<{ rank: number; permissions: Statements }> {
  if (typeof rank !== "number" || !Number.isSafeInteger(rank) || rank < 1)
    return fail("invalid_body");
  if (rank > caller.rank) return fail("invalid_body");
  // A dynamic role never has the owner rank, so the last-owner rule reads the config only.
  if (rank >= (o.ranks.owner ?? 0)) return fail("invalid_body");
  if (statementFault(permissions, o.statements) !== null) return fail("invalid_body");
  const set = union(permissions as Statements);
  if (!isSubset(set, caller.granted)) return fail("forbidden_rank");
  return ok({ rank, permissions: set });
}

async function findRole(
  config: ResolvedConfig,
  organizationId: string,
  name: string,
): Promise<OrganizationRoleRow | null> {
  return config.storage.findOne("organizationRole", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "name", op: "eq", value: name },
  ]);
}

/**
 * The stored roles of an organization, sorted by name. Needs `ac:read`. A row
 * with a bad shape is left out and writes one warn line.
 *
 * Cost: one storage call that reads at most 1000 rows. The cap of the
 * create bounds the rows; a D1 race of spec 8.6 can pass it by a few.
 */
export async function listRoles(
  config: ResolvedConfig,
  input: { user: UserRow; organizationId: string },
): Promise<Result<RoleSummary[]>> {
  const sc = scope(config);
  if (!sc) return fail("not_found");
  const s = await standing(config, input.user, input.organizationId, { ac: ["read"] });
  if (!s.ok) return s;
  const rows = await config.storage.findMany(
    "organizationRole",
    [{ field: "organizationId", op: "eq", value: input.organizationId }],
    {
      sort: [
        { field: "name", dir: "asc" },
        { field: "id", dir: "asc" },
      ],
      limit: LIST_MAX,
    },
  );
  return ok(rows.flatMap((row) => summaryOf(config.observe, sc.o, row) ?? []));
}

/** One stored role by name. Needs `ac:read`. An unknown name or a row with a bad shape answers `not_found`. */
export async function getRole(
  config: ResolvedConfig,
  input: { user: UserRow; organizationId: string; name: string },
): Promise<Result<RoleSummary>> {
  const sc = scope(config);
  if (!sc) return fail("not_found");
  const s = await standing(config, input.user, input.organizationId, { ac: ["read"] });
  if (!s.ok) return s;
  if (!oneRoleName(input.name)) return fail("invalid_body");
  const row = await findRole(config, input.organizationId, input.name);
  const summary = row ? summaryOf(config.observe, sc.o, row) : null;
  return summary ? ok(summary) : fail("not_found");
}

/** True when a part of the comma-joined role string is the name. */
function holds(role: string, name: string): boolean {
  return role.split(",").includes(name);
}

/**
 * True while a member row of the organization or a pending invitation holds
 * the name as a part of its role string. `tx` is the open transaction.
 *
 * Cost: two storage calls. The port has no part match. So the check reads
 * every member row and every pending invitation of the organization, and N
 * members cost one read of N rows. The limits `membersPerOrganization` and
 * `pendingInvitationsPerOrganization` bound them when they are set.
 */
async function heldInside(
  tx: StorageAdapter,
  organizationId: string,
  name: string,
  now: Date,
): Promise<boolean> {
  const members = await tx.findMany("member", [
    { field: "organizationId", op: "eq", value: organizationId },
  ]);
  if (members.some((m) => holds(m.role, name))) return true;
  const pending = await tx.findMany("invitation", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "acceptedAt", op: "eq", value: null },
    { field: "expiresAt", op: "gt", value: now },
  ]);
  return pending.some((i) => holds(i.role, name));
}

/**
 * Stores a role. Needs `ac:create`. Rules 1 to 3 check the name, the rank,
 * and the permissions. Rule 8: the cap counts the rows inside the
 * transaction, after the lock of the organization row (`lockOrganization`)
 * and before the write. On Postgres a second create waits at the lock and
 * then counts the committed rows (ruling 43). D1 transactions are not
 * isolated (spec 8.6), so on D1 two creates at one moment can both pass the
 * count.
 *
 * A part that a member or a pending invitation holds answers `role_in_use`.
 * Such a part comes from a grant made while dynamic roles were off, or from
 * a role that the config no longer names. A create would else give its
 * holder rights that no caller granted (ruling 24 M1).
 */
export async function createRole(
  config: ResolvedConfig,
  input: {
    user: UserRow;
    organizationId: string;
    name: string;
    rank?: number;
    permissions: Statements;
  },
): Promise<Result<RoleSummary>> {
  const sc = scope(config);
  if (!sc) return fail("not_found");
  const s = await standing(config, input.user, input.organizationId, { ac: ["create"] });
  if (!s.ok) return s;
  if (!storableName(sc.o, input.name)) return fail("invalid_body");
  const def = grantableDef(sc.o, s.value, input.rank ?? 1, input.permissions);
  if (!def.ok) return def;
  const now = config.clock.now();
  const row: OrganizationRoleRow = {
    id: newId(now),
    organizationId: input.organizationId,
    name: input.name,
    rank: def.value.rank,
    permissions: def.value.permissions,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const written = await config.storage.transaction(async (tx): Promise<Result<true>> => {
      // False: the organization went after the standing read.
      if (!(await lockOrganization(tx, s.value.organization))) return fail("not_found");
      // The unique key stays the guard for a race.
      if (
        await tx.findOne("organizationRole", [
          { field: "organizationId", op: "eq", value: input.organizationId },
          { field: "name", op: "eq", value: input.name },
        ])
      )
        return fail("role_taken");
      if (await heldInside(tx, input.organizationId, input.name, now)) return fail("role_in_use");
      const held = await tx.findMany(
        "organizationRole",
        [{ field: "organizationId", op: "eq", value: input.organizationId }],
        { limit: sc.max },
      );
      if (held.length >= sc.max) return fail("role_limit");
      await tx.create("organizationRole", row);
      return ok(true);
    });
    if (!written.ok) return written;
  } catch (err) {
    // Caught outside the transaction: inside, Postgres has already aborted it.
    if (err instanceof StorageError && err.code === "unique_violation") return fail("role_taken");
    throw err;
  }
  return ok({
    id: row.id,
    name: row.name,
    rank: def.value.rank,
    permissions: def.value.permissions,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Changes the rank or the permissions of a stored role. Needs `ac:update`.
 * The caller must pass the grant check on the role as it is and as it
 * becomes. A narrow applies at the next request, because no role is cached.
 *
 * The write compares `updatedAt` with the read and sets a new stamp. So an
 * update that read the row before a parallel update answers `conflict`, and
 * never writes back a set that the other update narrowed.
 */
export async function updateRole(
  config: ResolvedConfig,
  input: {
    user: UserRow;
    organizationId: string;
    name: string;
    rank?: number;
    permissions?: Statements;
  },
): Promise<Result<RoleSummary>> {
  const sc = scope(config);
  if (!sc) return fail("not_found");
  const s = await standing(config, input.user, input.organizationId, { ac: ["update"] });
  if (!s.ok) return s;
  if (!oneRoleName(input.name)) return fail("invalid_body");
  const row = await findRole(config, input.organizationId, input.name);
  if (!row) return fail("not_found");
  if (!grantCheck(s.value, rowStanding(sc.o, row))) return fail("forbidden_rank");
  const def = grantableDef(
    sc.o,
    s.value,
    input.rank ?? row.rank,
    input.permissions ?? row.permissions,
  );
  if (!def.ok) return def;
  // One millisecond past the read, so the stamp changes even when the clock has not moved.
  const now = new Date(Math.max(config.clock.now().getTime(), row.updatedAt.getTime() + 1));
  const n = await config.storage.update(
    "organizationRole",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "updatedAt", op: "eq", value: row.updatedAt },
    ],
    {
      rank: def.value.rank,
      permissions: def.value.permissions,
      updatedAt: now,
    },
  );
  // Zero rows: another update or a delete ran after the read.
  if (n === 0)
    return (await findRole(config, input.organizationId, input.name))
      ? fail("conflict")
      : fail("not_found");
  return ok({
    id: row.id,
    name: row.name,
    rank: def.value.rank,
    permissions: def.value.permissions,
    createdAt: row.createdAt,
    updatedAt: now,
  });
}

/**
 * Deletes a stored role. Needs `ac:delete` and the grant check on the role.
 * Rule 5: `role_in_use` while a member row of the organization or a pending
 * invitation holds the name as a part of its role string.
 *
 * Cost: three storage calls in one transaction (see `heldInside`). A grant
 * of the name that a parallel request makes after the check holds a part
 * that no table names. A later create of the name answers `role_in_use` for
 * it, so the part never gets rights.
 */
export async function deleteRole(
  config: ResolvedConfig,
  input: { user: UserRow; organizationId: string; name: string },
): Promise<Result<{ ok: true }>> {
  const sc = scope(config);
  if (!sc) return fail("not_found");
  const s = await standing(config, input.user, input.organizationId, { ac: ["delete"] });
  if (!s.ok) return s;
  if (!oneRoleName(input.name)) return fail("invalid_body");
  const row = await findRole(config, input.organizationId, input.name);
  if (!row) return fail("not_found");
  if (!grantCheck(s.value, rowStanding(sc.o, row))) return fail("forbidden_rank");
  const now = config.clock.now();
  return config.storage.transaction(async (tx): Promise<Result<{ ok: true }>> => {
    if (await heldInside(tx, input.organizationId, input.name, now)) return fail("role_in_use");
    const n = await tx.delete("organizationRole", [{ field: "id", op: "eq", value: row.id }]);
    return n === 0 ? fail("not_found") : ok({ ok: true as const });
  });
}
