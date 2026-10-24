import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** Password sign-in by address or by a public username. */
export function createUsernameAuth(deps: {
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
    password: {},
    username: {
      // 3 to 30 characters after NFKC. These are the defaults.
      minLength: 3,
      maxLength: 30,
      // Names of your own that no account may take, in the stored form.
      reserved: ["billing", "staff"],
    },
  });
}
