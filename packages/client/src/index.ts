// A client check of a static role table. It only hides a control: the server check decides (plan 12k).
export { roleHasPermission, type Statements } from "@authtempo/core/access";
export { ERRORS, type ErrorCode } from "@authtempo/core/errors";
export { CLIENT_CALLS, type ClientCall, type ClientOperation } from "./calls.js";
export {
  type ApiTokenSummaryJSON,
  type ChallengeMethodJSON,
  type Client,
  type ClientOptions,
  type ClientSessionState,
  createClient,
  type FreshJSON,
  type IdentityEntryJSON,
  type IdentityListJSON,
  type InvitationJSON,
  type MemberJSON,
  type OAuthGrantJSON,
  type OrganizationJSON,
  type OrganizationTokenSummaryJSON,
  type PasskeySummaryJSON,
  type PasswordSignIn,
  type PublicUserJSON,
  type RoleJSON,
  type ScimTokenJSON,
  type SecondFactorEnableJSON,
  type SessionSummaryJSON,
  type SsoConnectionInput,
  type SsoConnectionJSON,
  type SsoDomainJSON,
  type TeamJSON,
  type TeamMemberJSON,
  type TotpStatusJSON,
  type TwoFactorChallengeJSON,
  type TwoFactorSessionJSON,
} from "./client.js";
export {
  DOCS_ORIGIN,
  ERROR_TEXT,
  ERROR_TEXTS,
  type ErrorTable,
  type ErrorTexts,
  errorAnchor,
  errorDocsURL,
  errorText,
  LOCALES,
  type Locale,
  resolveLocale,
  type SdkCode,
} from "./error-text.js";
export { readRedirectError } from "./redirect-error.js";
export type {
  ClientCode,
  ClientFailure,
  ClientResult,
  OAuthClientCode,
  OAuthFailure,
  OAuthResult,
} from "./result.js";
export {
  createSessionStore,
  SESSION_CHANNEL,
  type SessionState,
  type SessionStore,
} from "./store.js";
export { type Call, createTransport, type Query, type TransportOptions } from "./transport.js";
export {
  type BrowserWebAuthn,
  base64UrlDecode,
  base64UrlEncode,
  browserWebAuthn,
  type CeremonyOptions,
  type CredentialsContainerLike,
  credentialToJSON,
  type PasskeyExtensionResults,
  type PublicKeyCredentialLike,
  splitExtensionResults,
  supportsAutofill,
  supportsPasskeys,
  toBinaryCreationOptions,
  toBinaryRequestOptions,
  WebAuthnCancelled,
} from "./webauthn.js";
