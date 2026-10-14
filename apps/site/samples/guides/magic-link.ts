import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createMagicLinkAuth(deps: {
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
    // The name in the mail subject ("Sign in to Example") and on the confirm page.
    appName: "Example",
    magicLink: {
      // The life of a link in minutes. The default is 15.
      ttlMinutes: 10,
      // The link in the mail. It must open GET /auth/magic-link/verify with the token, on the API.
      linkBuilder: (token) =>
        `https://api.example.com/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    },
  });
}
