import { type Auth, createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/**
 * Roles by name. `statements` adds the app's own resource. `roles` gives each
 * role a rank and its exact actions, so `ranks` is not set. `dynamicRoles`
 * lets each organization store its own roles beside these.
 */
export function createRolesAuth(deps: { storage: StorageAdapter; mail: MailPort; secret: string }) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    organizations: {
      statements: { project: ["read", "write"] },
      roles: {
        member: { rank: 1, permissions: { member: ["read"], project: ["read"] } },
        admin: {
          rank: 2,
          permissions: {
            member: ["read", "create", "update", "delete"],
            ac: ["read"],
            project: ["read", "write"],
          },
        },
        owner: {
          rank: 3,
          permissions: {
            organization: ["update", "delete"],
            member: ["read", "create", "update", "delete"],
            invitation: ["read", "create", "cancel"],
            ac: ["read", "create", "update", "delete"],
            project: ["read", "write"],
          },
        },
      },
      // At most 50 stored roles in each organization, the default.
      dynamicRoles: { maxPerOrganization: 50 },
    },
  });
}

/**
 * A route of the app that writes a project. The server check decides: it
 * reads the caller's role at each request, so a narrowed role applies at once.
 */
export async function writeProject(
  auth: Auth,
  request: Request,
  organizationId: string,
): Promise<Response> {
  const caller = await auth.caller(request);
  if (!caller) return Response.json({ error: "unauthorized" }, { status: 401 });
  const allowed = await auth.hasPermission(caller, {
    organizationId,
    permissions: { project: ["write"] },
  });
  if (!allowed) return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json({ written: true });
}
