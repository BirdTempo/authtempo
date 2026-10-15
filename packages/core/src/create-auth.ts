import { type AuthConfig, resolveConfig } from "./config.js";
import {
  type EmailOtpRequest,
  type EmailOtpReset,
  type EmailOtpSession,
  type EmailOtpVerify,
  requestEmailOtp,
  requestResetOtp,
  resetPasswordWithOtp,
  verifyEmailOtp,
} from "./engine/email-otp.js";
import {
  continueHandoff,
  type HandoffStart,
  redeemHandoff,
  startHandoff,
} from "./engine/handoff.js";
import {
  acceptInvitation,
  declineInvitation,
  type InvitationSummary,
  inviteMember,
  listInvitations,
  revokeInvitation,
  setActiveOrganization,
} from "./engine/invitations.js";
import {
  type MintedJwt,
  mintSessionJwt,
  publicKeySet,
  rotateKey,
  type SessionJwtClaims,
  sessionLive,
  verifySessionJwt,
} from "./engine/jwt.js";
import {
  type MagicLinkRequest,
  type MagicLinkVerify,
  requestMagicLink,
  verifyMagicLink,
} from "./engine/magic-link.js";
import { listGrants, type OAuthGrantSummary, revokeGrant } from "./engine/oauth-grants.js";
import {
  addMember,
  createOrganization,
  deleteOrganization,
  listMembers,
  listOrganizations,
  type MemberSummary,
  type OrganizationSummary,
  removeMember,
  updateMemberRole,
  updateOrganization,
} from "./engine/organizations.js";
import {
  deletePasskey,
  listPasskeys,
  type PasskeySummary,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "./engine/passkeys.js";
import {
  changePassword,
  type PasswordChange,
  type PasswordReauth,
  type PasswordResend,
  type PasswordReset,
  type PasswordResetRequest,
  type PasswordSignIn,
  type PasswordSignInResult,
  type PasswordSignUp,
  type PasswordSignUpResult,
  type PasswordVerified,
  type PasswordVerify,
  passwordSignIn,
  passwordSignUp,
  type ResetResult,
  requestPasswordReset,
  resendPasswordVerification,
  resetPassword,
  verifyPassword,
  verifyPasswordEmail,
} from "./engine/password.js";
import type { SignInChallenge } from "./engine/second-factor.js";
import {
  rewrapSecrets,
  type SecretsRewrap,
  type SecretsStatus,
  secretsStatus,
} from "./engine/secrets.js";
import {
  destroySession,
  type PublicSession,
  type ResolvedSession,
  renewedSessionCookie,
  resolveSession,
  type SessionReadOptions,
  sessionFromRequest,
} from "./engine/sessions.js";
import {
  completeSocial,
  type SocialComplete,
  type SocialStart,
  type SocialStarted,
  startSocial,
} from "./engine/social.js";
import { type SweepResult, sweepExpired } from "./engine/sweep.js";
import {
  type ApiTokenCreate,
  type ApiTokenSummary,
  type Caller,
  callerFromRequest,
  createApiToken,
  currentApiToken,
  listApiTokens,
  type ResolvedApiToken,
  revokeApiToken,
} from "./engine/tokens.js";
import {
  disableTotp,
  disableTotpWithCode,
  enableTotp,
  regenerateBackupCodes,
  regenerateBackupCodesWithCode,
  revokeTrustedDevices,
  setupTotp,
  type TotpSetup,
  type TotpSetupInput,
  type TotpStatus,
  type TwoFactorPending,
  type TwoFactorSession,
  type TwoFactorVerify,
  totpStatus,
  totpUri,
  verifyTwoFactor,
} from "./engine/totp.js";
import { ERRORS } from "./errors.js";
import { createRouter } from "./http/router.js";
import { coreRoutes } from "./http/routes/index.js";
import { createWellKnownHandler } from "./http/well-known.js";
import type { PublicJwk } from "./primitives/jwk.js";
import type { Result } from "./result.js";
import type { SessionRow, UserRow } from "./schema.js";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "./seams/webauthn.js";

/** Present on `api` only when the config has a `password` section. */
export interface PasswordApi {
  /**
   * `{ sent: true }` for every address while `password.uniformSignUp` is on
   * (the default, plan 12b). With it off: a session, or `{ user,
   * verifyRequired: true }` while `password.requireVerified` is on.
   */
  signUp(input: PasswordSignUp): Promise<Result<PasswordSignUpResult>>;
  /** A session, or `{ twoFactor }` for a user with the second factor on (plan 9f). */
  signIn(input: PasswordSignIn): Promise<Result<PasswordSignInResult>>;
  /** The password of a known user again, with the sign-in's limits (plan 9f). */
  verify(input: PasswordReauth): Promise<Result<{ verified: true }>>;
  verifyEmail(input: PasswordVerify): Promise<Result<PasswordVerified>>;
  /** A new verify link for an unverified user with a password. Always `{ sent: true }`, except `rate_limited`. */
  resendVerification(input: PasswordResend): Promise<Result<{ sent: true }>>;
  requestReset(input: PasswordResetRequest): Promise<Result<{ sent: true }>>;
  reset(input: PasswordReset): Promise<Result<ResetResult>>;
  change(input: PasswordChange): Promise<Result<{ ok: true }>>;
}

/**
 * The second factor (plan 9f). Present when `totp` resolves: `password` is
 * set and `totp` is not `false`. The forms with a user id and no code are
 * for an app that checked the person another way first, such as with
 * `api.password.verify`.
 */
export interface TotpApi {
  /** Takes the user's password: `invalid_credentials` on a miss, with the sign-in's limits. */
  setup(input: TotpSetupInput): Promise<Result<TotpSetup>>;
  enable(input: { session: ResolvedSession; code: string }): Promise<Result<TotpStatus>>;
  verify(input: TwoFactorVerify): Promise<Result<TwoFactorSession>>;
  disable(input: { userId: string }): Promise<Result<{ ok: true }>>;
  disableWithCode(input: { user: UserRow; code: string }): Promise<Result<{ ok: true }>>;
  regenerateBackupCodes(input: { userId: string }): Promise<Result<{ backupCodes: string[] }>>;
  regenerateBackupCodesWithCode(input: {
    user: UserRow;
    code: string;
  }): Promise<Result<{ backupCodes: string[] }>>;
  status(input: { userId: string }): Promise<Result<TotpStatus>>;
  /** The key URI of a factor that is on. In process only: no route answers it after the setup. */
  uri(input: { userId: string }): Promise<Result<{ uri: string }>>;
  revokeTrustedDevices(input: { userId: string }): Promise<Result<{ ok: true }>>;
}

/**
 * JWT minting (plan 9g, spec 8.12). Present unless `jwtMint` is `false`.
 * `verify` checks a session JWT of this instance only: the signature, the
 * issuer, an audience of `jwtMint.audience`, and `exp`.
 */
export interface JwtApi {
  mint(input: { userId: string; sessionId: string }): Promise<Result<MintedJwt>>;
  verify(token: string): Promise<SessionJwtClaims | null>;
  /** A new signing key. The old one retires: it verifies for 24 hours and signs nothing. */
  rotate(): Promise<{ kid: string }>;
  jwks(): Promise<{ keys: PublicJwk[] }>;
  /**
   * True while the session of `sid` exists and is not expired. A resource
   * server that must end access at a sign-out checks the `sid` of a
   * verified session JWT here (plan 9g final fix wave).
   */
  sessionLive(input: { sid: string }): Promise<boolean>;
}

/**
 * The OAuth grants of a user (plan 9g final fix wave). Present when `oauth`
 * is set. A grant is one consent of the user for one client, with the
 * client's refresh tokens. `revoke` deletes the consent and every refresh
 * token of the user and the client, and answers `{ ok: true }` also when
 * nothing existed. An access token that a client holds lives on to its
 * `exp`, at most `oauth.accessTtlMinutes`.
 */
export interface OAuthApi {
  grants(input: { userId: string }): Promise<Result<OAuthGrantSummary[]>>;
  revoke(input: { userId: string; clientId: string }): Promise<Result<{ ok: true }>>;
}

/** API tokens (plan 8b). Present in every deployment: tokens need no config key. */
export interface TokensApi {
  create(input: ApiTokenCreate): Promise<Result<{ token: string; apiToken: ApiTokenSummary }>>;
  list(input: { user: UserRow }): Promise<Result<ApiTokenSummary[]>>;
  revoke(input: { user: UserRow; id: string }): Promise<Result<{ ok: true }>>;
  /** The token's user and summary, or `unauthorized`. A `ts_` token answers `unauthorized`. */
  current(input: { token: string }): Promise<Result<ResolvedApiToken>>;
}

/**
 * The app secrets (plan 12b, spec 22). Present in every deployment, in
 * process only: no route answers them. The rotation runbook runs passes of
 * `rewrap` and reads `status` before it removes a version.
 */
export interface SecretsApi {
  status(): Promise<SecretsStatus>;
  /**
   * `limit`: 1 to 1000 rows, default 100. `after`: the `next` of the call
   * before, to go on with the pass. `invalid_body` for a limit outside that
   * range or a cursor that `rewrap` did not answer.
   */
  rewrap(input?: { limit?: number; after?: string }): Promise<Result<SecretsRewrap>>;
}

/** Present on `api` unless the config sets `emailOtp: false` (plan 9e). */
export interface EmailOtpApi {
  /** A sign-in code. Always `{ sent: true }`, except `rate_limited`. */
  request(input: EmailOtpRequest): Promise<Result<{ sent: true }>>;
  verify(input: EmailOtpVerify): Promise<Result<EmailOtpSession | TwoFactorPending>>;
  /** A reset code. `not_found` without a `password` config. */
  requestReset(input: EmailOtpRequest): Promise<Result<{ sent: true }>>;
  /** The reset by code. `not_found` without a `password` config. */
  reset(input: EmailOtpReset): Promise<Result<EmailOtpSession | TwoFactorPending>>;
}

export interface AuthApi {
  /** Deletes rows that no flow can use any more. Call it from a scheduled handler. */
  sweepExpired(): Promise<SweepResult>;
  requestMagicLink(input: MagicLinkRequest): Promise<Result<{ sent: true }>>;
  verifyMagicLink(
    input: MagicLinkVerify,
  ): Promise<Result<{ token: string; next: string; user: UserRow } | SignInChallenge>>;
  startSocial(input: SocialStart): Promise<Result<SocialStarted>>;
  completeSocial(
    input: SocialComplete,
  ): Promise<Result<{ token: string; next: string; user: UserRow } | SignInChallenge>>;
  passkeyRegistrationOptions(input: {
    user: UserRow;
  }): Promise<Result<PublicKeyCredentialCreationOptionsJSON>>;
  verifyPasskeyRegistration(input: {
    user: UserRow;
    response: unknown;
    name?: string | undefined;
  }): Promise<Result<PasskeySummary>>;
  passkeyAuthenticationOptions(input: {
    ip: string | null;
  }): Promise<Result<PublicKeyCredentialRequestOptionsJSON>>;
  verifyPasskeyAuthentication(input: {
    response: unknown;
    ip: string | null;
    userAgent: string | null;
  }): Promise<Result<{ token: string; user: UserRow; session: SessionRow }>>;
  listPasskeys(input: { user: UserRow }): Promise<Result<PasskeySummary[]>>;
  deletePasskey(input: { user: UserRow; id: string }): Promise<Result<{ ok: true }>>;
  startHandoff(input: HandoffStart): Promise<Result<{ handoffId: string }>>;
  continueHandoff(input: {
    handoffId: string;
    userId: string;
    /** The browser session the caller checked. A claim that deleted it undoes the code. */
    sessionId: string;
  }): Promise<Result<{ location: string }>>;
  redeemHandoff(input: {
    code: string;
    verifier: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<Result<{ token: string; user: UserRow; session: SessionRow }>>;
  createOrganization(input: {
    user: UserRow;
    slug: string;
    name: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<Result<{ organization: OrganizationSummary; member: MemberSummary }>>;
  listOrganizations(input: {
    user: UserRow;
  }): Promise<Result<{ organization: OrganizationSummary; role: string }[]>>;
  updateOrganization(input: {
    user: UserRow;
    organizationId: string;
    name?: string;
    slug?: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<Result<OrganizationSummary>>;
  deleteOrganization(input: {
    user: UserRow;
    organizationId: string;
  }): Promise<Result<{ ok: true }>>;
  listMembers(input: { user: UserRow; organizationId: string }): Promise<Result<MemberSummary[]>>;
  addMember(input: {
    user: UserRow;
    organizationId: string;
    userId: string;
    role: string;
  }): Promise<Result<MemberSummary>>;
  updateMemberRole(input: {
    user: UserRow;
    organizationId: string;
    userId: string;
    role: string;
  }): Promise<Result<MemberSummary>>;
  removeMember(input: {
    user: UserRow;
    organizationId: string;
    userId: string;
  }): Promise<Result<{ ok: true }>>;
  inviteMember(input: {
    user: UserRow;
    organizationId: string;
    email: string;
    role: string;
  }): Promise<Result<InvitationSummary>>;
  listInvitations(input: {
    user: UserRow;
    organizationId: string;
  }): Promise<Result<InvitationSummary[]>>;
  revokeInvitation(input: {
    user: UserRow;
    organizationId: string;
    invitationId: string;
  }): Promise<Result<{ ok: true }>>;
  acceptInvitation(input: {
    user: UserRow;
    token: string;
    ip: string | null;
  }): Promise<Result<{ organization: OrganizationSummary; member: MemberSummary }>>;
  /** `user`: the caller's user when there is a session, for the after hook (plan 9d). Not checked against the address. */
  declineInvitation(input: { token: string; user?: UserRow | null }): Promise<Result<{ ok: true }>>;
  setActiveOrganization(input: {
    session: ResolvedSession;
    organizationId: string | null;
  }): Promise<Result<PublicSession>>;
  getSession(token: string): Promise<ResolvedSession | null>;
  signOut(token: string): Promise<void>;
  tokens: TokensApi;
  secrets: SecretsApi;
  password?: PasswordApi;
  emailOtp?: EmailOtpApi;
  totp?: TotpApi;
  jwt?: JwtApi;
  oauth?: OAuthApi;
}

export interface Auth {
  /** Serves the auth routes under `basePath`. Mount it for any request whose path starts with `basePath`. */
  handle(request: Request): Promise<Response>;
  /**
   * The caller's session from the cookie or the bearer header, or null.
   * With `{ refresh: false }` it is a read with no write: no sliding refresh
   * and no delete of an ended row. A server render that cannot set a cookie
   * reads this way, so the browser's `GET /session` still gets the renewed cookie.
   */
  session(request: Request, options?: SessionReadOptions): Promise<ResolvedSession | null>;
  /**
   * The caller as a session, an API token, or an OAuth access token (plan
   * 9g), or null. Use it in a route that a script or an OAuth client may
   * call. An access token passes only under its resource: the request URL
   * must fall under the `oauth.resources` entry that is its `aud`.
   * `session(request)` stays session-only, so every route that calls it
   * answers 401 to a token. For a session caller, send
   * `sessionCookie(request, caller)`, or the browser drops the cookie at its old Max-Age.
   */
  caller(request: Request): Promise<Caller | null>;
  /**
   * The Set-Cookie value to send after `session(request)` or `caller(request)` when it moved the
   * expiry forward, else null. Send it on the response, or a browser drops
   * the cookie at its old Max-Age while the session row is still valid.
   * Null for a bearer request.
   */
  sessionCookie(request: Request, resolved: ResolvedSession): string | null;
  /**
   * The well-known documents at the origin root (plan 9g): RFC 8414 and
   * OIDC Discovery for this issuer, and RFC 9728 for each `oauth.resources`
   * entry. Mount it for the paths that start with `/.well-known/`. 404 for
   * any other path and while `oauth` is off; 405 for a method other than GET.
   */
  wellKnown(request: Request): Promise<Response>;
  /** The same operations, in-process. */
  api: AuthApi;
  errors: typeof ERRORS;
}

export function createAuth(input: AuthConfig): Auth {
  const config = resolveConfig(input);
  const handle = createRouter(config, coreRoutes(config));
  return {
    handle,
    session: (request, options) => sessionFromRequest(config, request, options),
    caller: (request) => callerFromRequest(config, request),
    sessionCookie: (request, resolved) => renewedSessionCookie(config, request, resolved),
    wellKnown: createWellKnownHandler(config),
    api: {
      sweepExpired: () => sweepExpired(config),
      requestMagicLink: (i) => requestMagicLink(config, i),
      verifyMagicLink: (i) => verifyMagicLink(config, i),
      startSocial: (i) => startSocial(config, i),
      completeSocial: (i) => completeSocial(config, i),
      passkeyRegistrationOptions: (i) => passkeyRegistrationOptions(config, i),
      verifyPasskeyRegistration: (i) => verifyPasskeyRegistration(config, i),
      passkeyAuthenticationOptions: (i) => passkeyAuthenticationOptions(config, i),
      verifyPasskeyAuthentication: (i) => verifyPasskeyAuthentication(config, i),
      listPasskeys: (i) => listPasskeys(config, i),
      deletePasskey: (i) => deletePasskey(config, i),
      startHandoff: (i) => startHandoff(config, i),
      continueHandoff: (i) => continueHandoff(config, i),
      redeemHandoff: (i) => redeemHandoff(config, i),
      createOrganization: (i) => createOrganization(config, i),
      listOrganizations: (i) => listOrganizations(config, i),
      updateOrganization: (i) => updateOrganization(config, i),
      deleteOrganization: (i) => deleteOrganization(config, i),
      listMembers: (i) => listMembers(config, i),
      addMember: (i) => addMember(config, i),
      updateMemberRole: (i) => updateMemberRole(config, i),
      removeMember: (i) => removeMember(config, i),
      inviteMember: (i) => inviteMember(config, i),
      listInvitations: (i) => listInvitations(config, i),
      revokeInvitation: (i) => revokeInvitation(config, i),
      acceptInvitation: (i) => acceptInvitation(config, i),
      declineInvitation: (i) => declineInvitation(config, i),
      setActiveOrganization: (i) => setActiveOrganization(config, i),
      getSession: (token) => resolveSession(config, token),
      signOut: (token) => destroySession(config, token),
      tokens: {
        create: (i) => createApiToken(config, i),
        list: (i) => listApiTokens(config, i),
        revoke: (i) => revokeApiToken(config, i),
        current: (i) => currentApiToken(config, i),
      },
      secrets: {
        status: () => secretsStatus(config),
        rewrap: (i) => rewrapSecrets(config, i),
      },
      ...(config.password
        ? {
            password: {
              signUp: (i) => passwordSignUp(config, i),
              signIn: (i) => passwordSignIn(config, i),
              verifyEmail: (i) => verifyPasswordEmail(config, i),
              resendVerification: (i) => resendPasswordVerification(config, i),
              requestReset: (i) => requestPasswordReset(config, i),
              reset: (i) => resetPassword(config, i),
              change: (i) => changePassword(config, i),
              verify: (i) => verifyPassword(config, i),
            },
          }
        : {}),
      ...(config.emailOtp
        ? {
            emailOtp: {
              request: (i) => requestEmailOtp(config, i),
              verify: (i) => verifyEmailOtp(config, i),
              requestReset: (i) => requestResetOtp(config, i),
              reset: (i) => resetPasswordWithOtp(config, i),
            },
          }
        : {}),
      ...(config.totp
        ? {
            totp: {
              setup: (i) => setupTotp(config, i),
              enable: (i) => enableTotp(config, i),
              verify: (i) => verifyTwoFactor(config, i),
              disable: (i) => disableTotp(config, i),
              disableWithCode: (i) => disableTotpWithCode(config, i),
              regenerateBackupCodes: (i) => regenerateBackupCodes(config, i),
              regenerateBackupCodesWithCode: (i) => regenerateBackupCodesWithCode(config, i),
              status: (i) => totpStatus(config, i),
              uri: (i) => totpUri(config, i),
              revokeTrustedDevices: (i) => revokeTrustedDevices(config, i),
            } satisfies TotpApi,
          }
        : {}),
      ...(config.jwtMint
        ? {
            jwt: {
              mint: (i) => mintSessionJwt(config, i),
              verify: (token) => verifySessionJwt(config, token),
              rotate: () => rotateKey(config),
              jwks: () => publicKeySet(config),
              sessionLive: (i) => sessionLive(config, i),
            } satisfies JwtApi,
          }
        : {}),
      ...(config.oauth
        ? {
            oauth: {
              grants: (i) => listGrants(config, i),
              revoke: (i) => revokeGrant(config, i),
            } satisfies OAuthApi,
          }
        : {}),
    },
    errors: ERRORS,
  };
}
