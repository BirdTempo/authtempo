import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createXAuth(deps: { storage: StorageAdapter; mail: MailPort; secret: string }) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    social: {
      // The provider name is twitter, as in Better Auth. The button says X.
      // Read the secret from your secret store. The placeholders only build the config.
      twitter: { clientId: "x-client-id", clientSecret: "x-client-secret" },
    },
  });
}
