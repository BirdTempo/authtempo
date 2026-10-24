import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** The values that differ per deployment. Each preview deployment sets its own. */
export interface DeployEnv {
  /** The origin of the API of this deployment, such as https://pr-42.preview.example.com. */
  API_ORIGIN: string;
  /** The origin of the app of this deployment. */
  APP_ORIGIN: string;
  /**
   * The OAuth client of this host. Path 1: an OAuth app of its own, with the
   * callback of this host only. Path 2: one client of a provider that takes
   * several callbacks, with the callback of each host registered.
   */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

/** The settings of production. Read them from the settings of each deployment. */
const PRODUCTION: DeployEnv = {
  API_ORIGIN: "https://api.example.com",
  APP_ORIGIN: "https://app.example.com",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
};

export function createDeploymentAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  env: DeployEnv = PRODUCTION,
) {
  return createAuth({
    // The callback is <API_ORIGIN>/auth/social/github/callback. Register it at the provider.
    baseURL: env.API_ORIGIN,
    appURL: env.APP_ORIGIN,
    trustedOrigins: [env.APP_ORIGIN],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    social: {
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    },
  });
}
