import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createSlackAuth(deps: { storage: StorageAdapter; mail: MailPort; secret: string }) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    social: {
      // Read the secret from your secret store. The placeholders only build the config.
      slack: { clientId: "1234567890.1234567890", clientSecret: "slack-client-secret" },
    },
  });
}
