import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createSecondFactorAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    // The second factor gates the password sign-in, so it needs `password`.
    password: {},
    totp: {
      // The name that the authenticator app shows. 1 to 80 characters, no colon.
      issuer: "Example",
      // The backup codes of each setup, 5 to 20. The default is 10.
      backupCodes: 10,
      // The days that a trusted device skips the factor, 1 to 365. The default is 30.
      trustDays: 30,
    },
  });
}
