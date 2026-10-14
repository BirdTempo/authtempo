import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** The provider secrets. Read them from your secret store. The placeholders only build the config. */
export interface ProvidersEnv {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ENTRA_TENANT_ID: string;
  ENTRA_CLIENT_ID: string;
  ENTRA_CLIENT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
}

const PLACEHOLDERS: ProvidersEnv = {
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  ENTRA_CLIENT_ID: "entra-client-id",
  ENTRA_CLIENT_SECRET: "entra-client-secret",
  DISCORD_CLIENT_ID: "discord-client-id",
  DISCORD_CLIENT_SECRET: "discord-client-secret",
};

export function createProvidersAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  env: ProvidersEnv = PLACEHOLDERS,
) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    social: {
      // A preset. GitHub issues no ID token, so core reads its user API.
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
      // An OpenID Connect provider. The Entra entry is an example: core does not test it.
      oidc: [
        {
          name: "microsoft",
          label: "Continue with Microsoft",
          issuer: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`,
          clientId: env.ENTRA_CLIENT_ID,
          clientSecret: env.ENTRA_CLIENT_SECRET,
          // With endpoints, core never reads the discovery document at request time.
          endpoints: {
            authorizeUrl: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize`,
            tokenUrl: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`,
            jwksUrl: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/discovery/v2.0/keys`,
          },
        },
      ],
      // A provider that issues no ID token. The Discord entry is an example: core does not test it.
      oauth2: [
        {
          name: "discord",
          label: "Continue with Discord",
          authorizeUrl: "https://discord.com/oauth2/authorize",
          tokenUrl: "https://discord.com/api/oauth2/token",
          clientId: env.DISCORD_CLIENT_ID,
          clientSecret: env.DISCORD_CLIENT_SECRET,
          scope: "identify email",
          // Call the provider with the fetch that core gives: it stops at 10 s.
          async userinfo(accessToken, fetch) {
            const res = await fetch("https://discord.com/api/users/@me", {
              headers: { authorization: `Bearer ${accessToken}` },
            });
            if (!res.ok) throw new Error(`discord answered ${res.status}`);
            const u = (await res.json()) as {
              id: string;
              email?: string | null;
              verified?: boolean;
              global_name?: string | null;
            };
            return {
              subject: u.id,
              email: u.email ?? null,
              // Only a boolean true from the provider counts as a proof of the address.
              emailVerified: u.verified === true,
              name: u.global_name ?? null,
              image: null,
            };
          },
        },
      ],
    },
  });
}
