import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createSplitOriginsAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    // The API.
    baseURL: "https://api.example.com",
    // The app on another site. Every sign-in lands here, and errors go to /?auth_error=<code>.
    appURL: "https://app.example.net",
    // The app origin gets credentialed CORS, and its POSTs pass the Origin rule.
    trustedOrigins: ["https://app.example.net"],
    // Another site needs SameSite=None, or the browser drops the session cookie.
    // A sibling subdomain of the API keeps the default, Lax.
    cookie: { sameSite: "None" },
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
  });
}
