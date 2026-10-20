/**
 * The one map between Better Auth's statement names and core's (plan 12k
 * Task 10, spec 29 item 18). The server option map, the storage of
 * `organizationRole`, and the client read it. It imports nothing, so the
 * client bundle can use it.
 */

/** Better Auth's api-key resource. Core names it `apiToken`. */
const BETTER_AUTH_KEY = "apiKey";
const CORE_KEY = "apiToken";

/** The six resources of core (`CORE_STATEMENTS`). An app's own statements never hold them. */
export const CORE_RESOURCES: readonly string[] = [
  "organization",
  "member",
  "invitation",
  "team",
  "ac",
  "apiToken",
];

type Bag = Record<string, unknown>;

function plain(value: unknown): value is Bag {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Renames one key, and joins its list to a list that holds the new name already. */
function renamed(set: Bag, from: string, to: string): Bag {
  const out = new Map<string, unknown>();
  for (const [resource, actions] of Object.entries(set)) {
    const name = resource === from ? to : resource;
    const before = out.get(name);
    out.set(
      name,
      Array.isArray(before) && Array.isArray(actions)
        ? [...new Set([...before, ...actions])]
        : actions,
    );
  }
  // fromEntries defines each key as an own property, so a key such as `__proto__` stays data.
  return Object.fromEntries(out);
}

/**
 * Better Auth's names to core's: `apiKey` becomes `apiToken`, and an empty
 * list goes, because it grants nothing and core refuses it. A value that is
 * not a plain object comes back as it is, so core's shape rule refuses it.
 */
export function toCoreNames(value: unknown): unknown {
  if (!plain(value)) return value;
  return Object.fromEntries(
    Object.entries(renamed(value, BETTER_AUTH_KEY, CORE_KEY)).filter(
      ([, actions]) => !(Array.isArray(actions) && actions.length === 0),
    ),
  );
}

/** Core's names to Better Auth's: `apiToken` becomes `apiKey`. */
export function toBetterAuthNames(value: unknown): unknown {
  return plain(value) ? renamed(value, CORE_KEY, BETTER_AUTH_KEY) : value;
}

/**
 * Better Auth's list rule on core's check: every member lists the members,
 * and a role that invites lists the invitations. So each mapped role holds
 * `member:read`, and `invitation:read` when it holds `invitation:create`.
 */
export function withListReads(set: Record<string, string[]>): Record<string, string[]> {
  const out = { ...set };
  // A value that is not a list stays as it is, so core's shape rule refuses it.
  const member = Object.hasOwn(out, "member") ? out.member : [];
  if (Array.isArray(member) && !member.includes("read")) out.member = [...member, "read"];
  const invitation = out.invitation;
  if (Array.isArray(invitation) && invitation.includes("create") && !invitation.includes("read"))
    out.invitation = [...invitation, "read"];
  return out;
}

/** A Better Auth role's statements as core's permissions: the names, then the list reads. */
export function corePermissionsOf(statements: unknown): Record<string, string[]> {
  return withListReads(toCoreNames(statements) as Record<string, string[]>);
}
