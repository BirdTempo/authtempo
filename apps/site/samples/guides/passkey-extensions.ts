import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createExtensionsAuth(deps: {
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
    passkey: {
      rpID: "example.com",
      rpName: "Example",
      origins: ["https://app.example.com"],
      // Each flag is advice for the app's client. No check of core reads it.
      extensions: { prf: true, largeBlob: "preferred", credProps: true },
    },
  });
}
