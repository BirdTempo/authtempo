import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** One deployment that serves two hosts. The first entry is the primary. */
export function createTwoHostAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    // Exact origins only: no wildcard, no path, https (or http on localhost).
    baseURL: ["https://auth.example.com", "https://auth.example.org"],
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    oauth: { resources: ["https://api.example.com/mcp"], registration: { cimd: false } },
  });
}
