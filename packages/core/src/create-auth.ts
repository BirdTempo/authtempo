import type { Statements } from "./access.js";
import {
  carryDomainRecord,
  type DomainRecordOf,
  domainRecordFor,
  markRecordVerify,
  setConfigDomainRecord,
  setScimCaller,
} from "./compat-seams.js";
import { type AuthConfig, type ResolvedConfig, resolveConfig } from "./config.js";
import {
  type AccountDelete,
  confirmAccountDelete,
  startAccountDelete,
} from "./engine/account-delete.js";
import {
  confirmEmailChange,
  type EmailChangeRequest,
  requestEmailChange,
  verifyEmailChange,
} from "./engine/email-change.js";
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
import { requireFresh } from "./engine/fresh.js";
import {
  continueHandoff,
  type HandoffStart,
  redeemHandoff,
  startHandoff,
} from "./engine/handoff.js";
import {
  type IdentityList,
  type IdentityUnlink,
  listIdentities,
  unlinkIdentity,
} from "./engine/identities.js";
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
import {
  type ClientInput,
  type ClientSummary,
  createClient,
  deleteClient,
  getClient,
  listClients,
  rotateClientSecret,
  updateClient,
} from "./engine/oauth-client-store.js";
import { listGrants, type OAuthGrantSummary, revokeGrant } from "./engine/oauth-grants.js";
import { deliverLogouts } from "./engine/oauth-logout.js";
import type { OAuthResult } from "./engine/oauth-result.js";
import { checkActor } from "./engine/operator/guards.js";
import { refuseImpersonation } from "./engine/operator/impersonation.js";
import { type OperatorApi, operatorApi } from "./engine/operator/index.js";
import {
  createOrganizationToken,
  currentOrganizationToken,
  listOrganizationTokens,
  type OrganizationTokenCreate,
  type OrganizationTokenSummary,
  type OrganizationTokenUpdate,
  type ResolvedOrganizationToken,
  revokeOrganizationToken,
  updateOrganizationToken,
} from "./engine/organization-tokens.js";
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
import type { PasskeySignInExtensions } from "./engine/passkey-extensions.js";
import {
  deletePasskey,
  listPasskeys,
  type PasskeySummary,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  renamePasskey,
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
import { hasPermission, type PermissionInput, permissionsOf } from "./engine/permissions.js";
import {
  addPhone,
  type PhoneAdd,
  type PhoneAddVerify,
  type PhoneRemove,
  type PhoneRequest,
  type PhoneSession,
  type PhoneVerify,
  removePhone,
  requestPhone,
  verifyAddPhone,
  verifyPhone,
} from "./engine/phone.js";
import { type ProfileUpdate, updateProfile } from "./engine/profile.js";
import {
  type ReauthInput,
  reauthenticate,
  reauthPasskeyOptions,
  requestReauthCode,
} from "./engine/reauth.js";
import {
  createRole,
  deleteRole,
  getRole,
  listRoles,
  type RoleSummary,
  updateRole,
} from "./engine/roles.js";
import {
  scimCreateGroup,
  scimDeleteGroup,
  scimGetGroup,
  scimListGroups,
  scimPatchGroup,
  scimReplaceGroup,
} from "./engine/scim/groups.js";
import {
  createScimToken,
  listScimTokens,
  revokeScimToken,
  SCIM_SCOPES,
  type ScimTokenSummary,
} from "./engine/scim/tokens.js";
import {
  type ScimResult,
  scimCreateUser,
  scimDeleteUser,
  scimGetUser,
  scimListUsers,
  scimPatchUser,
  scimReplaceUser,
} from "./engine/scim/users.js";
import type { SignInChallenge } from "./engine/second-factor.js";
import {
  rewrapSecrets,
  type SecretsRewrap,
  type SecretsStatus,
  secretsStatus,
} from "./engine/secrets.js";
import {
  listSessions,
  revokeOtherSessions,
  revokeSession,
  type SessionSummary,
} from "./engine/session-list.js";
import {
  destroySession,
  type PublicSession,
  type PublicUser,
  type ResolvedSession,
  renewedSessionCookie,
  resolveSession,
  type SessionReadOptions,
  sessionFromRequest,
} from "./engine/sessions.js";
import { checkSlug, type SlugStatus } from "./engine/slug-check.js";
import {
  completeSocial,
  type SocialComplete,
  type SocialLinked,
  type SocialLinkStart,
  type SocialStart,
  type SocialStarted,
  startLink,
  startSocial,
} from "./engine/social.js";
import {
  type ConnectionFields,
  type ConnectionInput,
  createConnection,
  deleteConnection,
  listConnections,
  type SsoConnectionSummary,
  setRoleMap,
  updateConnection,
} from "./engine/sso/connections.js";
import {
  addDomain,
  deleteDomain,
  listDomains,
  type SsoDomainSummary,
  updateDomain,
  verifyDomain,
} from "./engine/sso/domains.js";
import { type SweepResult, sweepExpired } from "./engine/sweep.js";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeamMembers,
  listTeams,
  listUserTeams,
  removeTeamMember,
  setActiveTeam,
  type TeamMemberSummary,
  type TeamSummary,
  updateTeam,
} from "./engine/teams.js";
import {
  type ApiTokenCreate,
  type ApiTokenSummary,
  type ApiTokenUpdate,
  authenticateRequest,
  type Caller,
  callerFromRequest,
  createApiToken,
  currentApiToken,
  listApiTokens,
  type ResolvedApiToken,
  revokeApiToken,
  updateApiToken,
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
import {
  setUsername,
  type Username,
  type UsernameSet,
  usernameAvailable,
} from "./engine/username.js";
import { ERRORS } from "./errors.js";
import { createPostGate, createRouter } from "./http/router.js";
import { coreRoutes } from "./http/routes/index.js";
import { createWellKnownHandler } from "./http/well-known.js";
import { unscopedOf } from "./observe/observer.js";
import type { HandleOptions, ObserveStats } from "./observe/port.js";
import type { PublicJwk } from "./primitives/jwk.js";
import type { PasskeyHint } from "./primitives/passkey-hints.js";
import { fail, type Result } from "./result.js";
import type { ScimScope, SessionRow, UserRow } from "./schema.js";
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
  /** Applies no fresh rule: call `api.session.requireFresh` first (plan 12a). */
  disableWithCode(input: { user: UserRow; code: string }): Promise<Result<{ ok: true }>>;
  regenerateBackupCodes(input: { userId: string }): Promise<Result<{ backupCodes: string[] }>>;
  /** Applies no fresh rule: call `api.session.requireFresh` first (plan 12a). */
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
/** The app as the actor of an SSO call in process (plan 12d). The name follows the operator app rule. */
export type SsoAppActor = { kind: "app"; name: string };

/**
 * The SSO setup in process (plan 12d, spec 30). Present when `sso` is set.
 * Each call takes the app as its actor and writes the audit rows of the
 * routes. An app name outside 1 to 64 characters of `[a-z0-9_.-]` answers
 * `invalid_body`.
 */
export interface SsoApi {
  domains: {
    /** The domains of an organization, oldest first. */
    list(input: {
      actor: SsoAppActor;
      organizationId: string;
    }): Promise<Result<SsoDomainSummary[]>>;
    /** Starts the proof of a domain and answers the TXT record to publish. */
    add(input: {
      actor: SsoAppActor;
      organizationId: string;
      domain: string;
    }): Promise<Result<SsoDomainSummary>>;
    /** Asks every resolver of `sso.dns` for the record, and claims the domain when each gives it. */
    verify(input: { actor: SsoAppActor; id: string }): Promise<Result<SsoDomainSummary>>;
    /** Changes the route and the flags of a domain. */
    update(input: {
      actor: SsoAppActor;
      id: string;
      connectionId?: string | null;
      enforce?: boolean;
      includeSubdomains?: boolean;
    }): Promise<Result<SsoDomainSummary>>;
    /** Deletes a domain and its claim. */
    delete(input: { actor: SsoAppActor; id: string }): Promise<Result<{ ok: true }>>;
  };
  /**
   * The OIDC and SAML connections of an organization (plan 12d Task 3). No
   * answer holds the client secret or its sealed value.
   */
  connections: {
    /** The connections of an organization, oldest first. */
    list(input: {
      actor: SsoAppActor;
      organizationId: string;
    }): Promise<Result<SsoConnectionSummary[]>>;
    /** Adds a connection. An OIDC client secret is sealed under the current app secret. */
    create(input: { actor: SsoAppActor } & ConnectionInput): Promise<Result<SsoConnectionSummary>>;
    /** Changes the fields of a connection. `kind` and `organizationId` never change. */
    update(
      input: { actor: SsoAppActor; id: string } & ConnectionFields,
    ): Promise<Result<SsoConnectionSummary>>;
    /** Deletes a connection, and takes the route and `enforce` off its domains. */
    delete(input: { actor: SsoAppActor; id: string }): Promise<Result<{ ok: true }>>;
  };
}

/**
 * The SCIM setup in process (plan 12d Task 9). Present when `scim` is set.
 * Each call takes the app as its actor and writes the audit rows of the
 * routes. An app name outside 1 to 64 characters of `[a-z0-9_.-]` answers
 * `invalid_body`.
 */
export interface ScimApi {
  tokens: {
    /** The newest 100 SCIM tokens of an organization, oldest first. No answer holds a token or its hash. */
    list(input: {
      actor: SsoAppActor;
      organizationId: string;
    }): Promise<Result<ScimTokenSummary[]>>;
    /**
     * A new SCIM token. The answer holds the token, the one time it leaves
     * core. At most two live tokens per organization, else `token_limit`.
     */
    create(input: {
      actor: SsoAppActor;
      organizationId: string;
      name: string;
      scopes?: ScimScope[];
      expiresInDays?: number;
    }): Promise<Result<{ token: string; id: string; hint: string }>>;
    /** Deletes a token. The next SCIM call with it answers 401. */
    revoke(input: { actor: SsoAppActor; id: string }): Promise<Result<{ ok: true }>>;
  };
  /**
   * The SCIM Users of one organization (plan 12d Task 10), with the rules of
   * the routes: the address rule, the version, the deactivate, and the audit
   * rows with the app as the actor. Each call answers the SCIM answer of its
   * route: the status, the body, and the headers. A `url` holds the query of
   * a list or a read, as the route reads it.
   */
  users: {
    create(input: {
      actor: SsoAppActor;
      organizationId: string;
      body: unknown;
    }): Promise<ScimResult>;
    get(input: {
      actor: SsoAppActor;
      organizationId: string;
      id: string;
      url?: URL;
    }): Promise<ScimResult>;
    list(input: { actor: SsoAppActor; organizationId: string; url?: URL }): Promise<ScimResult>;
    replace(input: {
      actor: SsoAppActor;
      organizationId: string;
      id: string;
      body: unknown;
      ifMatch?: string;
    }): Promise<ScimResult>;
    patch(input: {
      actor: SsoAppActor;
      organizationId: string;
      id: string;
      body: unknown;
      ifMatch?: string;
    }): Promise<ScimResult>;
    delete(input: {
      actor: SsoAppActor;
      organizationId: string;
      id: string;
      ifMatch?: string;
    }): Promise<ScimResult>;
  };
  /**
   * The SCIM Groups of one organization (plan 12d Task 11), with the rules
   * of the routes: the member caps, the role map, the teams, the version,
   * and the audit rows with the app as the actor. A `patch` answers 204
   * with no body unless its `url` asks for `attributes`.
   */
  groups: {
    create(input: {
      actor: SsoAppActor;
      organizationId: string;
      body: unknown;
    }): Promise<ScimResult>;
    get(input: {
      actor: SsoAppActor;
      organizationId: string;
      id: string;
      url?: URL;
    }): Promise<ScimResult>;
    list(input: { actor: SsoAppActor; organizationId: string; url?: URL }): Promise<ScimResult>;
    replace(input: {
      actor: SsoAppActor;
      organizationId: string;
      id: string;
      body: unknown;
      ifMatch?: string;
    }): Promise<ScimResult>;
    patch(input: {
      actor: SsoAppActor;
      organizationId: string;
      id: string;
      body: unknown;
      ifMatch?: string;
      url?: URL;
    }): Promise<ScimResult>;
    delete(input: {
      actor: SsoAppActor;
      organizationId: string;
      id: string;
      ifMatch?: string;
    }): Promise<ScimResult>;
  };
  /**
   * Sets the role map of an organization: `{ [group displayName]: role }`
   * (plan 12d Task 11 Behavior 2). It is the `scimRoles` of the enabled
   * connection that the organization created first, with the role rule of
   * a connection update: never `owner`, never the platform role. Null
   * clears it. No role changes at once: each member gets the role of the
   * map at the next change of its groups, or at a rename of a group.
   */
  setRoleMap(input: {
    actor: SsoAppActor;
    organizationId: string;
    map: Record<string, string> | null;
  }): Promise<Result<SsoConnectionSummary>>;
}

export interface OAuthApi {
  grants(input: { userId: string }): Promise<Result<OAuthGrantSummary[]>>;
  revoke(input: { userId: string; clientId: string }): Promise<Result<{ ok: true }>>;
  /** The clients of the provider (plan 12e). In process only: no route answers them. */
  clients: OAuthClientsApi;
}

/**
 * The client API of the provider (plan 12e). Each call answers an OAuth
 * result: `{ ok: false, error, status }` with a code of `OAUTH_ERRORS`. An
 * unknown client id answers `invalid_client`. A secret leaves core once: in
 * the answer of `create` or `rotateSecret`.
 */
export interface OAuthClientsApi {
  create(
    input: ClientInput,
  ): Promise<OAuthResult<{ client: ClientSummary; clientSecret?: string }>>;
  get(input: { clientId: string }): Promise<OAuthResult<ClientSummary>>;
  /** Newest first. `limit` 1 to 100, default 100. Pass `next` as `cursor` for the next page. */
  list(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<OAuthResult<{ clients: ClientSummary[]; next: string | null }>>;
  /** Every field but the id, the method, and the secret. */
  update(
    input: { clientId: string } & Omit<ClientInput, "authMethod">,
  ): Promise<OAuthResult<ClientSummary>>;
  /** Deletes the client and its consents, refresh tokens, device grants, session links, and logouts. */
  delete(input: { clientId: string }): Promise<OAuthResult<{ ok: true }>>;
  /** A new secret. The old one passes for `keepOldHours` more: 0 to 168, default 24. */
  rotateSecret(input: {
    clientId: string;
    keepOldHours?: number;
  }): Promise<OAuthResult<{ client: ClientSummary; clientSecret: string }>>;
}

/** API tokens (plan 8b). Present in every deployment: tokens need no config key. */
export interface TokensApi {
  /** Applies no fresh rule: call `api.session.requireFresh` first (plan 12a). */
  create(input: ApiTokenCreate): Promise<Result<{ token: string; apiToken: ApiTokenSummary }>>;
  list(input: { user: UserRow }): Promise<Result<ApiTokenSummary[]>>;
  revoke(input: { user: UserRow; id: string }): Promise<Result<{ ok: true }>>;
  /**
   * Narrows a token of the user (plan 12k, spec 29 item 11): a smaller set,
   * an earlier expiry, a new name. It also takes the window and the quota,
   * which no route takes. A quota may only go down or lose its refill.
   * Applies no fresh rule: call `api.session.requireFresh` first.
   */
  update(input: ApiTokenUpdate): Promise<Result<ApiTokenSummary>>;
  /**
   * The token's user and summary, or the code of the resolve: `unauthorized`,
   * `rate_limited`, `token_exhausted`, `token_retired`, or `conflict`. A `ts_`
   * token answers `unauthorized`. It spends one call of the quota.
   */
  current(input: { token: string }): Promise<Result<ResolvedApiToken>>;
}

/**
 * Tokens that an organization owns (plan 12k, spec 29 items 14 to 16). Each
 * call answers `not_found` while organizations are off. A token acts for the
 * organization with its own fixed set, and stays when its creator leaves.
 * Only a person manages one: `create` needs `apiToken:create`, `list`
 * `apiToken:read`, `update` `apiToken:update`, and `revoke` `apiToken:revoke`.
 * `create` and `update` apply no fresh rule: call `api.session.requireFresh` first.
 */
export interface OrganizationTokensApi {
  /** The set is required and a subset of the creator's set; `{}` grants nothing. The cap is 50 live tokens. */
  create(
    input: OrganizationTokenCreate,
  ): Promise<Result<{ token: string; apiToken: OrganizationTokenSummary }>>;
  list(input: {
    user: UserRow;
    organizationId: string;
  }): Promise<Result<OrganizationTokenSummary[]>>;
  /** Narrows only, as `tokens.update`: a smaller set, an earlier expiry, a new name, a window, or a lower quota. */
  update(input: OrganizationTokenUpdate): Promise<Result<OrganizationTokenSummary>>;
  revoke(input: {
    user: UserRow;
    organizationId: string;
    id: string;
  }): Promise<Result<{ ok: true }>>;
  /**
   * The organization and the summary of a `to_` token, or the code of the
   * resolve: `unauthorized`, `rate_limited`, `token_exhausted`,
   * `token_retired`, or `conflict`. It spends one call of the quota.
   */
  current(input: { token: string }): Promise<Result<ResolvedOrganizationToken>>;
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
   * before, to go on with the pass. `callBudget`: the storage calls of the
   * call, 50 to 1000, default 50 for D1 Free (ruling 33 of plan 12d). A call
   * that the budget stops answers `more: true` and `next`: call again with
   * it. `invalid_body` for a limit or a budget outside its range, or a
   * cursor that `rewrap` did not answer.
   */
  rewrap(input?: {
    limit?: number;
    after?: string;
    callBudget?: number;
  }): Promise<Result<SecretsRewrap>>;
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

/** Present on `api` while `phone` is on (plan 12i, spec 32 item 5). */
export interface PhoneApi {
  /** A sign-in code by SMS. `{ sent: true }` for a known and an unknown number. */
  request(input: PhoneRequest): Promise<Result<{ sent: true }>>;
  verify(input: PhoneVerify): Promise<Result<PhoneSession | TwoFactorPending>>;
  /** A code to a new phone of the caller. Fresh rule, a proved handle. */
  add(input: PhoneAdd): Promise<Result<{ sent: true }>>;
  /** Sets the phone that `add` sent a code to. Fresh rule. `phone_taken` when another user holds it. */
  verifyAdd(input: PhoneAddVerify): Promise<Result<{ phone: string }>>;
  /** Removes the phone under the last-credential guard. Fresh rule. */
  remove(input: PhoneRemove): Promise<Result<{ ok: true }>>;
}

/**
 * The fresh rule and the session operations of a settings page (plan 12a).
 * Present in every deployment. An app's own sensitive change calls
 * `requireFresh` first (ASVS 5.0.0 7.5.3); so does an app that calls
 * `api.tokens.create`, `api.passkeyRegistrationOptions`,
 * `api.deletePasskey`, `api.totp.disableWithCode`, or
 * `api.totp.regenerateBackupCodesWithCode` in process, because those take a
 * user, not a session. Their routes apply the rule.
 */
export interface SessionApi {
  /** `session_not_fresh` unless a sign-in or a re-authentication is younger than `session.freshMinutes`. */
  requireFresh(resolved: ResolvedSession): Result<true>;
  reauthenticate(input: ReauthInput): Promise<Result<{ freshUntil: Date }>>;
  /** A re-authentication code to the user's address. `not_found` with `emailOtp: false`. */
  requestReauthCode(input: { session: ResolvedSession }): Promise<Result<{ sent: true }>>;
  /** The WebAuthn options of a re-authentication by a passkey. `not_found` without `passkey`. */
  reauthPasskeyOptions(input: {
    session: ResolvedSession;
    ip: string | null;
  }): Promise<Result<PublicKeyCredentialRequestOptionsJSON>>;
  /** The user's live sessions, newest first. No fresh rule: ASVS 7.5.2 lets a person view them. */
  list(input: { session: ResolvedSession }): Promise<Result<SessionSummary[]>>;
  /** Ends one session of the user. Fresh rule. */
  revoke(input: { session: ResolvedSession; id: string }): Promise<Result<{ current: boolean }>>;
  /** Ends every other session and the sessions in waiting. Fresh rule. */
  revokeOthers(input: { session: ResolvedSession }): Promise<Result<{ ended: number }>>;
  /**
   * Resolves `token` in the write mode, as `POST /session/refresh` does: a
   * due sliding refresh moves the expiry (plan 12a). Null for no live session.
   */
  refresh(token: string): Promise<ResolvedSession | null>;
}

/** The user operations of a settings page (plan 12a). Present in every deployment. */
export interface UserApi {
  /** Writes `name` and `image`. Needs a verified email. No fresh rule. */
  update(input: ProfileUpdate): Promise<Result<{ user: PublicUser }>>;
  /** Sends a proof to the new address, or a note when any user holds it. Fresh rule, verified email. */
  changeEmail(input: EmailChangeRequest): Promise<Result<{ sent: true }>>;
  /** The confirm by link. No session: the token is the proof. */
  confirmEmailChange(input: {
    token: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<Result<{ user: PublicUser; next: string }>>;
  /** The confirm by code, with a session of the same user. `not_found` with `emailOtp: false`. */
  verifyEmailChange(input: {
    session: ResolvedSession;
    code: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<Result<{ user: PublicUser }>>;
  /**
   * Deletes the account. Fresh rule; `sole_owner`; `not_found` with
   * `account.delete: false`. With `account.deleteConfirm` on, it mails a
   * link, deletes nothing, and answers `{ sent: true }` (plan 12a Task 20).
   */
  delete(input: AccountDelete): Promise<Result<{ ok: true } | { sent: true }>>;
  /**
   * The confirm of the mailed link, with a session of the user who asked.
   * No fresh rule. `invalid_token` for a spent, expired, unknown, or
   * foreign link; `sole_owner` again.
   */
  confirmDelete(input: AccountDelete & { token: string }): Promise<Result<{ ok: true }>>;
  /**
   * Sets the username (plan 12i). Fresh rule, a proved handle. `not_found`
   * with `username` off; `username_taken` when another user holds it.
   */
  setUsername(input: UsernameSet): Promise<Result<Username>>;
  /** True when no user holds the name. Counts per IP. `not_found` with `username` off. */
  usernameAvailable(input: {
    username: string;
    ip: string | null;
  }): Promise<Result<{ available: boolean }>>;
}

/** The linked identities of a settings page (plan 12a). Present in every deployment. */
export interface IdentitiesApi {
  /** The identities with `canUnlink`, the password flag, and the passkey count. No fresh rule. */
  list(input: { session: ResolvedSession }): Promise<Result<IdentityList>>;
  /** Fresh rule; `last_credential` when the identity is the last way in. */
  unlink(input: IdentityUnlink): Promise<Result<{ ok: true }>>;
}

export interface AuthApi {
  /**
   * Deletes rows that no flow can use any more. Call it from a scheduled
   * handler. `callBudget` is the calls of one sweep, 50 to 1000, default 50
   * (Workers Free); another value throws a RangeError.
   */
  sweepExpired(options?: { callBudget?: number }): Promise<SweepResult>;
  requestMagicLink(input: MagicLinkRequest): Promise<Result<{ sent: true }>>;
  verifyMagicLink(
    input: MagicLinkVerify,
  ): Promise<Result<{ token: string; next: string; user: UserRow } | SignInChallenge>>;
  startSocial(input: SocialStart): Promise<Result<SocialStarted>>;
  /** The start of a link to the session's user (plan 12a). Fresh rule, verified email. */
  startLink(input: SocialLinkStart): Promise<Result<SocialStarted>>;
  /** A link state answers `SocialLinked` and opens no session (plan 12a). */
  completeSocial(
    input: SocialComplete,
  ): Promise<
    Result<{ token: string; next: string; user: UserRow } | SignInChallenge | SocialLinked>
  >;
  /** Applies no fresh rule: call `api.session.requireFresh` first (plan 12a). */
  /** `hints` replaces `passkey.hints.register` for this ceremony (plan 12i). */
  passkeyRegistrationOptions(input: {
    user: UserRow;
    hints?: PasskeyHint[] | undefined;
  }): Promise<Result<PublicKeyCredentialCreationOptionsJSON>>;
  verifyPasskeyRegistration(input: {
    user: UserRow;
    response: unknown;
    name?: string | undefined;
  }): Promise<Result<PasskeySummary>>;
  /**
   * `hints` replaces `passkey.hints.signIn` for this ceremony (plan 12i).
   * `extensions` takes PRF salts (base64url of 32 bytes) and a `largeBlob`
   * read; each needs its `passkey.extensions` key on, else `invalid_body`.
   */
  passkeyAuthenticationOptions(input: {
    ip: string | null;
    hints?: PasskeyHint[] | undefined;
    extensions?: PasskeySignInExtensions | undefined;
  }): Promise<Result<PublicKeyCredentialRequestOptionsJSON>>;
  verifyPasskeyAuthentication(input: {
    response: unknown;
    ip: string | null;
    userAgent: string | null;
  }): Promise<Result<{ token: string; user: UserRow; session: SessionRow }>>;
  listPasskeys(input: { user: UserRow }): Promise<Result<PasskeySummary[]>>;
  /** Applies no fresh rule: call `api.session.requireFresh` first (plan 12a). */
  deletePasskey(input: { user: UserRow; id: string }): Promise<Result<{ ok: true }>>;
  /** The rename of `POST /passkeys/rename`. A name is no way in, so it needs no fresh session (plan 12a). */
  renamePasskey(input: {
    user: UserRow;
    id: string;
    name: string;
  }): Promise<Result<{ passkey: PasskeySummary }>>;
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
  /**
   * The normalized slug and its status: `available`, `taken`, `reserved`, or
   * `invalid` with a null slug (plan 12k). It needs a verified address and
   * spends `slug-check:user:<userId>`. The create and a rename to a new slug
   * spend the same key, 60 per minute for the three. So after 60 checks, a
   * create answers `rate_limited` until the minute ends. `available` is a
   * hint, not a hold.
   */
  checkSlug(input: {
    user: UserRow;
    slug: string;
  }): Promise<Result<{ slug: string | null; status: SlugStatus }>>;
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
  /**
   * With `revokeTokens: true`, the person's organization tokens go too, in the
   * same transaction (plan 12k). That needs `apiToken:revoke` as well. It applies
   * no fresh rule: call `api.session.requireFresh` first.
   */
  removeMember(input: {
    user: UserRow;
    organizationId: string;
    userId: string;
    revokeTokens?: boolean;
  }): Promise<Result<{ ok: true }>>;
  /** `teamIds` (plan 12k): the teams that the accept adds the person to, at most 20, each a team of the organization. */
  inviteMember(input: {
    user: UserRow;
    organizationId: string;
    email: string;
    role: string;
    teamIds?: string[];
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
  /**
   * The stored roles of an organization (plan 12k, spec 29 item 6). Each of
   * the five answers `not_found` while `organizations.dynamicRoles` is off.
   * The list and the get need `ac:read`; the writes need `ac:create`,
   * `ac:update`, and `ac:delete`. The fresh rule is the route's.
   */
  listRoles(input: { user: UserRow; organizationId: string }): Promise<Result<RoleSummary[]>>;
  getRole(input: {
    user: UserRow;
    organizationId: string;
    name: string;
  }): Promise<Result<RoleSummary>>;
  createRole(input: {
    user: UserRow;
    organizationId: string;
    name: string;
    rank?: number;
    permissions: Statements;
  }): Promise<Result<RoleSummary>>;
  updateRole(input: {
    user: UserRow;
    organizationId: string;
    name: string;
    rank?: number;
    permissions?: Statements;
  }): Promise<Result<RoleSummary>>;
  deleteRole(input: {
    user: UserRow;
    organizationId: string;
    name: string;
  }): Promise<Result<{ ok: true }>>;
  /**
   * Teams (plan 12k, spec 29 item 7). Each of the nine answers `not_found`
   * while `organizations.teams` is off. The create, the update, and the
   * delete need `team:create`, `team:update`, and `team:delete`. The add of a
   * team member needs `member:update`, the removal of another person
   * `member:delete`, and the members list `member:read`. A member leaves a
   * team, and reads the list of teams, with membership only.
   */
  createTeam(input: {
    user: UserRow;
    organizationId: string;
    name: string;
  }): Promise<Result<TeamSummary>>;
  updateTeam(input: { user: UserRow; teamId: string; name: string }): Promise<Result<TeamSummary>>;
  deleteTeam(input: { user: UserRow; teamId: string }): Promise<Result<{ ok: true }>>;
  listTeams(input: { user: UserRow; organizationId: string }): Promise<Result<TeamSummary[]>>;
  listTeamMembers(input: { user: UserRow; teamId: string }): Promise<Result<TeamMemberSummary[]>>;
  addTeamMember(input: {
    user: UserRow;
    teamId: string;
    userId: string;
  }): Promise<Result<TeamMemberSummary>>;
  removeTeamMember(input: {
    user: UserRow;
    teamId: string;
    userId: string;
  }): Promise<Result<{ ok: true }>>;
  /** A team of the session's active organization of which the user is a member, else `forbidden_rank`. `null` clears it. */
  setActiveTeam(input: {
    session: ResolvedSession;
    teamId: string | null;
  }): Promise<Result<PublicSession>>;
  /** The teams of the user in every organization. */
  listUserTeams(input: { user: UserRow }): Promise<Result<TeamSummary[]>>;
  getSession(token: string): Promise<ResolvedSession | null>;
  signOut(token: string): Promise<void>;
  tokens: TokensApi;
  organizationTokens: OrganizationTokensApi;
  session: SessionApi;
  user: UserApi;
  identities: IdentitiesApi;
  secrets: SecretsApi;
  /** The operator tools (plan 12f). Present in every deployment; a call answers `not_found` while its tool is off. */
  operator: OperatorApi;
  password?: PasswordApi;
  emailOtp?: EmailOtpApi;
  phone?: PhoneApi;
  totp?: TotpApi;
  jwt?: JwtApi;
  oauth?: OAuthApi;
  sso?: SsoApi;
  scim?: ScimApi;
}

export interface Auth {
  /**
   * The resolved `basePath` of the config (default "/auth"). The gate of the
   * framework bindings reads it, so an app names its base path once (plan 11d2).
   */
  readonly basePath: string;
  /**
   * The resolved `baseURL` of the config: an origin with no path. A binding
   * that builds the request URL from the Host header uses
   * `new URL(auth.baseURL).origin` when that header does not parse, so a bad
   * Host answers no 500 of the binding's own (plan 11d2).
   */
  readonly baseURL: string;
  /**
   * Serves the auth routes under `basePath`. Mount it for any request whose
   * path starts with `basePath`. With `observe`, pass `{ waitUntil }`: the
   * flush of the events then runs after the answer (plan 12h).
   */
  handle(request: Request, options?: HandleOptions): Promise<Response>;
  /**
   * The events of `observe` (plan 12h). `flush()` sends the buffer to the
   * sink; call it when the host has no `waitUntil`. `stats()` answers the
   * buffered count and the drop counts in process. No route answers them.
   */
  observe: { flush(): Promise<void>; stats(): ObserveStats };
  /**
   * The caller's session from the cookie or the bearer header, or null.
   * With `{ refresh: false }` it is a read with no write: no sliding refresh
   * and no delete of an ended row. A server render that cannot set a cookie
   * reads this way, so the browser's `GET /session` still gets the renewed cookie.
   * With `session.deferRefresh` on, a GET request reads this way too (plan 12a).
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
   * A token caller spends one call of its quota, in every read mode (plan 12k).
   * A `to_` bearer answers `kind: "organizationToken"` with `organization` and
   * no `user` (plan 12k): narrow the kind before you read `caller.user`.
   */
  caller(request: Request): Promise<Caller | null>;
  /**
   * The caller of `caller(request)`, or the code of the failure (plan 12k,
   * spec 29 item 16). A token answers `rate_limited` over its window, and
   * `token_exhausted` at a quota of zero. It answers `token_retired` for a
   * retired key, or for a moved key with no row. It answers `conflict` when a
   * lost spend sees no other spend, or after 20 lost spends. Every other
   * failure is `unauthorized`. `caller` answers null for each code. A
   * token spends one call of its quota per request, in every read mode, so
   * `caller` and `authenticate` on one request spend once.
   */
  authenticate(request: Request): Promise<Result<Caller>>;
  /**
   * True when the caller holds every permission in the organization (plan
   * 12k, spec 29 item 9). A session reads its member role now. A user token
   * reads its user's role, narrowed by the token's set. It grants nothing
   * outside its bound organization. An OAuth caller grants nothing. False,
   * never a throw, on any failure.
   */
  hasPermission(caller: Caller, input: PermissionInput): Promise<boolean>;
  /**
   * The caller's role string and effective set in one organization, so a page
   * can hide what the person cannot do. A non-member gets `role: null` and `{}`.
   */
  permissionsOf(
    caller: Caller,
    organizationId: string,
  ): Promise<Result<{ role: string | null; permissions: Statements }>>;
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
   * With `passkey.relatedOrigins` on, it also answers the related origins
   * document of WebAuthn Level 3 at `/.well-known/webauthn` on the `rpID`
   * host (plan 12i).
   */
  wellKnown(request: Request): Promise<Response>;
  /** The same operations, in-process. */
  api: AuthApi;
  errors: typeof ERRORS;
}

/**
 * The in-process door of an act that the router refuses to an impersonation
 * session (plan 12f, spec 26 item 9). An input whose session has `actorId`
 * gets `impersonation_session`, as the route answers. A call that takes a
 * user, not a session, cannot tell; its route refuses.
 */
function refusesImpersonation<I extends { session: Pick<ResolvedSession, "session"> }, R>(
  run: (input: I) => Promise<Result<R>>,
): (input: I) => Promise<Result<R>> {
  return async (input) => {
    const refused = refuseImpersonation(input.session);
    return refused.ok ? run(input) : fail(refused.code);
  };
}

/** The gate of each Auth, for `crossSiteRefusal`. A WeakMap keeps it off the Auth type. */
const gates = new WeakMap<Auth, (request: Request) => Response | null>();

/**
 * The 403 `origin_not_trusted` that `auth.handle` answers a `POST`, `PUT`,
 * `PATCH`, or `DELETE` before any handler, or null when the request passes.
 * The gate applies the Origin rule and the Fetch Metadata rule, with the
 * route exceptions of core (plan 12d). `GET`, `HEAD`, and `OPTIONS` always
 * pass. A path that core does not serve gets both rules. A package that
 * answers its own paths beside `auth.handle` calls it first. Then a
 * cross-site request reaches none of those paths (plan 12a fix wave, final
 * review F1; the Better Auth shim). Throws a TypeError for an object that
 * `createAuth` did not make.
 */
export function crossSiteRefusal(auth: Auth, request: Request): Response | null {
  const gate = gates.get(auth);
  if (!gate) throw new TypeError("crossSiteRefusal takes an Auth from createAuth");
  return gate(request);
}

/** The resolved config of each Auth, for the compat seams. A WeakMap keeps it off the Auth type. */
const configs = new WeakMap<Auth, ResolvedConfig>();

/**
 * Gives `config` the record of a domain proof of a compat package (plan 12d
 * Task 14, ruling 61 F4). Call it before `createAuth(config)`. The verify of
 * `verifyDomainByRecord` asks for this record, and the 30-day recheck asks
 * for it when the row's own record fails. So a domain that the compat
 * package proved keeps its claim. Answers `config`.
 */
export function withDomainRecord<C extends AuthConfig>(config: C, record: DomainRecordOf): C {
  setConfigDomainRecord(config, record);
  return config;
}

/**
 * Runs `POST <basePath>/sso/domains/verify` with the record of
 * `withDomainRecord` in place of core's own record (plan 12d Task 14). Every
 * other step is the route's: the session, the limiter, the manager guard,
 * the claim, and the audit row. Throws a TypeError for another path, an
 * Auth that `createAuth` did not make, or a config with no such record.
 */
export function verifyDomainByRecord(auth: Auth, request: Request): Promise<Response> {
  const config = configs.get(auth);
  if (!config) throw new TypeError("verifyDomainByRecord takes an Auth from createAuth");
  if (domainRecordFor(config) === null)
    throw new TypeError("verifyDomainByRecord takes an Auth whose config has withDomainRecord");
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== `${auth.basePath}/sso/domains/verify`
  )
    throw new TypeError("verifyDomainByRecord takes a POST to <basePath>/sso/domains/verify");
  markRecordVerify(request);
  return auth.handle(request);
}

/** A SCIM caller that a compat package checked itself: one credential of one organization. */
export interface CheckedScimCaller {
  /** The key of the credential's limit and the actor name of its audit rows: 1 to 128 characters. */
  id: string;
  organizationId: string;
  scopes: readonly ScimScope[];
}

/**
 * Runs a `<basePath>/scim/v2` route with `caller` in place of the check of
 * a SCIM token (plan 12d Task 14). The compat package of Better Auth checks
 * the SHA-256 of a credential of its config, then calls this. The scope of
 * the route, the limit of the credential (`scim:token:<id>`), the body, and
 * the audit rows stay core's. Throws a TypeError for another path, a bad
 * caller, or an Auth that `createAuth` did not make.
 */
export function scimRequestAs(
  auth: Auth,
  request: Request,
  caller: CheckedScimCaller,
): Promise<Response> {
  if (!configs.has(auth)) throw new TypeError("scimRequestAs takes an Auth from createAuth");
  if (!new URL(request.url).pathname.startsWith(`${auth.basePath}/scim/v2/`))
    throw new TypeError("scimRequestAs takes a request under <basePath>/scim/v2/");
  if (
    typeof caller.id !== "string" ||
    caller.id.length < 1 ||
    caller.id.length > 128 ||
    typeof caller.organizationId !== "string" ||
    caller.organizationId.length < 1 ||
    !caller.scopes.every((s) => SCIM_SCOPES.includes(s))
  )
    throw new TypeError("scimRequestAs takes an id of 1 to 128 characters and SCIM scopes");
  setScimCaller(request, {
    tokenId: caller.id,
    tokenName: caller.id,
    organizationId: caller.organizationId,
    scopes: new Set(caller.scopes),
  });
  return auth.handle(request);
}

/** One SSO call of the app: the name rule of the app actor first, as each operator entry checks it. */
function appCall<I extends { actor: SsoAppActor }, R>(
  run: (input: I) => Promise<Result<R>>,
): (input: I) => Promise<Result<R>> {
  return async (input) => {
    const named = checkActor(input.actor);
    if (!named.ok) return named;
    return run(input);
  };
}

/**
 * The app as the caller of `api.scim.users`: the organization of the call
 * in place of the token's. A write checks the name rule of the app actor
 * when it writes its audit row.
 */
function scimApp(input: { actor: SsoAppActor; organizationId: string }) {
  return { organizationId: input.organizationId, actor: input.actor };
}

/** The URL of a call of `api.scim.users` with no query. */
const SCIM_NO_QUERY = new URL("https://scim.invalid/");

export function createAuth(input: AuthConfig): Auth {
  const config = resolveConfig(input);
  // The record of a compat package (withDomainRecord) reaches the routes and the sweep.
  carryDomainRecord(input, config);
  // The route modules get a config whose observer marks each event unscoped.
  // A handler emits through ctx.config, the scope of its request (plan 12h).
  const routes = coreRoutes({ ...config, observe: unscopedOf(config.observe) });
  const gate = createPostGate(config, routes);
  const route = createRouter(config, routes, gate);
  const auth: Auth = {
    basePath: config.basePath,
    baseURL: config.baseURL,
    // handle starts the flush after the answer is built and never awaits it
    // (owner decision 4 of 2026-10-14). The flush swaps the buffer and yields
    // once. The keys, the hashes, and the sink run after that yield. On
    // Workers pass `(p) => ctx.waitUntil(p)`: an unbound `ctx.waitUntil` throws.
    // A hook that throws never loses the answer: the route already ran.
    // The flush starts only after waitUntil takes the promise. A hook that
    // throws starts no flush, so no batch floats with no hook. The batch stays
    // in the buffer for the next flush (fix wave of plan 12h, Low 4).
    async handle(request, options) {
      const res = await route(request);
      if (options?.waitUntil) {
        let start = () => {};
        const started = new Promise<void>((resolve) => {
          start = resolve;
        });
        try {
          options.waitUntil(started.then(() => config.observe.flush()));
          start();
        } catch (e) {
          config.observe.emit({ name: "observe.wait_until_threw", errorName: e });
        }
      }
      return res;
    },
    observe: { flush: () => config.observe.flush(), stats: () => config.observe.stats() },
    session: (request, options) => sessionFromRequest(config, request, options),
    caller: (request) => callerFromRequest(config, request),
    authenticate: (request) => authenticateRequest(config, request),
    hasPermission: (caller, input) => hasPermission(config, caller, input),
    permissionsOf: (caller, organizationId) => permissionsOf(config, caller, organizationId),
    sessionCookie: (request, resolved) => renewedSessionCookie(config, request, resolved),
    wellKnown: createWellKnownHandler(config),
    api: {
      // A scheduled handler has no answer to wait for, so the sweep flushes its events itself.
      async sweepExpired(options) {
        const result = await sweepExpired(config, options);
        await config.observe.flush();
        return result;
      },
      requestMagicLink: (i) => requestMagicLink(config, i),
      verifyMagicLink: (i) => verifyMagicLink(config, i),
      startSocial: (i) => startSocial(config, i),
      startLink: refusesImpersonation((i) => startLink(config, i)),
      completeSocial: (i) => completeSocial(config, i),
      passkeyRegistrationOptions: (i) => passkeyRegistrationOptions(config, i),
      verifyPasskeyRegistration: (i) => verifyPasskeyRegistration(config, i),
      passkeyAuthenticationOptions: (i) => passkeyAuthenticationOptions(config, i),
      verifyPasskeyAuthentication: (i) => verifyPasskeyAuthentication(config, i),
      listPasskeys: (i) => listPasskeys(config, i),
      deletePasskey: (i) => deletePasskey(config, i),
      renamePasskey: (i) => renamePasskey(config, i),
      startHandoff: (i) => startHandoff(config, i),
      continueHandoff: (i) => continueHandoff(config, i),
      redeemHandoff: (i) => redeemHandoff(config, i),
      createOrganization: (i) => createOrganization(config, i),
      listOrganizations: (i) => listOrganizations(config, i),
      checkSlug: (i) => checkSlug(config, i),
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
      listRoles: (i) => listRoles(config, i),
      getRole: (i) => getRole(config, i),
      createRole: (i) => createRole(config, i),
      updateRole: (i) => updateRole(config, i),
      deleteRole: (i) => deleteRole(config, i),
      createTeam: (i) => createTeam(config, i),
      updateTeam: (i) => updateTeam(config, i),
      deleteTeam: (i) => deleteTeam(config, i),
      listTeams: (i) => listTeams(config, i),
      listTeamMembers: (i) => listTeamMembers(config, i),
      addTeamMember: (i) => addTeamMember(config, i),
      removeTeamMember: (i) => removeTeamMember(config, i),
      setActiveTeam: (i) => setActiveTeam(config, i),
      listUserTeams: (i) => listUserTeams(config, i),
      getSession: (token) => resolveSession(config, token),
      async signOut(token) {
        const ended = await destroySession(config, token);
        if (ended) await deliverLogouts(config, ended.userId);
      },
      tokens: {
        create: (i) => createApiToken(config, i),
        list: (i) => listApiTokens(config, i),
        revoke: (i) => revokeApiToken(config, i),
        update: (i) => updateApiToken(config, i),
        current: (i) => currentApiToken(config, i),
      },
      organizationTokens: {
        create: (i) => createOrganizationToken(config, i),
        list: (i) => listOrganizationTokens(config, i),
        update: (i) => updateOrganizationToken(config, i),
        revoke: (i) => revokeOrganizationToken(config, i),
        current: (i) => currentOrganizationToken(config, i),
      },
      session: {
        requireFresh: (resolved) => requireFresh(config, resolved.session),
        reauthenticate: refusesImpersonation((i) => reauthenticate(config, i)),
        requestReauthCode: refusesImpersonation((i) => requestReauthCode(config, i)),
        reauthPasskeyOptions: refusesImpersonation((i) => reauthPasskeyOptions(config, i)),
        list: (i) => listSessions(config, i),
        revoke: (i) => revokeSession(config, i),
        revokeOthers: (i) => revokeOtherSessions(config, i),
        refresh: (token) => resolveSession(config, token, "write"),
      },
      user: {
        update: (i) => updateProfile(config, i),
        changeEmail: refusesImpersonation((i) => requestEmailChange(config, i)),
        confirmEmailChange: (i) => confirmEmailChange(config, i),
        verifyEmailChange: refusesImpersonation((i) => verifyEmailChange(config, i)),
        delete: refusesImpersonation((i) => startAccountDelete(config, i)),
        confirmDelete: refusesImpersonation((i) => confirmAccountDelete(config, i)),
        setUsername: refusesImpersonation((i) => setUsername(config, i)),
        usernameAvailable: (i) => usernameAvailable(config, i),
      },
      identities: {
        list: (i) => listIdentities(config, i),
        unlink: refusesImpersonation((i) => unlinkIdentity(config, i)),
      },
      secrets: {
        status: () => secretsStatus(config),
        rewrap: (i) => rewrapSecrets(config, i),
      },
      operator: operatorApi(config),
      ...(config.password
        ? {
            password: {
              signUp: (i) => passwordSignUp(config, i),
              signIn: (i) => passwordSignIn(config, i),
              verifyEmail: (i) => verifyPasswordEmail(config, i),
              resendVerification: (i) => resendPasswordVerification(config, i),
              requestReset: (i) => requestPasswordReset(config, i),
              reset: (i) => resetPassword(config, i),
              change: refusesImpersonation((i) => changePassword(config, i)),
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
      ...(config.phone
        ? {
            phone: {
              request: (i) => requestPhone(config, i),
              verify: (i) => verifyPhone(config, i),
              add: refusesImpersonation((i) => addPhone(config, i)),
              verifyAdd: refusesImpersonation((i) => verifyAddPhone(config, i)),
              remove: refusesImpersonation((i) => removePhone(config, i)),
            },
          }
        : {}),
      ...(config.totp
        ? {
            totp: {
              setup: (i) => setupTotp(config, i),
              enable: refusesImpersonation((i) => enableTotp(config, i)),
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
      ...(config.sso
        ? {
            sso: {
              domains: {
                list: appCall(({ actor, ...i }) => listDomains(config, actor, i)),
                add: appCall(({ actor, ...i }) => addDomain(config, actor, i)),
                verify: appCall(({ actor, ...i }) => verifyDomain(config, actor, i)),
                update: appCall(({ actor, ...i }) => updateDomain(config, actor, i)),
                delete: appCall(({ actor, ...i }) => deleteDomain(config, actor, i)),
              },
              connections: {
                list: appCall(({ actor, ...i }) => listConnections(config, actor, i)),
                create: appCall(({ actor, ...i }) => createConnection(config, actor, i)),
                update: appCall(({ actor, ...i }) => updateConnection(config, actor, i)),
                delete: appCall(({ actor, ...i }) => deleteConnection(config, actor, i)),
              },
            } satisfies SsoApi,
          }
        : {}),
      ...(config.scim
        ? {
            scim: {
              tokens: {
                list: appCall(({ actor, ...i }) => listScimTokens(config, actor, i)),
                create: appCall(({ actor, ...i }) => createScimToken(config, actor, i)),
                revoke: appCall(({ actor, ...i }) => revokeScimToken(config, actor, i)),
              },
              users: {
                create: (i) => scimCreateUser(config, scimApp(i), i.body),
                get: (i) => scimGetUser(config, scimApp(i), i.id, i.url ?? SCIM_NO_QUERY),
                list: (i) => scimListUsers(config, scimApp(i), i.url ?? SCIM_NO_QUERY),
                replace: (i) =>
                  scimReplaceUser(config, scimApp(i), i.id, i.body, i.ifMatch ?? null),
                patch: (i) => scimPatchUser(config, scimApp(i), i.id, i.body, i.ifMatch ?? null),
                delete: (i) => scimDeleteUser(config, scimApp(i), i.id, i.ifMatch ?? null),
              },
              groups: {
                create: (i) => scimCreateGroup(config, scimApp(i), i.body),
                get: (i) => scimGetGroup(config, scimApp(i), i.id, i.url ?? SCIM_NO_QUERY),
                list: (i) => scimListGroups(config, scimApp(i), i.url ?? SCIM_NO_QUERY),
                replace: (i) =>
                  scimReplaceGroup(config, scimApp(i), i.id, i.body, i.ifMatch ?? null),
                patch: (i) =>
                  scimPatchGroup(
                    config,
                    scimApp(i),
                    i.id,
                    i.body,
                    i.ifMatch ?? null,
                    i.url ?? SCIM_NO_QUERY,
                  ),
                delete: (i) => scimDeleteGroup(config, scimApp(i), i.id, i.ifMatch ?? null),
              },
              setRoleMap: appCall(({ actor, ...i }) => setRoleMap(config, actor, i)),
            } satisfies ScimApi,
          }
        : {}),
      ...(config.oauth
        ? {
            oauth: {
              grants: (i) => listGrants(config, i),
              revoke: (i) => revokeGrant(config, i),
              clients: {
                create: (i) => createClient(config, i),
                get: (i) => getClient(config, i),
                list: (i) => listClients(config, i),
                update: (i) => updateClient(config, i),
                delete: (i) => deleteClient(config, i),
                rotateSecret: (i) => rotateClientSecret(config, i),
              },
            } satisfies OAuthApi,
          }
        : {}),
    },
    errors: ERRORS,
  };
  gates.set(auth, gate);
  configs.set(auth, config);
  return auth;
}
