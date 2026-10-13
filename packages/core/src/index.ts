export const VERSION = "0.0.0";

export type {
  AuthConfig,
  EmailOtpConfig,
  LegacyVerifyConfig,
  MailMessage,
  MailPort,
  OrganizationLimits,
  OrganizationsConfig,
  PasswordConfig,
} from "./config.js";
export { ConfigError, DEFAULT_RESERVED_SLUGS, isAppScheme } from "./config.js";
export {
  type Auth,
  type AuthApi,
  createAuth,
  type EmailOtpApi,
  type PasswordApi,
  type TokensApi,
} from "./create-auth.js";
export type {
  EmailOtpRequest,
  EmailOtpReset,
  EmailOtpSession,
  EmailOtpVerify,
} from "./engine/email-otp.js";
export {
  defaultEmailOtpMail,
  defaultResetOtpMail,
  type EmailOtpMailInput,
} from "./engine/email-otp-mail.js";
export type { HandoffStart } from "./engine/handoff.js";
export {
  type Awaitable,
  HOOK_REFUSED_TEXT,
  HookRefusal,
  type HooksConfig,
  hookRefusal,
  type MemberVia,
  type OrganizationHookEvent,
  type OrganizationHooks,
  type OrganizationPatch,
  type ProposedMember,
  type RemoveVia,
  type SessionDraft,
  type SessionEndReason,
  type SessionHooks,
  type SessionPatch,
  type SessionVia,
} from "./engine/hooks.js";
export type { InvitationSummary } from "./engine/invitations.js";
export type { MagicLinkRequest, MagicLinkVerify } from "./engine/magic-link.js";
export type { MemberSummary, OrganizationSummary } from "./engine/organizations.js";
export { validOrganizationName } from "./engine/organizations.js";
export type { PasskeySummary } from "./engine/passkeys.js";
export type {
  PasswordChange,
  PasswordResend,
  PasswordReset,
  PasswordResetRequest,
  PasswordSession,
  PasswordSignIn,
  PasswordSignUp,
  PasswordVerified,
  PasswordVerify,
} from "./engine/password.js";
export { LEGACY_VERIFY_HASH, PENDING_HASH_PREFIX } from "./engine/password.js";
export { normalizeSlug, ROLE_RE, rankOf } from "./engine/ranks.js";
export { type PublicSession, type ResolvedSession, readSessionToken } from "./engine/sessions.js";
export type { SocialComplete, SocialStart, SocialStarted } from "./engine/social.js";
export type { SweepResult } from "./engine/sweep.js";
export {
  API_TOKEN_PREFIX,
  type ApiTokenCreate,
  type ApiTokenSummary,
  type Caller,
  type ResolvedApiToken,
} from "./engine/tokens.js";
export { normalizeEmail, validUserName } from "./engine/users.js";
export { ERRORS, type ErrorCode } from "./errors.js";
export { type ConfirmPageInput, defaultConfirmPage } from "./http/confirm-page.js";
export {
  defaultHandoffConfirmPage,
  type HandoffConfirmPageInput,
} from "./http/handoff-confirm-page.js";
export {
  defaultPasswordVerifyPage,
  defaultResetPage,
  type PasswordVerifyPageInput,
  type ResetPageInput,
} from "./http/password-pages.js";
export { defaultSignInPage, type SignInPageInput } from "./http/sign-in-page.js";
export { createMemoryLimiter, limiterKey } from "./limiter/memory.js";
export { KEY_SEPARATOR, type LimiterPort, type LimitWindow } from "./limiter/port.js";
export { type Clock, systemClock } from "./primitives/clock.js";
export {
  createDeriveGate,
  DERIVE_GATE_MAX,
  type DeriveGate,
  deriveGate,
} from "./primitives/derive-gate.js";
export { newId } from "./primitives/ids.js";
export type { Result } from "./result.js";
export {
  type ApiTokenRow,
  type IdentityRow,
  type InvitationRow,
  type MemberRow,
  type ModelName,
  type Models,
  type OrganizationRow,
  type PasskeyRow,
  type PasswordRow,
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
export {
  createPbkdf2PasswordHash,
  type PasswordHashSeam,
  PBKDF2_ITERATIONS,
} from "./seams/password-hash.js";
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
export { type GitHubConfig, isGithubSubject } from "./social/github.js";
export type { GoogleConfig } from "./social/google.js";
export type { LinkedInConfig } from "./social/linkedin.js";
export type { OAuth2Entry } from "./social/oauth2.js";
export type { OidcEndpoints, OidcEntry } from "./social/oidc.js";
export {
  PROVIDER_NAME_RE,
  type SocialProfile,
  type SocialProviderName,
} from "./social/provider.js";
export { createMemoryAdapter } from "./storage/memory.js";
export {
  type FindManyOptions,
  type Op,
  type Sort,
  type StorageAdapter,
  StorageError,
  type Where,
} from "./storage/port.js";
