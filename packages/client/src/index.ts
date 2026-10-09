export { ERRORS, type ErrorCode } from "@tempo-auth/core/errors";
export {
  type Client,
  type ClientOptions,
  createClient,
  type InvitationJSON,
  type MemberJSON,
  type OrganizationJSON,
  type PasskeySummaryJSON,
} from "./client.js";
export type { ClientCode, ClientFailure, ClientResult } from "./result.js";
export { type Call, createTransport, type TransportOptions } from "./transport.js";
export {
  type BrowserWebAuthn,
  base64UrlDecode,
  base64UrlEncode,
  browserWebAuthn,
  type CredentialsContainerLike,
  credentialToJSON,
  type PublicKeyCredentialLike,
  supportsPasskeys,
  toBinaryCreationOptions,
  toBinaryRequestOptions,
  WebAuthnCancelled,
} from "./webauthn.js";
