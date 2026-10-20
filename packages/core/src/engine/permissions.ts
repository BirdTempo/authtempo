import {
  can,
  effectiveOf,
  intersect,
  isSubset,
  type RoleDef,
  type Statements,
  statementFault,
  union,
} from "../access.js";
import type { ResolvedConfig } from "../config.js";
import { fail, ok, type Result } from "../result.js";
import type { MemberRow, OrganizationRoleRow } from "../schema.js";
import { type ResolvedOrganizations, rankOf } from "./ranks.js";
import type { Caller } from "./tokens.js";

/** The rank and the statements of one role string in one organization (plan 12k, spec 29 item 5). */
export interface Standing {
  rank: number;
  granted: Statements;
}

/**
 * The rank and the statements of a role string in one organization: static
 * parts from the config, other parts from the organization's role rows
 * (spec 29 item 6). No cache: each call reads the rows of now, so a narrow
 * applies at the next request (rule 6).
 *
 * Cost: one storage call when dynamic roles are on and the role string has a
 * part that the config does not name; else none. The read names those parts
 * with `in`, and the unique key (organizationId, name) gives at most one row
 * per part. So the read never grows with the members or the roles of the
 * organization.
 *
 * A row with a bad shape grants nothing (rule 7). The shim's in-place table
 * holds rows that Better Auth wrote, so any text can be there. Core writes
 * one warn line with the row id per read, and never the permissions.
 */
export async function effectiveIn(
  config: ResolvedConfig,
  organizationId: string,
  role: string,
): Promise<Standing> {
  const o = config.organizations;
  if (!o) return { rank: 0, granted: {} };
  let rank = rankOf(o.ranks, role);
  const granted = effectiveOf(role, o.roles);
  if (o.dynamicRoles === null) return { rank, granted };
  const unknown = [...new Set(role.split(","))].filter((part) => !Object.hasOwn(o.roles, part));
  if (unknown.length === 0) return { rank, granted };
  const rows = await config.storage.findMany(
    "organizationRole",
    [
      { field: "organizationId", op: "eq", value: organizationId },
      { field: "name", op: "in", value: unknown },
    ],
    { limit: unknown.length },
  );
  const sets: Statements[] = [granted];
  for (const row of rows) {
    const def = roleRowDef(o, row);
    if (def === null) {
      console.warn(`authtempo: role row invalid ${row.id}`);
      continue;
    }
    if (def.rank > rank) rank = def.rank;
    sets.push(def.permissions);
  }
  return { rank, granted: union(...sets) };
}

/**
 * The rank and the permissions of a stored role row, or null when its shape
 * is bad. A bad shape is permissions that fail `statementFault`, or a rank
 * that is not a safe integer from 1 to below the owner rank.
 */
export function roleRowDef(o: ResolvedOrganizations, row: OrganizationRoleRow): RoleDef | null {
  const ownerRank = o.ranks.owner ?? 0;
  if (typeof row.rank !== "number" || !Number.isSafeInteger(row.rank)) return null;
  if (row.rank < 1 || row.rank >= ownerRank) return null;
  if (statementFault(row.permissions, o.statements) !== null) return null;
  return { rank: row.rank, permissions: union(row.permissions as Statements) };
}

/** A caller grants a role only when its rank is at most the caller's and its statements are a subset of the caller's. */
export function grantCheck(caller: Standing, target: Standing): boolean {
  return target.rank <= caller.rank && isSubset(target.granted, caller.granted);
}

/** A caller changes or removes a member only under the same two conditions. */
export function touchCheck(caller: Standing, target: Standing): boolean {
  return grantCheck(caller, target);
}

export interface PermissionInput {
  organizationId: string;
  permissions: Statements;
}

/** The member row of `userId` in a live organization, or null. */
async function memberIn(
  config: ResolvedConfig,
  organizationId: string,
  userId: string,
): Promise<MemberRow | null> {
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization) return null;
  return config.storage.findOne("member", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "userId", op: "eq", value: userId },
  ]);
}

/**
 * The caller's role in the organization and its effective set, by the table
 * of spec 29 item 9. A caller with no rights there gets a null role and the
 * empty set. Every read is a read of now: nothing is cached across requests.
 */
async function effectiveFor(
  config: ResolvedConfig,
  caller: Caller,
  organizationId: string,
): Promise<{ role: string | null; permissions: Statements }> {
  const none = { role: null, permissions: {} };
  switch (caller.kind) {
    case "session": {
      const member = await memberIn(config, organizationId, caller.user.id);
      if (!member) return none;
      return {
        role: member.role,
        permissions: (await effectiveIn(config, organizationId, member.role)).granted,
      };
    }
    case "token": {
      // A token bound to one organization acts in that one only.
      if (caller.activeOrganizationId !== null && caller.activeOrganizationId !== organizationId)
        return none;
      const member = await memberIn(config, organizationId, caller.user.id);
      if (!member) return none;
      // The row of now: a token that was revoked since its resolve grants nothing.
      const row = await config.storage.findOne("apiToken", [
        { field: "id", op: "eq", value: caller.apiToken.id },
      ]);
      if (!row) return none;
      const role = (await effectiveIn(config, organizationId, member.role)).granted;
      return {
        role: member.role,
        permissions: row.permissions === null ? role : intersect(role, row.permissions),
      };
    }
    // An app checks the scopes of an OAuth access token itself.
    case "oauth":
    case "oauth-client":
      return none;
  }
}

/**
 * True when the caller holds every permission in the organization. False,
 * never a throw, on any failure: organizations off, an unknown organization,
 * no member row, a storage error, or a request that `can` refuses.
 */
export async function hasPermission(
  config: ResolvedConfig,
  caller: Caller,
  input: PermissionInput,
): Promise<boolean> {
  try {
    if (!config.organizations) return false;
    const { permissions } = await effectiveFor(config, caller, input.organizationId);
    return can(permissions, input.permissions);
  } catch {
    return false;
  }
}

/**
 * The caller's role string and effective set in one organization, so a page
 * can hide what the person cannot do. A non-member gets `role: null` and the
 * empty set. `not_found` with organizations off or for an unknown organization.
 */
export async function permissionsOf(
  config: ResolvedConfig,
  caller: Caller,
  organizationId: string,
): Promise<Result<{ role: string | null; permissions: Statements }>> {
  if (!config.organizations) return fail("not_found");
  const organization = await config.storage.findOne("organization", [
    { field: "id", op: "eq", value: organizationId },
  ]);
  if (!organization) return fail("not_found");
  return ok(await effectiveFor(config, caller, organizationId));
}
