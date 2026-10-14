import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** Known breached passwords. Replace this set with a call to your breach check service. */
const BREACHED = new Set(["password1234", "qwertyuiop12"]);

export function createPasswordAuth(deps: {
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
    password: {
      // The lower bound in code points, 8 to 128. The default is 8; the upper bound is 128.
      minLength: 12,
      // True refuses the password with password_breached. The default is no check.
      breachCheck: async (plain) => BREACHED.has(plain),
    },
  });
}
