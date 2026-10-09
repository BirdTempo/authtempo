export const VERSION = "0.0.0";

export type { AuthConfig, MailMessage, MailPort } from "./config.js";
export { ConfigError } from "./config.js";
export { type Auth, type AuthApi, createAuth } from "./create-auth.js";
export type { HandoffStart } from "./engine/handoff.js";
export type { MagicLinkRequest, MagicLinkVerify } from "./engine/magic-link.js";
export type { PasskeySummary } from "./engine/passkeys.js";
export type { PublicSession, ResolvedSession } from "./engine/sessions.js";
export type { SocialComplete, SocialStart, SocialStarted } from "./engine/social.js";
export { ERRORS, type ErrorCode } from "./errors.js";
export { type ConfirmPageInput, defaultConfirmPage } from "./http/confirm-page.js";
export {
  defaultHandoffConfirmPage,
  type HandoffConfirmPageInput,
} from "./http/handoff-confirm-page.js";
export { defaultSignInPage, type SignInPageInput } from "./http/sign-in-page.js";
export { createMemoryLimiter } from "./limiter/memory.js";
export type { LimiterPort, LimitWindow } from "./limiter/port.js";
export type { Clock } from "./primitives/clock.js";
export type { Result } from "./result.js";
export {
  type IdentityRow,
  type InvitationRow,
  type MemberRow,
  type ModelName,
  type Models,
  type OrganizationRow,
  type PasskeyRow,
  SCHEMA_VERSION,
  type SessionRow,
  schema,
  type UserRow,
  type VerificationRow,
} from "./schema.js";
export {
  createJoseJwtSeam,
  type JwtSeam,
  type SignES256Input,
  type VerifyIdTokenInput,
} from "./seams/jwt.js";
export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "./seams/webauthn.js";
export {
  type AuthenticatedPasskey,
  createSimpleWebAuthnSeam,
  type RegisteredPasskey,
  type WebAuthnSeam,
} from "./seams/webauthn.js";
export type { AppleConfig } from "./social/apple.js";
export type { GoogleConfig } from "./social/google.js";
export type { SocialProfile, SocialProviderName } from "./social/provider.js";
export { createMemoryAdapter } from "./storage/memory.js";
export {
  type FindManyOptions,
  type Op,
  type Sort,
  type StorageAdapter,
  StorageError,
  type Where,
} from "./storage/port.js";
