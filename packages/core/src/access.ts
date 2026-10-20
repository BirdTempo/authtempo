/**
 * Pure checks of permission statements (plan 12k). No I/O and no import, so a
 * browser bundle can use it. The server check decides; a client check only
 * hides a control.
 *
 * Every check fails closed: a value that is not a statement set, an unknown
 * resource, an unknown action, or an unknown role part grants nothing.
 */

/** The actions of each resource, as `{ member: ["read", "create"] }`. */
export type Statements = Readonly<Record<string, readonly string[]>>;

/** One role: its rank for the owner rules, and its permissions. */
export interface RoleDef {
  readonly rank: number;
  readonly permissions: Statements;
}

/** The roles of an organization by name. */
export type RoleTable = Readonly<Record<string, RoleDef>>;

/** A resource or an action name. */
export const NAME_RE = /^[a-z][a-zA-Z0-9-]{0,31}$/;

/** The resources and actions of core. An app adds its own with `organizations.statements`. */
export const CORE_STATEMENTS = Object.freeze({
  organization: Object.freeze(["update", "delete"] as const),
  member: Object.freeze(["read", "create", "update", "delete"] as const),
  invitation: Object.freeze(["read", "create", "cancel"] as const),
  team: Object.freeze(["create", "update", "delete"] as const),
  ac: Object.freeze(["read", "create", "update", "delete"] as const),
  apiToken: Object.freeze(["read", "create", "update", "revoke"] as const),
});

/** A plain object whose own values are lists of strings. */
function isStatements(value: unknown): value is Statements {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const actions of Object.values(value))
    if (!Array.isArray(actions) || !actions.every((a) => typeof a === "string")) return false;
  return true;
}

/**
 * The actions of one resource, or none when the set lacks it or its value is
 * not a list. A string would spread into its letters, so it grants nothing.
 */
function actionsOf(set: Statements, resource: string): readonly string[] {
  if (!Object.hasOwn(set, resource)) return [];
  const actions: unknown = set[resource];
  return Array.isArray(actions) ? actions : [];
}

/**
 * True only when `wanted` names at least one resource, each resource names at
 * least one action, and `granted` holds every action. It never throws.
 */
export function can(granted: Statements, wanted: Statements): boolean {
  try {
    if (!isStatements(granted) || !isStatements(wanted)) return false;
    const resources = Object.keys(wanted);
    if (resources.length === 0) return false;
    for (const resource of resources) {
      const actions = actionsOf(wanted, resource);
      if (actions.length === 0) return false;
      const held = actionsOf(granted, resource);
      for (const action of actions) if (!held.includes(action)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Each action of any set, once, in the order of first sight. */
export function union(...sets: Statements[]): Statements {
  const out = new Map<string, string[]>();
  for (const set of sets)
    for (const resource of Object.keys(set)) {
      const list = out.get(resource) ?? [];
      for (const action of actionsOf(set, resource)) if (!list.includes(action)) list.push(action);
      out.set(resource, list);
    }
  // fromEntries defines each key as an own property, so a key such as `__proto__` stays data.
  return Object.fromEntries(out);
}

/** The actions of `a` that `b` also holds, once each. A resource with no action left drops out. */
export function intersect(a: Statements, b: Statements): Statements {
  const out = new Map<string, string[]>();
  for (const resource of Object.keys(a)) {
    const held = actionsOf(b, resource);
    const list: string[] = [];
    for (const action of actionsOf(a, resource))
      if (held.includes(action) && !list.includes(action)) list.push(action);
    if (list.length > 0) out.set(resource, list);
  }
  return Object.fromEntries(out);
}

/** True when `b` holds every action of `a`. The empty set is a subset of every set. */
export function isSubset(a: Statements, b: Statements): boolean {
  if (!isStatements(a) || !isStatements(b)) return false;
  for (const resource of Object.keys(a)) {
    const held = actionsOf(b, resource);
    for (const action of actionsOf(a, resource)) if (!held.includes(action)) return false;
  }
  return true;
}

/** The union of the permissions of each comma part of `role`. A part that the table lacks adds nothing. */
export function effectiveOf(role: string, table: RoleTable): Statements {
  const sets: Statements[] = [];
  for (const part of role.split(","))
    if (Object.hasOwn(table, part)) sets.push((table[part] as RoleDef).permissions);
  return union(...sets);
}

/** True when the role string holds every permission. False on any bad input. */
export function roleHasPermission(
  table: RoleTable,
  role: string,
  permissions: Statements,
): boolean {
  if (typeof role !== "string" || typeof table !== "object" || table === null) return false;
  try {
    return can(effectiveOf(role, table), permissions);
  } catch {
    return false;
  }
}

/** Null when the value is a valid statement set of known names; else the first fault. */
export function statementFault(value: unknown, known: Statements): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "the permissions must be an object";
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "the permissions must be a plain object";
  for (const [resource, actions] of Object.entries(value)) {
    if (!NAME_RE.test(resource)) return `${resource} is not a resource name`;
    if (!Object.hasOwn(known, resource)) return `${resource} is not a known resource`;
    if (!Array.isArray(actions)) return `${resource} must be a list of actions`;
    if (actions.length === 0) return `${resource} lists no action`;
    const held = actionsOf(known, resource);
    const seen: string[] = [];
    for (const action of actions) {
      if (typeof action !== "string" || !NAME_RE.test(action))
        return `${resource} has a bad action name: ${String(action)}`;
      if (!held.includes(action)) return `${resource}.${action} is not a known action`;
      if (seen.includes(action)) return `${resource}.${action} is repeated`;
      seen.push(action);
    }
  }
  return null;
}
