import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createFacebookAuth(deps: {
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
      // The app id and the app secret of the Meta app. Read them from your secret store.
      facebook: { clientId: "1234567890", clientSecret: "facebook-app-secret" },
    },
  });
}
