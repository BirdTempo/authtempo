import type { CORE_STATEMENTS, RoleDef, RoleTable, Statements } from "../access.js";
import type { ResolvedConfig } from "../config.js";

export type ResolvedOrganizations = NonNullable<ResolvedConfig["organizations"]>;

/** One or more role names joined by comma. Lower case, no spaces, no empty part. */
export const ROLE_RE = /^[a-z0-9_-]{1,64}(?:,[a-z0-9_-]{1,64})*$/;

/** The highest rank among the parts; an unknown part ranks 0, so an unknown role fails closed. */
export function rankOf(ranks: Readonly<Record<string, number>>, role: string): number {
  let best = 0;
  for (const part of role.split(",")) {
    const r = Object.hasOwn(ranks, part) ? (ranks[part] ?? 0) : 0;
    if (r > best) best = r;
  }
  return best;
}

/** True when `rank` is at the owner rank or above: the member counts as an owner. */
export function isOwner(o: Pick<ResolvedOrganizations, "ranks">, rank: number): boolean {
  return rank >= (o.ranks.owner ?? Number.POSITIVE_INFINITY);
}

/**
 * True when the role string holds `part` as one of its comma parts. This is
 * the one part rule. The platform guard, the platform role acts, and
 * `roleAllowedIn` read it, so all three agree on a platform operator.
 */
export function holdsRolePart(role: string, part: string): boolean {
  return role.split(",").includes(part);
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** NFKC, then lower case, then the shape check. A look-alike such as fullwidth letters folds to ASCII, so a reserved word cannot hide behind it. */
export function normalizeSlug(raw: string): string | null {
  const s = raw.normalize("NFKC").toLowerCase();
  return SLUG_RE.test(s) ? s : null;
}

/** The platform role is valid in the platform organization only. */
export function roleAllowedIn(
  config: ResolvedOrganizations,
  role: string,
  organizationSlug: string,
): boolean {
  if (config.platformRole === null) return true;
  if (!holdsRolePart(role, config.platformRole)) return true;
  return organizationSlug === config.platformOrganization;
}

/** The role each rule needs. One table, read by every operation. */
export const RULES = {
  update: "admin",
  slugChange: "owner",
  delete: "owner",
  members: "viewer",
  addMember: "admin",
  updateRole: "admin",
  removeOther: "admin",
  invite: "admin",
  invitations: "admin",
  revoke: "admin",
} as const;

/** The rank a rule needs. A rule that names a role the table lacks needs the highest rank, so it fails closed. */
export function needs(config: ResolvedOrganizations, rule: keyof typeof RULES): number {
  return rankNeeded(config.ranks, RULES[rule]);
}

/** The rank of a role, or the highest rank when the table lacks the role. */
function rankNeeded(ranks: Readonly<Record<string, number>>, role: string): number {
  if (Object.hasOwn(ranks, role)) return ranks[role] ?? Number.POSITIVE_INFINITY;
  return Math.max(...Object.values(ranks));
}

/**
 * The statements of each plan 6 rule. `slugChange` holds `organization:update`;
 * `updateOrganization` also keeps its owner rank check by `needs(o, "slugChange")`.
 */
export const RULE_STATEMENTS: { readonly [K in keyof typeof RULES]: Statements } = {
  update: { organization: ["update"] },
  slugChange: { organization: ["update"] },
  delete: { organization: ["delete"] },
  members: { member: ["read"] },
  addMember: { member: ["create"] },
  updateRole: { member: ["update"] },
  removeOther: { member: ["delete"] },
  invite: { invitation: ["create"] },
  invitations: { invitation: ["read"] },
  revoke: { invitation: ["cancel"] },
};

/** The plan 6 role whose rank each core action needs in the `ranks` form. */
export const ACTION_ROLE: {
  readonly [R in keyof typeof CORE_STATEMENTS]: Readonly<Record<string, string>>;
} = {
  organization: { update: "admin", delete: "owner" },
  member: { read: "viewer", create: "admin", update: "admin", delete: "admin" },
  invitation: { read: "admin", create: "admin", cancel: "admin" },
  team: { create: "admin", update: "admin", delete: "admin" },
  ac: { read: "viewer", create: "admin", update: "admin", delete: "admin" },
  apiToken: { read: "admin", create: "admin", update: "admin", revoke: "admin" },
};

/**
 * The role table of the `ranks` form. Each role holds each core action whose
 * `ACTION_ROLE` role it meets by the rule of `needs`. The default derivation
 * equals plan 6: test/default-table.test.ts proves it on two rank tables.
 */
export function deriveRoles(ranks: Readonly<Record<string, number>>): RoleTable {
  const table: typeof ACTION_ROLE = ACTION_ROLE;
  const roles = new Map<string, RoleDef>();
  for (const [name, rank] of Object.entries(ranks)) {
    const permissions = new Map<string, string[]>();
    for (const [resource, actions] of Object.entries(table)) {
      const held = Object.entries(actions)
        .filter(([, role]) => rank >= rankNeeded(ranks, role))
        .map(([action]) => action);
      if (held.length > 0) permissions.set(resource, held);
    }
    roles.set(name, { rank, permissions: Object.fromEntries(permissions) });
  }
  // fromEntries defines each key as an own property, so a role name such as `__proto__` stays data.
  return Object.fromEntries(roles);
}
