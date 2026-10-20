import {
  type Auth,
  createAuth,
  DEVICE_GRANT,
  type MailPort,
  type StorageAdapter,
} from "@authtempo/core";

export function createClientsAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    oauth: {
      resources: ["https://api.example.com/mcp"],
      scopes: { "mcp:tools": "Use your tools", "reports:read": "Read your reports" },
      // This sample makes its clients in code, so no client registers itself.
      registration: { cimd: false, dynamic: false },
      // The device grant of RFC 8628 is off by default. {} turns it on with a
      // 10-minute code and a 5-second poll interval.
      device: {},
    },
  });
}

/** The client API exists only while the config sets `oauth`. */
function clientsOf(auth: Auth) {
  if (!auth.api.oauth) throw new Error("the config sets no oauth");
  return auth.api.oauth.clients;
}

/**
 * A service that acts for no person: the client_credentials grant. Only
 * api.oauth.clients gives this grant; a registration never does.
 */
export async function createServiceClient(auth: Auth) {
  const made = await clientsOf(auth).create({
    name: "Report service",
    authMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    // The app scopes that the service may ask for. A built-in scope names a person, so it is refused.
    credentialsScopes: ["reports:read"],
  });
  if (!made.ok) throw new Error(`the client create answered ${made.error}`);
  // The secret leaves core once, here. Keep it in the secret store of the service.
  return { clientId: made.value.client.id, clientSecret: made.value.clientSecret ?? "" };
}

/** A device with no browser, such as a TV or a CLI: a public client of the device grant. */
export async function createDeviceClient(auth: Auth): Promise<string> {
  const made = await clientsOf(auth).create({
    name: "Living room TV",
    authMethod: "none",
    grantTypes: [DEVICE_GRANT],
  });
  if (!made.ok) throw new Error(`the client create answered ${made.error}`);
  return made.value.client.id;
}
