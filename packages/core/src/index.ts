export const VERSION = "0.0.0";

export {
  CAPTCHA_FLOWS,
  CAPTCHA_HEADER,
  CAPTCHA_TOKEN_MAX,
  type CaptchaConfig,
  type CaptchaFlow,
  type CaptchaPage,
  type CaptchaPort,
  checkCaptcha,
  DEFAULT_CAPTCHA_FLOWS,
} from "./captcha.js";
export type {
  AccountConfig,
  AccountNoticesConfig,
  AuthConfig,
  EmailOtpConfig,
  JwtMintConfig,
  LegacyVerifyConfig,
  MailMessage,
  MailPort,
  OAuthConfig,
  OperatorConfig,
  OrganizationLimits,
  OrganizationsConfig,
  PasswordConfig,
  ResolvedEmailOtp,
  TotpConfig,
  TotpGateConfig,
} from "./config.js";
export { ConfigError, DEFAULT_RESERVED_SLUGS, isAppScheme } from "./config.js";
export {
  type Auth,
  type AuthApi,
  createAuth,
  type EmailOtpApi,
  type JwtApi,
  type OAuthApi,
  type PasswordApi,
  type SecretsApi,
  type SessionApi,
  type TokensApi,
  type TotpApi,
} from "./create-auth.js";
export { type AccountMailInput, defaultAccountMail } from "./engine/account-mail.js";
export type {
  EmailOtpRequest,
  EmailOtpReset,
  EmailOtpSession,
  EmailOtpVerify,
} from "./engine/email-otp.js";
export {
  defaultEmailOtpMail,
  defaultResetOtpMail,
  defaultSecondFactorMail,
  type EmailOtpMailInput,
} from "./engine/email-otp-mail.js";
export type { HandoffStart } from "./engine/handoff.js";
export {
  type Awaitable,
  HOOK_REFUSED_TEXT,
  HookRefusal,
  type HooksConfig,
  hookRefusal,
  type IdentityHooks,
  type IdentityLinkVia,
  type IdentitySummary,
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
  type UserCreatePatch,
  type UserCreateVia,
  type UserHooks,
  type UserPatch,
  type UserUpdateVia,
} from "./engine/hooks.js";
export type { InvitationSummary } from "./engine/invitations.js";
export type { MintedJwt, SessionJwtClaims } from "./engine/jwt.js";
export type { MagicLinkRequest, MagicLinkVerify } from "./engine/magic-link.js";
export { defaultNoticeMail, type NoticeEvent, type NoticeMailInput } from "./engine/notices.js";
export type { OAuthGrantSummary } from "./engine/oauth-grants.js";
export type { OAuthAccess, TokenAnswer } from "./engine/oauth-token.js";
export type { MemberSummary, OrganizationSummary } from "./engine/organizations.js";
export { validOrganizationName } from "./engine/organizations.js";
export type { PasskeySummary } from "./engine/passkeys.js";
export type {
  ExistingAccountMailInput,
  PasswordChange,
  PasswordReauth,
  PasswordResend,
  PasswordReset,
  PasswordResetRequest,
  PasswordSession,
  PasswordSignIn,
  PasswordSignInResult,
  PasswordSignUp,
  PasswordSignUpPending,
  PasswordSignUpResult,
  PasswordVerified,
  PasswordVerify,
  ResetChallenge,
  ResetResult,
} from "./engine/password.js";
export {
  defaultExistingAccountMail,
  LEGACY_VERIFY_HASH,
  PENDING_HASH_PREFIX,
} from "./engine/password.js";
export { normalizeSlug, ROLE_RE, rankOf } from "./engine/ranks.js";
export type { ReauthInput, ReauthProof } from "./engine/reauth.js";
export type { SignInChallenge } from "./engine/second-factor.js";
export type { MethodEnabled } from "./engine/second-factor-methods.js";
export type { SecretsRewrap, SecretsStatus, SecretVersionCount } from "./engine/secrets.js";
export type { SessionSummary } from "./engine/session-list.js";
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
export type {
  ChallengeMethod,
  ChallengeView,
  TotpSetup,
  TotpSetupInput,
  TotpStatus,
  TwoFactorPending,
  TwoFactorSession,
  TwoFactorVerify,
} from "./engine/totp.js";
/** The shape of a `tf_` challenge token (plan 9f): the compat shim checks a cookie against it before core's verify. */
export { TWO_FACTOR_TOKEN_RE } from "./engine/totp.js";
export { normalizeEmail, validImageUrl, validUserName } from "./engine/users.js";
export { ERRORS, type ErrorCode, OAUTH_ERRORS, type OAuthErrorCode } from "./errors.js";
export { type ConfirmPageInput, defaultConfirmPage } from "./http/confirm-page.js";
export { type ConsentPageInput, defaultConsentPage } from "./http/consent-page.js";
export { DEFAULT_SESSION_COOKIE, LEGACY_SESSION_COOKIE } from "./http/cookies.js";
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
export { defaultTotpPage, type TotpChallengePageInput } from "./http/totp-page.js";
export { ipKey } from "./limiter/ip-key.js";
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
export type { JwsAlg, PublicJwk } from "./primitives/jwk.js";
export type { Keyring, SecretVersion } from "./primitives/keyring.js";
export type { Result } from "./result.js";
export {
  type ApiTokenRow,
  type IdentityRow,
  type InvitationRow,
  type JwkRow,
  type MemberRow,
  type ModelName,
  type Models,
  type OAuthClientRow,
  type OAuthConsentRow,
  type OAuthTokenRow,
  type OrganizationRow,
  type PasskeyRow,
  type PasswordRow,
  SCHEMA_VERSION,
  type SecondFactorMethod,
  type SecondFactorRow,
  type SessionRow,
  schema,
  type TotpRow,
  type TrustedDeviceRow,
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
