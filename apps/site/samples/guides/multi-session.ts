import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** The sessions of several users in one browser, with a switch between them. */
export function createMultiSessionAuth(deps: {
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
    magicLink: {},
    multiSession: {
      // The sessions of one browser, the active one included: 2 to 10, 5 by default.
      max: 3,
    },
  });
}
