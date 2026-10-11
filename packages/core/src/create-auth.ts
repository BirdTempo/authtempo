import { type AuthConfig, resolveConfig } from "./config.js";
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
  type MagicLinkRequest,
  type MagicLinkVerify,
  requestMagicLink,
  verifyMagicLink,
} from "./engine/magic-link.js";
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
  type PasswordResend,
  type PasswordReset,
  type PasswordResetRequest,
  type PasswordSession,
  type PasswordSignIn,
  type PasswordSignUp,
  type PasswordVerified,
  type PasswordVerify,
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resendPasswordVerification,
  resetPassword,
  verifyPasswordEmail,
} from "./engine/password.js";
import {
  destroySession,
  type PublicSession,
  type ResolvedSession,
  renewedSessionCookie,
  resolveSession,
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
import { ERRORS } from "./errors.js";
import { createRouter } from "./http/router.js";
import { handoffRoutes } from "./http/routes/handoff.js";
import { magicLinkRoutes } from "./http/routes/magic-link.js";
import { organizationRoutes } from "./http/routes/organizations.js";
import { passkeyRoutes } from "./http/routes/passkeys.js";
import { passwordRoutes } from "./http/routes/password.js";
import { sessionRoutes } from "./http/routes/sessions.js";
import { socialRoutes } from "./http/routes/social.js";
import { tokenRoutes } from "./http/routes/tokens.js";
import type { Result } from "./result.js";
import type { SessionRow, UserRow } from "./schema.js";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "./seams/webauthn.js";

/** Present on `api` only when the config has a `password` section. */
export interface PasswordApi {
  signUp(input: PasswordSignUp): Promise<Result<PasswordSession>>;
  signIn(input: PasswordSignIn): Promise<Result<PasswordSession>>;
  verifyEmail(input: PasswordVerify): Promise<Result<PasswordVerified>>;
  /** A new verify link for an unverified user with a password. Always `{ sent: true }`, except `rate_limited`. */
  resendVerification(input: PasswordResend): Promise<Result<{ sent: true }>>;
  requestReset(input: PasswordResetRequest): Promise<Result<{ sent: true }>>;
  reset(input: PasswordReset): Promise<Result<PasswordSession & { next: string }>>;
  change(input: PasswordChange): Promise<Result<{ ok: true }>>;
}

/** API tokens (plan 8b). Present in every deployment: tokens need no config key. */
export interface TokensApi {
  create(input: ApiTokenCreate): Promise<Result<{ token: string; apiToken: ApiTokenSummary }>>;
  list(input: { user: UserRow }): Promise<Result<ApiTokenSummary[]>>;
  revoke(input: { user: UserRow; id: string }): Promise<Result<{ ok: true }>>;
  /** The token's user and summary, or `unauthorized`. A `ts_` token answers `unauthorized`. */
  current(input: { token: string }): Promise<Result<ResolvedApiToken>>;
}

export interface AuthApi {
  /** Deletes rows that no flow can use any more. Call it from a scheduled handler. */
  sweepExpired(): Promise<SweepResult>;
  requestMagicLink(input: MagicLinkRequest): Promise<Result<{ sent: true }>>;
  verifyMagicLink(
    input: MagicLinkVerify,
  ): Promise<Result<{ token: string; next: string; user: UserRow }>>;
  startSocial(input: SocialStart): Promise<Result<SocialStarted>>;
  completeSocial(
    input: SocialComplete,
  ): Promise<Result<{ token: string; next: string; user: UserRow }>>;
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
  declineInvitation(input: { token: string }): Promise<Result<{ ok: true }>>;
  setActiveOrganization(input: {
    session: ResolvedSession;
    organizationId: string | null;
  }): Promise<Result<PublicSession>>;
  getSession(token: string): Promise<ResolvedSession | null>;
  signOut(token: string): Promise<void>;
  tokens: TokensApi;
  password?: PasswordApi;
}

export interface Auth {
  /** Serves the auth routes under `basePath`. Mount it for any request whose path starts with `basePath`. */
  handle(request: Request): Promise<Response>;
  /** The caller's session from the cookie or the bearer header, or null. */
  session(request: Request): Promise<ResolvedSession | null>;
  /**
   * The caller as a session or as an API token, or null. Use it in a route
   * that a script may call. `session(request)` stays session-only, so every
   * route that calls it answers 401 to a token.
   */
  caller(request: Request): Promise<Caller | null>;
  /**
   * The Set-Cookie value to send after `session(request)` when it moved the
   * expiry forward, else null. Send it on the response, or a browser drops
   * the cookie at its old Max-Age while the session row is still valid.
   * Null for a bearer request.
   */
  sessionCookie(request: Request, resolved: ResolvedSession): string | null;
  /** The same operations, in-process. */
  api: AuthApi;
  errors: typeof ERRORS;
}

export function createAuth(input: AuthConfig): Auth {
  const config = resolveConfig(input);
  const handle = createRouter(config, [
    ...sessionRoutes(config),
    ...magicLinkRoutes(config),
    ...socialRoutes(config),
    ...passkeyRoutes(config),
    ...passwordRoutes(config),
    ...handoffRoutes(config),
    ...organizationRoutes(config),
    ...tokenRoutes(config),
  ]);
  return {
    handle,
    session: (request) => sessionFromRequest(config, request),
    caller: (request) => callerFromRequest(config, request),
    sessionCookie: (request, resolved) => renewedSessionCookie(config, request, resolved),
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
            },
          }
        : {}),
    },
    errors: ERRORS,
  };
}
