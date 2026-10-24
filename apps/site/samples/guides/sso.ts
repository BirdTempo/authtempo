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
 * Enterprise SSO on. An organization proves its email domain by a TXT record,
 * then signs its staff in through its own OIDC or SAML provider. `sso`
 * needs `organizations`. With a setup, the operator secret with the scope
 * `sso` turns `enforce` off when the provider of a domain is down.
 */
export function createSsoAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  setup: {
    /** The SHA-256 of the operator secret, as `authtempo secret --operator` prints it. */
    operatorHash?: string;
    /** The resolvers of the domain proof. A test passes its own. */
    dns?: DnsTxtPort[];
  } = {},
) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    organizations: {},
    sso: {
      oidc: true,
      // A SAML condition may pass by at most this many seconds of clock skew.
      saml: { clockSkewSeconds: 120 },
      // Every resolver must give the record. One wrong resolver cannot give a domain away.
      dns: setup.dns ?? [dohCloudflare(fetch), dohGoogle(fetch)],
    },
    ...(setup.operatorHash !== undefined && {
      operator: {
        secrets: [{ name: "sso-desk", secretHash: setup.operatorHash, scopes: ["sso"] }],
      },
    }),
  });
}

/** The app's admin page as the actor of each SSO call. Each audit row names it. */
export const ADMIN = { kind: "app", name: "admin-page" } as const;

/** Step 1: add the domain. Show the record to the owner, who publishes it at the DNS host. */
export async function addDomain(auth: Auth, organizationId: string, domain: string) {
  const sso = auth.api.sso;
  if (!sso) throw new Error("sso is off");
  const added = await sso.domains.add({ actor: ADMIN, organizationId, domain });
  if (!added.ok) throw new Error(added.code);
  // { name: "_authtempo-challenge.<domain>", type: "TXT", value: "authtempo-domain=…" }
  return added.value;
}

/**
 * Steps 2 to 4: verify the domain, add a SAML connection with the values of
 * the provider, and route the domain to it with `enforce` on.
 */
export async function connectSaml(
  auth: Auth,
  input: {
    organizationId: string;
    domainId: string;
    idpEntityId: string;
    ssoUrl: string;
    certificatePem: string;
  },
) {
  const sso = auth.api.sso;
  if (!sso) throw new Error("sso is off");
  const verified = await sso.domains.verify({ actor: ADMIN, id: input.domainId });
  if (!verified.ok) throw new Error(verified.code);
  const connection = await sso.connections.create({
    actor: ADMIN,
    organizationId: input.organizationId,
    kind: "saml",
    label: "Acme staff",
    idpEntityId: input.idpEntityId,
    ssoUrl: input.ssoUrl,
    certificates: [input.certificatePem],
  });
  if (!connection.ok) throw new Error(connection.code);
  // The values that the provider needs: the SP entity id and the ACS URL.
  const { spEntityId, acsUrl } = connection.value.saml ?? { spEntityId: "", acsUrl: "" };
  const routed = await sso.domains.update({
    actor: ADMIN,
    id: input.domainId,
    connectionId: connection.value.id,
    enforce: true,
  });
  if (!routed.ok) throw new Error(routed.code);
  return { connectionId: connection.value.id, spEntityId, acsUrl };
}
