import { createOAuthClient, registerOAuthClient } from "@authtempo/client/oauth";

const ISSUER = "https://api.example.com/auth";
// A CLI takes the redirect on a loopback port. Core accepts http on 127.0.0.1 with any port.
const REDIRECT = "http://127.0.0.1:8123/callback";

/** Registers the CLI once. Keep the client id in the CLI's config. */
export function registerCli(fetch?: typeof globalThis.fetch) {
  return registerOAuthClient({
    issuer: ISSUER,
    clientName: "Example CLI",
    redirectUris: [REDIRECT],
    ...(fetch ? { fetch } : {}),
  });
}

/** The OAuth client of the CLI: an access token for the MCP resource and a refresh token. */
export function cliOAuthClient(clientId: string, fetch?: typeof globalThis.fetch) {
  return createOAuthClient({
    issuer: ISSUER,
    clientId,
    redirectUri: REDIRECT,
    resource: "https://api.example.com/mcp",
    // offline_access asks for a refresh token.
    scopes: ["openid", "offline_access"],
    ...(fetch ? { fetch } : {}),
  });
}
