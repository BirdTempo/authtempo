import type { AuthConfig } from "../src/config.js";
import { BASE, base, SOCIAL } from "./every-feature.js";

/** Known strings for each value of the config that is not one of the six keys (plan 11g). */
export const SECRETS = {
  secret: "nosecret-app-secret-7a1c9e0b3d5f2846aa",
  secretHash: "5e".repeat(32),
  google: "nosecret-google-client-secret",
  github: "nosecret-github-client-secret",
  linkedin: "nosecret-linkedin-client-secret",
  oidc: "nosecret-oidc-client-secret",
  oauth2: "nosecret-oauth2-client-secret",
  privateKey: "nosecret-apple-private-key",
  teamId: "NOSECRETTEAM",
  keyId: "NOSECRETKEY",
  origin: "https://nosecret-passkey.api.example.com",
};

/**
 * A config with every secret of `SECRETS` and every feature that holds one.
 * The document test and the route test of plan 11g both read it.
 */
export function noSecretInput(): AuthConfig {
  const oidc = SOCIAL.oidc?.[0];
  const oauth2 = SOCIAL.oauth2?.[0];
  if (!oidc || !oauth2) throw new Error("SOCIAL has no oidc or oauth2 entry");
  return {
    ...base,
    secret: SECRETS.secret,
    trustedOrigins: [SECRETS.origin],
    social: {
      google: { clientId: "g", clientSecret: SECRETS.google },
      apple: {
        clientId: "a",
        teamId: SECRETS.teamId,
        keyId: SECRETS.keyId,
        privateKey: SECRETS.privateKey,
      },
      github: { clientId: "h", clientSecret: SECRETS.github },
      linkedin: { clientId: "l", clientSecret: SECRETS.linkedin },
      oidc: [{ ...oidc, clientSecret: SECRETS.oidc }],
      oauth2: [{ ...oauth2, clientSecret: SECRETS.oauth2 }],
    },
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE, SECRETS.origin] },
    password: {},
    organizations: {},
    oauth: { resources: [`${BASE}/mcp`], registration: { cimd: false, dynamic: true } },
    operator: { secretHash: SECRETS.secretHash },
  };
}
