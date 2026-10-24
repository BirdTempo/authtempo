import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";
import { tiktokEntry } from "@authtempo/core/social-entries";

export function createTiktokAuth(deps: {
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
      // TikTok calls the client id the client key. Read both from your secret store.
      oauth2: [
        tiktokEntry({ clientKey: "tiktok-client-key", clientSecret: "tiktok-client-secret" }),
      ],
    },
  });
}
