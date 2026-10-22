/**
 * The SCIM role map (plan 12d Task 11 Behavior 2). The connection's
 * `scimRoles` maps a group name to a role of the organization. A member of
 * mapped groups gets the highest-ranked role of them, else
 * `scim.defaultRole`. SCIM never gives the owner role or the platform role.
 * The group writes (groups.ts) and the reactivate of a User (users.ts) read
 * the role here, so neither imports the other.
 */

import type { ResolvedConfig } from "../../config.js";
import type { ScimGroupRow } from "../../schema.js";
import { findManyIn } from "../../storage/batch.js";
import type { StorageAdapter } from "../../storage/port.js";
import { stopWith } from "../hooks.js";
import { roleRowDef } from "../permissions.js";
import { holdsRolePart, isOwner, rankOf } from "../ranks.js";
import { roleMapConnection } from "../sso/connections.js";
import { scimKey } from "./filter.js";

/** The role map of an organization, with the rank of each role and the roles that are gone. */
export interface RoleMapFacts {
  map: Readonly<Record<string, string>>;
  /** The role of each group name in its key form (`scimKey`). */
  byKey: ReadonlyMap<string, string>;
  /** The rank of each role of the map: a static role, or the row of a dynamic one. */
  ranks: ReadonlyMap<string, number>;
  /** The roles of the map with a part that the organization no longer has (ruling 25 N2). */
  gone: ReadonlySet<string>;
}

/** The map by the key form of each group name. Two names of one key form: the first by name order wins. */
function keyedMap(map: Readonly<Record<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, role] of Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const key = scimKey(name);
    if (!out.has(key)) out.set(key, role);
  }
  return out;
}

/**
 * The highest-ranked role of the mapped groups that the user is in, else
 * `scim.defaultRole`. Never owner, never the platform role. The groups go
 * in name order, and a tie keeps the first role by name order. `ranks`
 * holds the rank of a dynamic role; a static role ranks by the role table.
 */
export function roleFromGroups(
  config: ResolvedConfig,
  map: Readonly<Record<string, string>> | null,
  groupNames: readonly string[],
  ranks: ReadonlyMap<string, number> = new Map(),
): string {
  const o = config.organizations;
  const fallback = config.scim?.defaultRole ?? "member";
  if (!o || map === null) return fallback;
  const byKey = keyedMap(map);
  const candidates = [...groupNames]
    .sort((a, b) => (scimKey(a) < scimKey(b) ? -1 : scimKey(a) > scimKey(b) ? 1 : 0))
    .flatMap((name) => {
      const role = byKey.get(scimKey(name));
      return role === undefined ? [] : [role];
    });
  let best: string | null = null;
  let bestRank = Number.NEGATIVE_INFINITY;
  for (const role of candidates) {
    const rank = ranks.get(role) ?? rankOf(o.ranks, role);
    // The write rule of the map refuses both; a role table that changed later can hold them.
    if (isOwner(o, rank)) continue;
    if (o.platformRole !== null && holdsRolePart(role, o.platformRole)) continue;
    if (rank > bestRank || (rank === bestRank && best !== null && role < best)) {
      best = role;
      bestRank = rank;
    }
  }
  return best ?? fallback;
}

/**
 * The role map of an organization and the facts of its roles, or null when
 * no map applies: `scim.groups: "teams"`, no enabled connection, or an
 * empty map. One read of the connection, and one read of the role rows per
 * 50 dynamic role names (at most 100 names: the write rule of Task 3).
 */
export async function roleMapFacts(
  config: ResolvedConfig,
  storage: StorageAdapter,
  organizationId: string,
): Promise<RoleMapFacts | null> {
  const o = config.organizations;
  if (!o || !config.scim || config.scim.groups === "teams") return null;
  const map = (await roleMapConnection(storage, organizationId))?.scimRoles ?? null;
  if (map === null || Object.keys(map).length === 0) return null;
  const byKey = keyedMap(map);
  const roles = [...new Set(byKey.values())];
  const unknown = [
    ...new Set(roles.flatMap((r) => r.split(",")).filter((p) => !Object.hasOwn(o.roles, p))),
  ];
  const rows =
    o.dynamicRoles === null || unknown.length === 0
      ? []
      : await findManyIn(storage, "organizationRole", "name", unknown, [
          { field: "organizationId", op: "eq", value: organizationId },
        ]);
  const defined = new Map<string, number>();
  for (const row of rows) {
    // A row with a bad shape grants nothing, so it is no role here either.
    const def = roleRowDef(o, row);
    if (def !== null) defined.set(row.name, def.rank);
  }
  const ranks = new Map<string, number>();
  const gone = new Set<string>();
  for (const role of roles) {
    let rank = rankOf(o.ranks, role);
    for (const part of role.split(",")) {
      if (Object.hasOwn(o.roles, part)) continue;
      const r = defined.get(part);
      if (r === undefined) gone.add(role);
      else if (r > rank) rank = r;
    }
    ranks.set(role, rank);
  }
  return { map, byKey, ranks, gone };
}

/** The mapped groups of the organization: one read per 50 names of the map. */
export async function mappedGroups(
  storage: StorageAdapter,
  organizationId: string,
  facts: RoleMapFacts,
): Promise<ScimGroupRow[]> {
  return findManyIn(
    storage,
    "scimGroup",
    "displayNameKey",
    [...facts.byKey.keys()],
    [{ field: "organizationId", op: "eq", value: organizationId }],
  );
}

/**
 * The role of one SCIM User by its groups, for the member row of a create
 * or a reactivate (Task 10 Behaviors 3 and 6). `scim.defaultRole` when no
 * map applies. A role of the map that is gone answers `role_not_found`,
 * and the write stops with nothing written (ruling 25 N2).
 */
export async function scimRoleOf(
  config: ResolvedConfig,
  storage: StorageAdapter,
  organizationId: string,
  scimUserId: string,
): Promise<string> {
  const fallback = config.scim?.defaultRole ?? "member";
  const facts = await roleMapFacts(config, storage, organizationId);
  if (!facts) return fallback;
  const groups = await mappedGroups(storage, organizationId, facts);
  if (groups.length === 0) return fallback;
  const of = await storage.findMany("scimGroupMember", [
    { field: "scimUserId", op: "eq", value: scimUserId },
  ]);
  const names = of.flatMap((m) =>
    groups.filter((g) => g.id === m.groupId).map((g) => g.displayName),
  );
  const role = roleFromGroups(config, facts.map, names, facts.ranks);
  if (facts.gone.has(role)) stopWith("role_not_found");
  return role;
}
