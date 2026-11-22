import { createClient } from "@authtempo/client";
import {
  createAuth,
  dohCloudflare,
  dohGoogle,
  type MailPort,
  type StorageAdapter,
} from "@authtempo/core";

/**
 * Setup links on. An owner mints a link and sends it to the IT admin of the
 * customer. The IT admin fills in the domain, the connection, and the SCIM
 * token. Nothing goes live until the owner activates the link.
 * `sso.setup` needs `sso` and `organizations`. It needs `account.notices` too,
 * which is on by default: the owners get a notice when a setup is ready.
 */
export function createSetupAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  /** Runs after the commit of a handback. A throw writes one log line and changes nothing. */
  onReady: (e: { organizationId: string; linkId: string }) => void | Promise<void> = () => {},
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
      saml: {},
      // The IT admin proves the domain by a TXT record. Every resolver must give it.
      dns: [dohCloudflare(fetch), dohGoogle(fetch)],
      // A link lives 24 hours unless the mint names another time. The range is 1 to 168 hours.
      setup: { ttlHours: 24 },
    },
    hooks: { sso: { setupReady: onReady } },
  });
}

/** The client of the owner: a signed-in manager of the organization. */
export function ownerClient(fetchImpl: typeof fetch) {
  return createClient({ baseURL: "https://api.example.com", fetch: fetchImpl });
}

/**
 * Mint a link for the steps that the customer needs. The clear token appears
 * once, in this answer. Send it to the IT admin, and never write it to a log.
 */
export async function mintSetupLink(
  client: ReturnType<typeof ownerClient>,
  organizationId: string,
) {
  const made = await client.sso.setupLinks.create({
    organizationId,
    steps: ["domain", "connection", "directory"],
    kinds: ["saml", "oidc"],
    note: "Acme staff, from the ticket of the IT team",
  });
  if (!made.ok) throw new Error(made.code);
  // The IT admin opens this address. The page only asks to confirm, and opens no session.
  return `https://api.example.com/auth/sso/setup?token=${encodeURIComponent(made.value.token)}`;
}

/**
 * After the handback: read what an activation makes live, then activate. The
 * activation answers `setup_not_tested` until a test of this exact draft has passed.
 */
export async function reviewAndActivate(
  client: ReturnType<typeof ownerClient>,
  linkId: string,
  approve: (preview: unknown) => boolean,
) {
  const got = await client.sso.setupLinks.get({ id: linkId });
  if (!got.ok) throw new Error(got.code);
  if (!approve(got.value.preview)) {
    const revoked = await client.sso.setupLinks.revoke({ id: linkId });
    if (!revoked.ok) throw new Error(revoked.code);
    return null;
  }
  const live = await client.sso.setupLinks.activate({ id: linkId });
  if (!live.ok) throw new Error(live.code);
  return live.value;
}
