import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** Password sign-up that proves the address by a mailed code, not a link. */
export function createCodeProofAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    password: {
      verifyBy: "code",
      // Optional: your own text. Core sends it to the address, whatever `to` says.
      verifyCodeMail: ({ email, code, appName, ttlMinutes }) => ({
        to: email,
        subject: `Your ${appName} code`,
        text: `${code} confirms your address. It expires in ${ttlMinutes} minutes.`,
      }),
    },
  });
}
