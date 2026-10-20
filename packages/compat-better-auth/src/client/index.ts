// "./client": under the alias it answers `better-auth/client`,
// `@better-auth/expo/client`, and `@better-auth/passkey/client`.

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
  twoFactorClient,
} from "./plugins.js";
