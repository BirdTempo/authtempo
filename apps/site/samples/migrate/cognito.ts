import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";
import { createCognitoLegacyVerify } from "@authtempo/legacy-hashes/cognito";

/**
 * The API after an import from Amazon Cognito. Cognito exports no hash, so
 * core asks Cognito once per user, at the first password sign-in, and then
 * writes its own hash. Remove `legacyVerify` when the migration ends.
 */
export function createCognitoAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  // The global fetch in the app. The test passes a fake Cognito.
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    password: {
      legacyVerify: {
        verify: createCognitoLegacyVerify({
          region: "eu-west-1",
          // The app client must allow ALLOW_USER_PASSWORD_AUTH.
          clientId: "example-app-client-id",
          fetch: fetchImpl,
        }),
        // Every failed password sign-in answers no earlier than this, so a
        // migrated and an unmigrated address look the same.
        timeoutMs: 2000,
      },
    },
  });
}
