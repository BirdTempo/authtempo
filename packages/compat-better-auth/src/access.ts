/**
 * Better Auth 1.7.2's access control, for `better-auth/plugins/access` and
 * `better-auth/plugins/organization/access` (plan 12k Task 10, spec 29 item
 * 18). The shapes and the answers of `authorize` are Better Auth's
 * (dist/plugins/access/access.mjs and organization/access/statement.mjs,
 * read 2026-10-21). It imports nothing, so a browser bundle can use it.
 *
 * `authorize` only hides a control on the client. The server maps `ac` and
 * `roles` onto core's statements and roles, and core's check decides.
 */

/** The actions of each resource, as `{ project: ["read", "write"] }`. */
export type Statements = { readonly [resource: string]: readonly string[] };

export type AuthorizeResponse =
  | { success: false; error: string }
  | { success: true; error?: never | undefined };

/** One resource of a request: a list of actions (all of them), or a list with its own connector. */
export type ActionRequest =
  | readonly string[]
  | { readonly actions: readonly string[]; readonly connector: "OR" | "AND" };

export type AuthorizeRequest = { readonly [resource: string]: ActionRequest | undefined };

export interface Role<S extends Statements = Statements> {
  authorize(request: AuthorizeRequest, connector?: "OR" | "AND"): AuthorizeResponse;
  readonly statements: S;
}

export interface AccessControl<S extends Statements = Statements> {
  newRole<const R extends Statements>(statements: R): Role<R>;
  readonly statements: S;
}

function normalized(request: ActionRequest | undefined): {
  actions: readonly unknown[];
  connector: "OR" | "AND";
} {
  if (Array.isArray(request)) return { actions: request, connector: "AND" };
  if (!request || typeof request !== "object") throw new Error("Invalid access control request");
  const { actions, connector } = request as { actions?: unknown; connector?: unknown };
  return {
    actions: Array.isArray(actions) ? actions : [],
    connector: connector === "OR" ? "OR" : "AND",
  };
}

function resourceAuthorized(
  allowed: readonly string[],
  { actions, connector }: { actions: readonly unknown[]; connector: "OR" | "AND" },
): boolean {
  if (actions.length === 0) return false;
  const held = (a: unknown) => typeof a === "string" && allowed.includes(a);
  return connector === "OR" ? actions.some(held) : actions.every(held);
}

/** A role of `statements`. `authorize` answers as Better Auth 1.7.2's does, with its texts. */
export function role<const S extends Statements>(statements: S): Role<S> {
  return {
    authorize(request, connector = "AND") {
      let any = false;
      for (const [resource, wanted] of Object.entries(request)) {
        const allowed = Object.hasOwn(statements, resource) ? statements[resource] : undefined;
        if (!allowed) {
          if (connector === "AND")
            return {
              success: false,
              error: `You are not allowed to access resource: ${resource}`,
            };
          continue;
        }
        const ok = resourceAuthorized(allowed, normalized(wanted));
        if (ok) any = true;
        if (ok && connector === "OR") return { success: true };
        if (!ok && connector === "AND")
          return { success: false, error: `unauthorized to access resource "${resource}"` };
      }
      return any ? { success: true } : { success: false, error: "Not authorized" };
    },
    statements,
  };
}

export function createAccessControl<const S extends Statements>(statements: S): AccessControl<S> {
  return { newRole: (s) => role(s), statements };
}

/** Better Auth's five organization resources. Core adds member:read, invitation:read, and apiToken. */
export const defaultStatements = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
} as const;

export const defaultAc = createAccessControl(defaultStatements);

export const adminAc = defaultAc.newRole({
  organization: ["update"],
  invitation: ["create", "cancel"],
  member: ["create", "update", "delete"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
});

export const ownerAc = defaultAc.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
});

export const memberAc = defaultAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ["read"],
});

export const defaultRoles = { admin: adminAc, owner: ownerAc, member: memberAc };
