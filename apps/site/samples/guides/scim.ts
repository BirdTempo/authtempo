import {
  type Auth,
  createAuth,
  type DnsTxtPort,
  dohCloudflare,
  dohGoogle,
  type MailPort,
  type StorageAdapter,
} from "@authtempo/core";

/**
 * A SCIM server for the directory of each organization. A SCIM create needs
 * an address in a verified domain of the organization, so `scim` comes with
 * `sso` and its resolvers. A SCIM group gives a role through the role map.
 */
export function createScimAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  dns?: DnsTxtPort[],
) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    organizations: {},
    sso: { oidc: true, dns: dns ?? [dohCloudflare(fetch), dohGoogle(fetch)] },
    scim: {
      // A group gives a role through the role map. "teams" gives a team per group, "both" both.
      groups: "roles",
      // The role of a person that the directory adds and that no mapped group names.
      defaultRole: "member",
    },
  });
}

/** The app's admin page as the actor of each SCIM call. Each audit row names it. */
const ADMIN = { kind: "app", name: "admin-page" } as const;

/**
 * The token for the directory, and the role map. The clear token appears
 * once: paste it into the directory with the base URL
 * `https://api.example.com/auth/scim/v2`.
 */
export async function connectDirectory(auth: Auth, organizationId: string) {
  const { sso, scim } = auth.api;
  if (!sso || !scim) throw new Error("sso or scim is off");
  // The role map lives on the first enabled connection of the organization.
  const connection = await sso.connections.create({
    actor: ADMIN,
    organizationId,
    kind: "oidc",
    label: "Acme staff",
    issuer: "https://login.acme.example",
    clientId: "authtempo",
    clientSecret: "the client secret of the provider",
  });
  if (!connection.ok) throw new Error(connection.code);
  // A member of the SCIM group "Admins" gets the role admin. SCIM never gives owner.
  const map = await scim.setRoleMap({ actor: ADMIN, organizationId, map: { Admins: "admin" } });
  if (!map.ok) throw new Error(map.code);
  const token = await scim.tokens.create({ actor: ADMIN, organizationId, name: "Entra ID" });
  if (!token.ok) throw new Error(token.code);
  return token.value.token;
}
