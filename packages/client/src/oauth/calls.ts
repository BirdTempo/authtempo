import type { ClientCall } from "../calls.js";

/**
 * Every route of the OAuth provider that the OAuth client calls (plan 11d).
 * The paths are under the issuer (`baseURL + basePath`); the drift test of
 * `@authtempo/sdk-conformance` holds the table to `ROUTES`.
 */
export const OAUTH_CALLS = [
  {
    operation: "oauthClient.metadata",
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
  },
  { operation: "oauthClient.authorize", method: "GET", path: "/oauth/authorize" },
  { operation: "oauthClient.token", method: "POST", path: "/oauth/token" },
  { operation: "oauthClient.revoke", method: "POST", path: "/oauth/revoke" },
  { operation: "oauthClient.register", method: "POST", path: "/oauth/register" },
  { operation: "oauthClient.userinfo", method: "GET", path: "/oauth/userinfo" },
] as const satisfies readonly ClientCall[];

type OAuthOperation = (typeof OAUTH_CALLS)[number]["operation"];

/** The URL of an operation under the issuer. */
export function oauthURL(issuer: string, operation: OAuthOperation): string {
  const c = OAUTH_CALLS.find((x) => x.operation === operation);
  // Unreachable: the type of `operation` is a name of the table.
  if (!c) throw new Error(`authtempo oauth: no call ${operation}`);
  return `${issuer}${c.path}`;
}
