export { CORE_STATEMENTS, can, type RoleTable, type Statements } from "./access.js";
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
  AccountDeleteConfirmConfig,
  AccountNoticesConfig,
  AnonymousConfig,
  AuthConfig,
  DynamicRolesConfig,
  EmailOtpConfig,
  JwtMintConfig,
  LastMethodConfig,
  LegacyVerifyConfig,
  MailMessage,
  MailPort,
  MultiSessionConfig,
  OAuthConfig,
  OperatorConfig,
  OperatorScope,
  OperatorSecretEntry,
  OrganizationLimits,
  OrganizationsConfig,
  PasskeyConfig,
  PasskeyExtensions,
  PasswordConfig,
  PhoneConfig,
  PhoneMessageInput,
  ResolvedEmailOtp,
  ScimConfig,
  SsoConfig,
  TeamsConfig,
  TokensConfig,
  TotpConfig,
  TotpGateConfig,
  UsernameConfig,
} from "./config.js";
export {
  ConfigError,
  DEFAULT_RESERVED_SLUGS,
  DELETE_CONFIRM_TTL_MINUTES,
  defaultPhoneMessage,
  isAppScheme,
} from "./config.js";
export {
  type AnonymousApi,
  type Auth,
  type AuthApi,
  createAuth,
  crossSiteRefusal,
  type EmailOtpApi,
  type IdentitiesApi,
  type JwtApi,
  type OAuthApi,
  type OAuthClientsApi,
  type OrganizationTokensApi,
  type PasswordApi,
  type PhoneApi,
  type ScimApi,
  type SecretsApi,
  type SessionApi,
  type SsoApi,
  type SsoAppActor,
  type TokensApi,
  type TotpApi,
  type UserApi,
} from "./create-auth.js";
export type { AccountDelete } from "./engine/account-delete.js";
export { type AccountMailInput, defaultAccountMail } from "./engine/account-mail.js";
export {
  ANONYMOUS_REFUSED,
  type AnonymousDelete,
  type AnonymousSession,
  type AnonymousSignIn,
} from "./engine/anonymous.js";
export type { EmailChangeRequest } from "./engine/email-change.js";
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
  type OperatorHooks,
  type OrganizationHookEvent,
  type OrganizationHooks,
  type OrganizationPatch,
  type ProposedMember,
  type ProposedTeamMember,
  type RemoveVia,
  type SessionDraft,
  type SessionEndReason,
  type SessionHooks,
  type SessionPatch,
  type SessionVia,
  type TeamPatch,
  type UserCreatePatch,
  type UserCreateVia,
  type UserHooks,
  type UserPatch,
  type UserUpdateVia,
  type UserVerifyVia,
} from "./engine/hooks.js";
export type { IdentityEntry, IdentityList, IdentityUnlink } from "./engine/identities.js";
export type { InvitationSummary } from "./engine/invitations.js";
export type { MintedJwt, SessionJwtClaims } from "./engine/jwt.js";
export { LAST_METHODS, type LastMethod } from "./engine/last-method.js";
export type { MagicLinkRequest, MagicLinkVerify } from "./engine/magic-link.js";
export { defaultNoticeMail, type NoticeEvent, type NoticeMailInput } from "./engine/notices.js";
export { CLIENT_SECRET_PREFIX } from "./engine/oauth-client-secret.js";
export type { ClientInput, ClientSummary } from "./engine/oauth-client-store.js";
export type { ClientFields, RegisteredClient } from "./engine/oauth-clients.js";
export {
  CREDENTIALS_PER_CLIENT,
  type OAuthClientAccess,
} from "./engine/oauth-credentials.js";
export {
  DEVICE_GRANT,
  DEVICE_START_PER_IP,
  DEVICE_VERIFY_PER_CODE,
  DEVICE_VERIFY_PER_IP,
  DEVICE_VERIFY_PER_SESSION,
  type DeviceAuthorizationAnswer,
} from "./engine/oauth-device.js";
export type { OAuthGrantSummary } from "./engine/oauth-grants.js";
export type { OAuthResult } from "./engine/oauth-result.js";
export type { OAuthAccess, TokenAnswer } from "./engine/oauth-token.js";
export type { OperatorAuditDraft } from "./engine/operator/audit.js";
export { activeBan } from "./engine/operator/ban-rule.js";
export { holdsPlatformRole, type OperatorActor } from "./engine/operator/guards.js";
export type { OperatorApi } from "./engine/operator/index.js";
export type { OperatorUser } from "./engine/operator/users.js";
export {
  ORGANIZATION_TOKEN_CAP,
  ORGANIZATION_TOKEN_PREFIX,
  type OrganizationTokenCreate,
  type OrganizationTokenSummary,
  type OrganizationTokenUpdate,
  type ResolvedOrganizationToken,
} from "./engine/organization-tokens.js";
export type { MemberSummary, OrganizationSummary } from "./engine/organizations.js";
export { validOrganizationName } from "./engine/organizations.js";
export type { PasskeySignInExtensions } from "./engine/passkey-extensions.js";
export type { PasskeySummary } from "./engine/passkeys.js";
export type {
  ExistingAccountMailInput,
  PasswordChange,
  PasswordIdentifier,
  PasswordReauth,
  PasswordResend,
  PasswordReset,
  PasswordResetRequest,
  PasswordSession,
  PasswordSignIn,
  PasswordSignInFields,
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
export type { PermissionInput } from "./engine/permissions.js";
export {
  PHONE_RE,
  type PhoneAdd,
  type PhoneAddVerify,
  type PhoneRemove,
  type PhoneRequest,
  type PhoneSession,
  type PhoneVerify,
} from "./engine/phone.js";
export type { ProfileUpdate } from "./engine/profile.js";
export { normalizeSlug, ROLE_RE, rankOf } from "./engine/ranks.js";
export type { ReauthInput, ReauthProof } from "./engine/reauth.js";
export type { RoleSummary } from "./engine/roles.js";
export {
  SCIM_SCOPES,
  SCIM_TOKEN_PREFIX,
  type ScimTokenSummary,
} from "./engine/scim/tokens.js";
export type { SignInChallenge } from "./engine/second-factor.js";
export type { MethodEnabled } from "./engine/second-factor-methods.js";
export type { SecretsRewrap, SecretsStatus, SecretVersionCount } from "./engine/secrets.js";
export type { SessionSummary } from "./engine/session-list.js";
export {
  type PublicSession,
  type PublicUser,
  type ResolvedSession,
  readSessionToken,
} from "./engine/sessions.js";
export { SLUG_CHECK_PER_USER, type SlugStatus } from "./engine/slug-check.js";
export type {
  SocialComplete,
  SocialLinked,
  SocialLinkStart,
  SocialStart,
  SocialStarted,
} from "./engine/social.js";
export type {
  ConnectionFields,
  ConnectionInput,
  SsoConnectionSummary,
  SsoMfaInput,
} from "./engine/sso/connections.js";
export {
  type DnsTxtPort,
  DOH_BODY_MAX,
  dohCloudflare,
  dohGoogle,
} from "./engine/sso/dns.js";
export type { SsoDomainSummary } from "./engine/sso/domains.js";
export type { SweepResult } from "./engine/sweep.js";
export type { TeamMemberSummary, TeamSummary } from "./engine/teams.js";
export type { TokenQuota } from "./engine/token-use.js";
export {
  API_TOKEN_PREFIX,
  type ApiTokenCreate,
  type ApiTokenSummary,
  type ApiTokenUpdate,
  type AuthCode,
  type Caller,
  type ResolvedApiToken,
  validMetadata,
  validTokenName,
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
export { USERNAME_RE, type Username, type UsernameSet } from "./engine/username.js";
export { normalizeEmail, validImageUrl, validUserName } from "./engine/users.js";
export { ERRORS, type ErrorCode, OAUTH_ERRORS, type OAuthErrorCode } from "./errors.js";
export {
  type AccountDeletePageInput,
  defaultAccountDeletePage,
} from "./http/account-delete-page.js";
export { isJsonRequest } from "./http/body.js";
export { type ConfirmPageInput, defaultConfirmPage } from "./http/confirm-page.js";
export { type ConsentPageInput, defaultConsentPage } from "./http/consent-page.js";
export { DEFAULT_SESSION_COOKIE, LEGACY_SESSION_COOKIE } from "./http/cookies.js";
export { DEVICE_WARNING, type DevicePageInput, defaultDevicePage } from "./http/device-page.js";
export { defaultEmailChangePage, type EmailChangePageInput } from "./http/email-change-page.js";
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
export { ipKey, isIpLiteral } from "./limiter/ip-key.js";
export { createMemoryLimiter, limiterKey } from "./limiter/memory.js";
export { KEY_SEPARATOR, type LimiterPort, type LimitWindow } from "./limiter/port.js";
export type {
  AuthEvent,
  EventName,
  HandleOptions,
  ObserveConfig,
  ObserveSink,
  ObserveStats,
} from "./observe/port.js";
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
export { PASSKEY_HINTS, type PasskeyHint } from "./primitives/passkey-hints.js";
export type { Result } from "./result.js";
export {
  type ApiTokenRow,
  type ClientAuthMethod,
  type DeviceStatus,
  type IdentityRow,
  type InvitationRow,
  type JwkRow,
  type MemberRow,
  type ModelName,
  type Models,
  type MovedTokenRow,
  type OAuthClientRow,
  type OAuthConsentRow,
  type OAuthDeviceRow,
  type OAuthLogoutRow,
  type OAuthSessionClientRow,
  type OAuthSubjectRow,
  type OAuthTokenRow,
  type OperatorAction,
  type OperatorAuditRow,
  type OrganizationRoleRow,
  type OrganizationRow,
  type OrganizationTokenRow,
  type PasskeyRow,
  type PasswordRow,
  SCHEMA_VERSION,
  type ScimScope,
  type SecondFactorMethod,
  type SecondFactorRow,
  type SessionRow,
  schema,
  type TeamMemberRow,
  type TeamRow,
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
export type { SmsPort } from "./seams/sms.js";
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
export type { DiscordConfig } from "./social/discord.js";
export type { FacebookConfig } from "./social/facebook.js";
export { type GitHubConfig, isGithubSubject } from "./social/github.js";
export type { GitLabConfig } from "./social/gitlab.js";
export type { GoogleConfig } from "./social/google.js";
export type { LinkedInConfig } from "./social/linkedin.js";
export type { MicrosoftConfig } from "./social/microsoft.js";
export type { OAuth2Entry } from "./social/oauth2.js";
export type { OidcEndpoints, OidcEntry } from "./social/oidc.js";
export {
  COMING_PRESET_NAMES,
  PRESET_PROVIDER_NAMES,
  PROVIDER_NAME_RE,
  type SocialProfile,
  type SocialProviderName,
  type TokenRequestAnswer,
  type TokenRequestInput,
} from "./social/provider.js";
export type { SlackConfig } from "./social/slack.js";
export type { TwitterConfig } from "./social/twitter.js";
export { createMemoryAdapter } from "./storage/memory.js";
export {
  type FindManyOptions,
  type Op,
  type Sort,
  type StorageAdapter,
  StorageError,
  type Where,
} from "./storage/port.js";
export { VERSION } from "./version.js";
