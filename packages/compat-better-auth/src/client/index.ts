// "./client": under the alias it answers `better-auth/client`,
// `@better-auth/expo/client`, `@better-auth/passkey/client`, and
// `@better-auth/sso/client` (plan 12d Task 14).

export type * from "../types.js";
export { CLIENT_SESSION_KEYS, CLIENT_USER_KEYS, createAuthClient } from "./create-auth-client.js";
export { expoClient } from "./expo.js";
export {
  adminClient,
  apiKeyClient,
  emailOTPClient,
  magicLinkClient,
  organizationClient,
  passkeyClient,
  ssoClient,
  twoFactorClient,
} from "./plugins.js";
