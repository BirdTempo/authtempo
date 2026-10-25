import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** A hint on the sign-in page: "Last time you used …". */
export function createLastMethodAuth(deps: {
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
    password: {},
    // The defaults: the cookie __Host-tempo_last_method, kept 30 days.
    lastMethod: { days: 30 },
  });
}

/** The browser side: read the cookie, and mark the button of that method. */
export function lastMethodOf(cookie: string): string | null {
  const pair = cookie.split("; ").find((c) => c.startsWith("__Host-tempo_last_method="));
  return pair ? decodeURIComponent(pair.slice(pair.indexOf("=") + 1)) : null;
}
