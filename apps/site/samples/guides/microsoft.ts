import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createMicrosoftAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    social: {
      // Read the secret from your secret store. The placeholders only build the config.
      microsoft: {
        clientId: "00000000-0000-4000-8000-000000000001",
        clientSecret: "microsoft-client-secret",
        // "common", "organizations", "consumers", or the GUID of your tenant.
        tenant: "organizations",
      },
    },
  });
}
