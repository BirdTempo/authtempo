import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** Google sign-in with One Tap, beside the redirect flow. */
export function createOneTapAuth(
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
      google: {
        clientId: "web-client.apps.googleusercontent.com",
        clientSecret: "google-client-secret",
      },
      // On by default with google or apple. requireNonce: true is the default: keep it.
      idToken: { requireNonce: true },
      ...(fetchFn ? { fetch: fetchFn } : {}),
    },
  });
}
