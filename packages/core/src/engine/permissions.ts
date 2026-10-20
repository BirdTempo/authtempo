import { can, effectiveOf, intersect, isSubset, type Statements } from "../access.js";
import type { ResolvedConfig } from "../config.js";
import { fail, ok, type Result } from "../result.js";
import type { MemberRow } from "../schema.js";
import { rankOf } from "./ranks.js";
import type { Caller } from "./tokens.js";

/** The rank and the statements of one role string in one organization (plan 12k, spec 29 item 5). */
export interface Standing {
  rank: number;
  granted: Statements;
}

/**
 * The rank and the statements of a role string in one organization: static
 * parts from the config, other parts from the organization's role rows. The
 * role rows come with Task 4 of plan 12k. Until then this reads the static
 * table only, so `organizationId` does not change the answer yet.
 */
export async function effectiveIn(
  config: ResolvedConfig,
  _organizationId: string,
  role: string,
): Promise<Standing> {
  const o = config.organizations;
  if (!o) return { rank: 0, granted: {} };
  return { rank: rankOf(o.ranks, role), granted: effectiveOf(role, o.roles) };
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
