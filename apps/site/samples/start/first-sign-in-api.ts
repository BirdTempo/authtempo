import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** The API at https://api.example.com, for a browser app at https://app.example.com. */
export function createApiAuth(deps: { storage: StorageAdapter; mail: MailPort; secret: string }) {
  return createAuth({
    baseURL: "https://api.example.com",
    // The browser lands here after a sign-in. It must be in trustedOrigins too.
    appURL: "https://app.example.com",
    // A trusted origin gets credentialed CORS, and its POSTs pass the Origin rule.
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
  });
}
