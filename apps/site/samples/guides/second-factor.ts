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
    // The enable of each method proves the password, so the factor needs `password`.
    password: {},
    totp: {
      // The name that the authenticator app shows. 1 to 80 characters, no colon.
      issuer: "Example",
      // The backup codes that the first method answers, 5 to 20. The default is 10.
      backupCodes: 10,
      // The days that a trusted device skips the factor, 1 to 365. The default is 30.
      trustDays: 30,
      // The gate on the other sign-in methods. Each is on by default: a method
      // with no gate lets the holder of a mailbox past the factor.
      gate: { magicLink: true, emailOtp: true, social: true },
    },
  });
}
