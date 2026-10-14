import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createHandoffAuth(deps: {
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
    // The app schemes that the one-time code may go to, each with its "://".
    // A sign-in ends at myapp://auth?code=… on the device.
    handoff: { schemes: ["myapp://"] },
  });
}
