import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** One passkey for example.com, its app host, and two related sites. */
export function createRelatedOriginsAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  const origins = [
    "https://app.example.com",
    // Outside the domain tree of rpID: the document lists these two.
    "https://example.net",
    "https://example.org",
  ];
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    // Each passkey origin must be a trusted origin, or the router refuses its posts.
    trustedOrigins: origins,
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    passkey: {
      rpID: "example.com",
      rpName: "Example",
      origins,
      // At most five origins outside example.com. auth.wellKnown serves the document.
      relatedOrigins: true,
    },
  });
}
