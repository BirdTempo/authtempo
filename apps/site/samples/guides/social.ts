import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** The provider secrets. Read them from your secret store. The placeholders only build the config. */
export interface SocialEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APPLE_SERVICES_ID: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  /** The PKCS#8 PEM of the Sign in with Apple key. */
  APPLE_PRIVATE_KEY: string;
}

const PLACEHOLDERS: SocialEnv = {
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  APPLE_SERVICES_ID: "com.example.web",
  APPLE_TEAM_ID: "TEAMID1234",
  APPLE_KEY_ID: "KEYID12345",
  APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----",
};

export function createSocialAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  env: SocialEnv = PLACEHOLDERS,
) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    social: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      // Core signs a client secret of five minutes for each token exchange,
      // so no stored secret expires. Rotate the key in the Apple portal.
      apple: {
        clientId: env.APPLE_SERVICES_ID,
        teamId: env.APPLE_TEAM_ID,
        keyId: env.APPLE_KEY_ID,
        privateKey: env.APPLE_PRIVATE_KEY,
      },
    },
  });
}
