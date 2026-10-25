import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** Sign in with Apple on the web, and from the native sheet of the iOS app. */
export function createNativeAppleAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  // Tests serve their own key set through this fetch. An app leaves it out.
  fetchFn?: typeof fetch,
) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    social: {
      apple: {
        // The Services ID of the web flow.
        clientId: "com.example.web",
        teamId: "TEAMID1234",
        keyId: "KEYID12345",
        privateKey: "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----",
        // The bundle id of the iOS app: the audience of a token of the native sheet.
        audiences: ["com.example.ios"],
      },
      ...(fetchFn ? { fetch: fetchFn } : {}),
    },
  });
}
