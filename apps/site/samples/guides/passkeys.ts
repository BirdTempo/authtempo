import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createPasskeyAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    // Each passkey origin must be baseURL or a trusted origin, or the router refuses its posts.
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    passkey: {
      // The registrable domain that the passkeys bind to. Every origin must be on it.
      rpID: "example.com",
      // The name that the device shows.
      rpName: "Example",
      // The web origins where the ceremonies run.
      origins: ["https://app.example.com"],
    },
  });
}
