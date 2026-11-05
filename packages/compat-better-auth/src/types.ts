import type { BrowserWebAuthn } from "@authtempo/client";
import type {
  Auth,
  DnsTxtPort,
  HandleOptions,
  LimiterPort,
  PasswordHashSeam,
  StorageAdapter,
} from "@authtempo/core";
import type { ExpoCryptoLike, ExpoWebBrowserLike } from "@authtempo/handoff/expo";
import type { AccessControl, Role } from "./access.js";

// Shapes copied from Better Auth 1.7.2 (@better-auth/core src/db/schema/*.ts and
// better-auth dist/client/react/index.d.mts), read on 2026-10-10. Only the fields
// that authtempo can fill are here. The converters in src/server/shapes.ts and
// src/client/create-auth-client.ts build object literals under these types, so a
// field added here and not filled there fails the compile (Review Focus 4).

/**
 * The user fields of Better Auth 1.7.2's sign-in plugins (final fix wave of
 * plan 12i, C M1). Each schema marks them returned (anonymous/schema.mjs:2,
 * username/schema.mjs:9, phone-number/schema.mjs:8 and :13, read
 * 2026-10-25). A field is there only when its plugin is on.
 */
export interface PluginUserFields {
  /** The anonymous plugin: true for an anonymous user. */
  isAnonymous?: boolean;
  /** The username plugin: the stored name, or null. */
  username?: string | null;
  /** The username plugin: the name in the case that the person typed, or null. */
  displayUsername?: string | null;
  /**
   * The phone-number plugin: the proved number, or null. Core reads a
   * number of a Better Auth row only with `phoneNumberVerified` true, so an
   * unproved number reads as null.
   */
  phoneNumber?: string | null;
  /** The phone-number plugin: true when `phoneNumber` holds a number. */
  phoneNumberVerified?: boolean;
}

/** Better Auth's user as the server answers it. `name` is "" when core holds no name. */
export interface User extends PluginUserFields {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Better Auth 1.7.7's user with the admin plugin's fields
 * (dist/plugins/admin/schema.mjs, read 2026-10-21), as the admin paths
 * answer it (plan 12f). `role` is the platform role or `user`. The ban
 * fields hold a ban that holds now, else `false` and null.
 */
export interface AdminUser extends User {
  role: string;
  banned: boolean;
  banReason: string | null;
  banExpires: Date | null;
  /** With the twoFactor plugin only: true while the user's second factor is on (ruling 60 L2). */
  twoFactorEnabled?: boolean;
}

export interface Session {
  id: string;
  /** The caller's own session token, read from the request. The `session.token` column holds its SHA-256 hex. */
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  activeOrganizationId: string | null;
  /** Better Auth's teams option (plan 12k ruling 41): the active team, or null. */
  activeTeamId: string | null;
}

/** Better Auth's session with the admin plugin (plan 12f): the operator of an impersonation session, else null. */
export interface AdminSession extends Session {
  impersonatedBy: string | null;
}

/**
 * Better Auth 1.7.2's account row, as the shim answers it (plan 12a;
 * better-auth dist/api/routes/account.mjs:21 to :75, read 2026-10-17). `id` is
 * core's identity id, or the password row id for `credential`. The shim keeps
 * no `issuer` in its answer.
 */
export interface Account {
  id: string;
  providerId: string;
  accountId: string;
  userId: string;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Better Auth's API key, as @better-auth/api-key 1.7.5 answers it
 * (dist/types-y22rgFHR.d.mts `ApiKey`, read 2026-10-21), from core's token
 * (plan 12k Task 12). `start` holds core's hint, and `prefix` is null:
 * core keeps no prefix per key. `enabled` is always true, because core has
 * no disabled token. `requestCount` is 0: core's limiter holds the window.
 */
export interface ApiKey {
  id: string;
  configId: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  /** The user id, or the organization id of an organization key. */
  referenceId: string;
  /** Milliseconds, as in Better Auth. */
  refillInterval: number | null;
  refillAmount: number | null;
  lastRefillAt: Date | null;
  enabled: boolean;
  rateLimitEnabled: boolean;
  /** Milliseconds, as in Better Auth. */
  rateLimitTimeWindow: number | null;
  rateLimitMax: number | null;
  requestCount: number;
  remaining: number | null;
  lastRequest: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown> | null;
  permissions: Record<string, string[]> | null;
}

/** What an account hook of the shim gets. Core's identity hook carries no row id (plan 12a). */
export interface AccountHookFields {
  providerId: string;
  accountId: string;
  userId: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  /** Always null: core has no logo field, and `organization.create` refuses a logo. */
  logo: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface Member {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
  user: { id: string; email: string; name: string };
}

export interface Invitation {
  /**
   * In the mail callback (`sendInvitationEmail`'s `data.invitation.id`) this
   * is the invitation token, not the row id. In the server's
   * `api.createInvitation` and `api.cancelInvitation` it is the row id
   * (see the README, "Plugins").
   */
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "rejected" | "canceled";
  inviterId: string;
  expiresAt: Date;
  createdAt: Date;
}

/** Better Auth 1.7.2's team, as its routes answer it: no `memberCount` (plan 12k Task 11). */
export interface Team {
  id: string;
  name: string;
  organizationId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Better Auth 1.7.2's team member, as its routes answer it: no `membershipKey` (plan 12k Task 11). */
export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  createdAt: Date;
}

/** What `drizzleAdapter` and `betterAuthSchemaStorage` answer. `betterAuth` refuses any other `database`. */
export interface CompatDatabase {
  readonly kind: "authtempo-compat-database";
  readonly dialect: "postgres" | "d1" | "sqlite";
  readonly storage: StorageAdapter;
  /** The owned limiter on the same database, in `ta_limit`. */
  readonly limiter: LimiterPort;
  /** Set by `drizzleAdapter` for a database it refuses. `betterAuth` lists these with its own refusals. */
  readonly refusals?: readonly string[];
}

export interface EmailCallbackData {
  user: User;
  url: string;
  token: string;
}

export type SendEmail = (data: EmailCallbackData, request?: Request) => Promise<void> | void;

export interface InvitationEmailData {
  /** The invitation token. The app builds its accept link from it, and `acceptInvitation({ invitationId })` sends it back. */
  id: string;
  role: string;
  email: string;
  organization: Organization;
  inviter: { user: User };
  invitation: Invitation;
}

export const COMPAT_PLUGIN = "authtempo-compat-plugin";

/** A Better Auth hook may answer a value or a promise. */
type HookResult<T> = T | Promise<T>;

/** A before hook's answer: nothing, or Better Auth's `{ data }`. A hook with no return statement returns void. */
// biome-ignore lint/suspicious/noConfusingVoidType: with undefined, a hook with no return statement does not type-check.
type BeforeHookAnswer = void | { data: object };

/**
 * `organization({ organizationHooks })` (plan 9d): Better Auth 1.7.2's names
 * and argument shapes (dist/plugins/organization/types.d.mts:296-690, read
 * 2026-10-13), with the fields authtempo fills. A before hook may return
 * `{ data }` only with the values it was given: a core hook cannot change a
 * row. `beforeCancelInvitation` and `beforeRejectInvitation` are not here,
 * so a literal that names one fails the compile; the start check refuses
 * them by name. The ten team hooks map since plan 12k Task 11.
 */
export interface OrganizationHookOptions {
  beforeCreateOrganization?: (data: {
    organization: {
      id: string;
      name: string;
      slug: string;
      logo: null;
      metadata: Record<string, unknown> | null;
    };
    user: User;
  }) => HookResult<BeforeHookAnswer>;
  afterCreateOrganization?: (data: {
    organization: Organization;
    member: Member;
    user: User;
  }) => HookResult<void>;
  beforeUpdateOrganization?: (data: {
    organization: { name?: string; slug?: string; metadata?: Record<string, unknown> | null };
    user: User;
    member: Member;
  }) => HookResult<BeforeHookAnswer>;
  afterUpdateOrganization?: (data: {
    organization: Organization;
    user: User;
    member: Member;
  }) => HookResult<void>;
  beforeDeleteOrganization?: (data: { organization: Organization; user: User }) => HookResult<void>;
  afterDeleteOrganization?: (data: { organization: Organization; user: User }) => HookResult<void>;
  beforeAddMember?: (data: {
    member: { userId: string; organizationId: string; role: string };
    user: User;
    organization: Organization;
  }) => HookResult<BeforeHookAnswer>;
  afterAddMember?: (data: {
    member: Member;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  beforeRemoveMember?: (data: {
    member: Member;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  afterRemoveMember?: (data: {
    member: Member;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  beforeUpdateMemberRole?: (data: {
    member: Member;
    newRole: string;
    user: User;
    organization: Organization;
  }) => HookResult<BeforeHookAnswer>;
  afterUpdateMemberRole?: (data: {
    member: Member;
    previousRole: string;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  beforeCreateInvitation?: (data: {
    invitation: { email: string; role: string; organizationId: string; inviterId: string };
    inviter: User;
    organization: Organization;
  }) => HookResult<BeforeHookAnswer>;
  afterCreateInvitation?: (data: {
    invitation: Invitation;
    inviter: User;
    organization: Organization;
  }) => HookResult<void>;
  beforeAcceptInvitation?: (data: {
    invitation: Invitation;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  afterAcceptInvitation?: (data: {
    invitation: Invitation;
    member: Member;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  /** `user` is null when the decline request carried no session: core's decline needs the token only. */
  afterRejectInvitation?: (data: {
    invitation: Invitation;
    user: User | null;
    organization: Organization;
  }) => HookResult<void>;
  afterCancelInvitation?: (data: {
    invitation: Invitation;
    cancelledBy: User;
    organization: Organization;
  }) => HookResult<void>;
  // The ten team hooks (plan 12k Task 11). In the team hooks, `user` is the
  // caller. In the member hooks, `user` is the person who joins or leaves, as
  // in Better Auth 1.7.2 (routes/crud-team.mjs, read 2026-10-21).
  beforeCreateTeam?: (data: {
    team: { name: string; organizationId: string };
    user: User;
    organization: Organization;
  }) => HookResult<BeforeHookAnswer>;
  afterCreateTeam?: (data: {
    team: Team;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  beforeUpdateTeam?: (data: {
    team: Team;
    updates: { name: string };
    user: User;
    organization: Organization;
  }) => HookResult<BeforeHookAnswer>;
  afterUpdateTeam?: (data: {
    team: Team;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  beforeDeleteTeam?: (data: {
    team: Team;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  afterDeleteTeam?: (data: {
    team: Team;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  beforeAddTeamMember?: (data: {
    teamMember: { teamId: string; userId: string };
    team: Team;
    user: User;
    organization: Organization;
  }) => HookResult<BeforeHookAnswer>;
  afterAddTeamMember?: (data: {
    teamMember: TeamMember;
    team: Team;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  beforeRemoveTeamMember?: (data: {
    teamMember: TeamMember;
    team: Team;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
  afterRemoveTeamMember?: (data: {
    teamMember: TeamMember;
    team: Team;
    user: User;
    organization: Organization;
  }) => HookResult<void>;
}

/** The session fields core fills before the write, in Better Auth's names (plan 9d). */
export interface SessionDraftFields {
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  activeOrganizationId: null;
}

export interface OrganizationOptions {
  allowUserToCreateOrganization?: boolean | ((user: User) => boolean | Promise<boolean>);
  organizationLimit?: number | ((user: User) => boolean | Promise<boolean>);
  membershipLimit?: number;
  invitationLimit?: number;
  creatorRole?: string;
  invitationExpiresIn?: number;
  requireEmailVerificationOnInvitation?: boolean;
  cancelPendingInvitationsOnReInvite?: boolean;
  sendInvitationEmail?: (data: InvitationEmailData, request?: Request) => Promise<void> | void;
  organizationHooks?: OrganizationHookOptions;
  /** `createAccessControl` of `./plugins/access` (plan 12k): its own resources become core's statements. */
  ac?: AccessControl;
  /** The roles of `ac.newRole`. `authtempo.roleRanks` ranks each one. */
  roles?: Record<string, Role>;
  /** Core's dynamic roles. A function of `maximumRolesPerOrganization` is refused, as for the other limits. */
  dynamicAccessControl?: { enabled?: boolean; maximumRolesPerOrganization?: number };
  /**
   * Core's teams (plan 12k Task 11). Better Auth's defaults hold: a default
   * team at each create, and no delete of the last team. A function of a
   * limit and `defaultTeam.customCreateDefaultTeam` are refused.
   */
  teams?: {
    enabled: boolean;
    defaultTeam?: { enabled: boolean };
    maximumTeams?: number;
    maximumMembersPerTeam?: number;
    allowRemovingAllTeams?: boolean;
  };
}

export interface PasskeyOptions {
  rpID?: string;
  rpName?: string;
  origin?: string | string[] | null;
  /**
   * `@better-auth/passkey` 1.7.2's sign-up keys (deviation 6 of plan 12i).
   * Only `requireSession: true` maps: core makes every user, so app code
   * that finds or makes the user is refused. Core's `passkey.signUp` (plan
   * 12i Task 8) is the sign-up by passkey; the shim does not map it.
   */
  registration?: {
    requireSession?: boolean;
    resolveUser?: unknown;
    afterVerification?: unknown;
  };
}

/**
 * Better Auth 1.7.2's anonymous plugin (dist/plugins/anonymous/types.d.mts,
 * read 2026-10-25). Plan 12i Task 16 maps it onto core's `anonymous`.
 */
export interface AnonymousOptions {
  /** The domain of the placeholder address: `temp-<id>@<emailDomainName>`. Default `<id>@anonymous.placeholder.invalid`. */
  emailDomainName?: string;
  /**
   * Core's `hooks.anonymous.afterLink`: after the commit of a sign-in over
   * an anonymous session. `proof` is core's: move data only on `"verified"`.
   * The two sessions are the rows that core holds at that point, or null.
   */
  onLinkAccount?: (data: {
    anonymousUser: { user: User & { isAnonymous: true }; session: Session | null };
    newUser: { user: User; session: Session | null };
    proof: "verified" | "unverified";
  }) => HookResult<void>;
  /** Refused with true: core deletes the anonymous user at each upgrade. */
  disableDeleteAnonymousUser?: boolean;
  /** The name of a new anonymous user. Default "Anonymous", as in Better Auth. Called with no argument. */
  generateName?: () => HookResult<string>;
  /** Refused: core writes the placeholder address itself. */
  generateRandomEmail?: unknown;
  /** Refused: core keeps `isAnonymous` in Better Auth's own column. */
  schema?: unknown;
}

/**
 * Better Auth 1.7.2's username plugin (dist/plugins/username/index.d.mts,
 * read 2026-10-25). Core's stored form is NFKC in lower case and matches
 * `^[a-z0-9_.]+$`; the typed case stays in `displayUsername`.
 */
export interface UsernameOptions {
  /** 3 to 30, as core's `username.minLength`. */
  minUsernameLength?: number;
  /** 3 to 30, as core's `username.maxLength`. */
  maxUsernameLength?: number;
  usernameValidator?: unknown;
  displayUsernameValidator?: unknown;
  usernameNormalization?: unknown;
  displayUsernameNormalization?: unknown;
  validationOrder?: unknown;
  immutableUsername?: boolean;
  displayUsername?: boolean;
  schema?: unknown;
}

/**
 * Better Auth 1.7.2's phone-number plugin (dist/plugins/phone-number/types.d.mts,
 * read 2026-10-25). `sendOTP` becomes core's SMS port: core makes, keys,
 * binds, counts, and caps every code, and this callback only delivers it.
 */
export interface PhoneNumberOptions {
  sendOTP: (data: { phoneNumber: string; code: string }) => HookResult<void>;
  /** Seconds, 60 to 600. Core rounds up to whole minutes. Default 300. */
  expiresIn?: number;
  /** 6 or 8. Default 6. */
  otpLength?: number;
  /** 3 to 10. Default 3. */
  allowedAttempts?: number;
  /** Core signs in only by a number that its code proved. */
  requireVerification?: boolean;
  /**
   * Core's `phone.signUp`. `getTempEmail` must answer an address on a
   * placeholder domain: core keeps no address for a phone user.
   * `getTempName` names the new user, as in Better Auth.
   */
  signUpOnVerification?: {
    getTempEmail: (phoneNumber: string) => string;
    getTempName?: (phoneNumber: string) => string;
  };
  verifyOTP?: unknown;
  sendPasswordResetOTP?: unknown;
  phoneNumberValidator?: unknown;
  callbackOnVerification?: unknown;
  schema?: unknown;
}

/** Better Auth 1.7.2's one-tap plugin (dist/plugins/one-tap/index.d.mts, read 2026-10-25). */
export interface OneTapOptions {
  /** Maps only when every sign-up method is closed: core's `signUp: false`. */
  disableSignup?: boolean;
  /** Core takes the client id of `socialProviders.google`. */
  clientId?: string;
}

/** Better Auth 1.7.2's multi-session plugin (dist/plugins/multi-session/index.d.mts, read 2026-10-25). */
export interface MultiSessionOptions {
  /** 2 to 10, core's `multiSession.max`. Default 5. */
  maximumSessions?: number;
}

/** Better Auth 1.7.2's last-login-method plugin (dist/plugins/last-login-method/index.d.mts, read 2026-10-25). */
export interface LastLoginMethodOptions {
  /** Core's `lastMethod.cookieName`. Default `better-auth.last_used_login_method`. */
  cookieName?: string;
  /** Seconds, whole days from 1 to 400, core's `lastMethod.days`. Default 30 days. */
  maxAge?: number;
  storeInDatabase?: boolean;
  customResolveMethod?: unknown;
  beforeStoreCookie?: unknown;
  schema?: unknown;
}

export interface MagicLinkOptions {
  sendMagicLink: (
    data: { email: string; url: string; token: string },
    request?: Request,
  ) => Promise<void> | void;
  expiresIn?: number;
  disableSignUp?: boolean;
  storeToken?: unknown;
}

/** The types of Better Auth 1.7.2's `sendVerificationOTP` (dist/plugins/email-otp/types.d.mts, read 2026-10-13). Core sends `sign-in`, `forget-password`, and, since plan 12a, `change-email`. */
export type EmailOtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

/**
 * Better Auth 1.7.2's `EmailOTPOptions` (dist/plugins/email-otp/types.d.mts,
 * read 2026-10-13), every key, so a key the check refuses still compiles and
 * the check names it (plan 9e).
 */
export interface EmailOtpOptions {
  sendVerificationOTP: (
    data: { email: string; otp: string; type: EmailOtpType },
    request?: Request,
  ) => Promise<void> | void;
  otpLength?: number;
  expiresIn?: number;
  allowedAttempts?: number;
  storeOTP?: unknown;
  disableSignUp?: boolean;
  generateOTP?: unknown;
  overrideDefaultEmailVerification?: boolean;
  sendVerificationOnSignUp?: boolean;
  resendStrategy?: unknown;
  /** Plan 12a maps `enabled`; `verifyCurrentEmail: true` is refused. */
  changeEmail?: { enabled?: boolean; verifyCurrentEmail?: boolean };
  rateLimit?: unknown;
}

/**
 * Better Auth 1.7.2's two-factor options (dist/plugins/two-factor/types.d.mts,
 * totp/index.d.mts, backup-codes/index.d.mts, read 2026-10-13). Plan 9f maps
 * `issuer`, `backupCodeOptions.amount` and `length`, and `trustDeviceMaxAge`;
 * `totpOptions.digits` 6 and `period` 30 and `accountLockout: { enabled: false }`
 * are accepted; the check refuses every other key by name. Core takes a
 * `length` of 23 to 32 (plan 12c).
 */
export interface TwoFactorOptions {
  issuer?: string;
  totpOptions?: {
    digits?: number;
    period?: number;
    backupCodes?: unknown;
    allowPasswordless?: boolean;
    disable?: boolean;
  };
  otpOptions?: unknown;
  backupCodeOptions?: {
    amount?: number;
    length?: number;
    customBackupCodesGenerate?: unknown;
    storeBackupCodes?: unknown;
    allowPasswordless?: boolean;
  };
  skipVerificationOnEnable?: boolean;
  allowPasswordless?: boolean;
  twoFactorTable?: string;
  schema?: unknown;
  twoFactorCookieMaxAge?: number;
  trustDeviceMaxAge?: number;
  accountLockout?: { enabled?: boolean; maxFailedAttempts?: number; durationSeconds?: number };
}

/**
 * Better Auth 1.7.7's admin options (dist/plugins/admin/types.d.mts, read
 * 2026-10-21). Plan 12f maps `adminRoles` onto core's platform role and
 * `impersonationSessionDuration` onto `operator.impersonation.ttlMinutes`.
 * The check refuses each other key with a line that names spec section 26.
 */
export interface AdminOptions {
  /** One core rank, for example "admin": the platform role in `authtempo.platformOrganization`. */
  adminRoles?: string | string[];
  /** Seconds, a whole number of minutes from 5 to 240. Default 3600. */
  impersonationSessionDuration?: number;
  defaultRole?: string;
  defaultBanReason?: string;
  defaultBanExpiresIn?: number;
  bannedUserMessage?: unknown;
  adminUserIds?: string[];
  allowImpersonatingAdmins?: boolean;
  schema?: unknown;
  ac?: unknown;
  roles?: unknown;
}

export interface BearerOptions {
  requireSignature?: boolean;
}

/** `expo()` takes no option that authtempo maps. */
export type ExpoOptions = Record<string, never>;

/**
 * Better Auth's api-key options (@better-auth/api-key 1.7.5
 * dist/types-y22rgFHR.d.mts `ApiKeyConfigurationOptions`, read 2026-10-21).
 * Plan 12k Task 12 maps `references`, `defaultPrefix`, `rateLimit`,
 * `enableMetadata`, `requireName`, the name bounds, `keyExpiration`, and
 * `permissions.defaultPermissions` (a set), and checks the rest
 * (check-options.ts). Every key is here, so a refused key fails at
 * construction by name, not in the compile.
 */
export interface ApiKeyOptions {
  configId?: string;
  apiKeyHeaders?: string | string[];
  disableKeyHashing?: boolean;
  customAPIKeyGetter?: unknown;
  customAPIKeyValidator?: unknown;
  customKeyGenerator?: unknown;
  startingCharactersConfig?: { shouldStore?: boolean; charactersLength?: number };
  defaultKeyLength?: number;
  defaultPrefix?: string;
  maximumPrefixLength?: number;
  minimumPrefixLength?: number;
  requireName?: boolean;
  maximumNameLength?: number;
  minimumNameLength?: number;
  enableMetadata?: boolean;
  keyExpiration?: {
    defaultExpiresIn?: number | null;
    disableCustomExpiresTime?: boolean;
    minExpiresIn?: number;
    maxExpiresIn?: number;
  };
  rateLimit?: { enabled?: boolean; timeWindow?: number; maxRequests?: number };
  enableSessionForAPIKeys?: boolean;
  permissions?: { defaultPermissions?: unknown };
  storage?: "database" | "secondary-storage";
  fallbackToDatabase?: boolean;
  customStorage?: unknown;
  deferUpdates?: boolean;
  references?: "user" | "organization";
  schema?: unknown;
}

/** One static bearer credential of a SCIM connection (@better-auth/scim 1.7.2 dist/index.d.mts:12). */
export interface ScimCredentialOptions {
  type: "bearer";
  /** The credential's id: the key of its limit and the actor name of its audit rows. */
  id: string;
  /** The clear token. The shim keeps its SHA-256 only, from construction on. */
  token: string;
  scopes?: readonly ScimScope[];
  expiresAt?: Date;
}

/** A SCIM scope of @better-auth/scim 1.7.2, the same four as core's. */
export type ScimScope =
  | "scim.users.read"
  | "scim.users.write"
  | "scim.groups.read"
  | "scim.groups.write";

/**
 * `scim(options)` of @better-auth/scim 1.7.2 (dist/index.d.mts:336, read
 * 2026-10-22). Each connection maps onto one organization: its
 * `provisioningDomainId`, else its `id`. The keys that core has no feature
 * for are typed here, so that checkOptions names each one.
 */
export interface ScimOptions {
  connections: readonly {
    id: string;
    credentials: readonly ScimCredentialOptions[];
    provisioningDomainId?: string;
  }[];
  authentication?: unknown;
  managedConnections?: unknown;
  identity?: unknown;
  projection?: unknown;
  compatibility?: { microsoftEntra?: { acceptLegacyGroupSchema?: boolean } };
}

/** The SAML options of `sso(options)` (@better-auth/sso 1.7.2 index-sM6JWXeV.d.mts:576 to :677). */
export interface SsoSamlOptions {
  enableInResponseToValidation?: boolean;
  allowIdpInitiated?: boolean;
  requestTTL?: number;
  clockSkew?: number;
  requireTimestamps?: boolean;
  algorithms?: {
    onDeprecated?: "reject" | "warn" | "allow";
    allowedSignatureAlgorithms?: string[];
    allowedDigestAlgorithms?: string[];
    allowedKeyEncryptionAlgorithms?: string[];
    allowedDataEncryptionAlgorithms?: string[];
  };
  maxResponseSize?: number;
  maxMetadataSize?: number;
  enableSingleLogout?: boolean;
  logoutRequestTTL?: number;
  wantLogoutRequestSigned?: boolean;
  wantLogoutResponseSigned?: boolean;
  idpInitiatedCallbackUrl?: string;
}

/**
 * `sso(options)` of @better-auth/sso 1.7.2 (index-sM6JWXeV.d.mts:320, read
 * 2026-10-22). The keys that core has no feature for are typed here, so
 * that checkOptions names each one.
 */
export interface SsoOptions {
  resolveUser?: unknown;
  guardProviderMutation?: unknown;
  /**
   * Runs as core's `hooks.sso.beforeSignIn`, before the first write of the
   * sign-in. `user` is null for a user that the sign-in creates. A throw
   * refuses the sign-in.
   */
  provisionUser?: (data: {
    user: User | null;
    userInfo: Record<string, unknown>;
    provider: { providerId: string; organizationId: string };
  }) => unknown;
  provisionUserOnEveryLogin?: boolean;
  organizationProvisioning?: {
    disabled?: boolean;
    defaultRole?: "member" | "admin";
    getRole?: unknown;
  };
  defaultSSO?: unknown;
  defaultOverrideUserInfo?: boolean;
  disableImplicitSignUp?: boolean;
  modelName?: string;
  fields?: unknown;
  schema?: unknown;
  providersLimit?: number | ((user: User) => unknown);
  trustEmailVerified?: boolean;
  domainVerification?: { enabled?: boolean; tokenPrefix?: string };
  redirectURI?: string;
  resolvePrivateKey?: unknown;
  saml?: SsoSamlOptions;
}

interface Marker<I extends string, O> {
  readonly kind: typeof COMPAT_PLUGIN;
  readonly id: I;
  readonly options: O;
}
export type OrganizationPlugin = Marker<"organization", OrganizationOptions>;
export type PasskeyPlugin = Marker<"passkey", PasskeyOptions>;
export type MagicLinkPlugin = Marker<"magic-link", MagicLinkOptions>;
export type EmailOtpPlugin = Marker<"email-otp", EmailOtpOptions>;
export type BearerPlugin = Marker<"bearer", BearerOptions>;
export type ExpoPlugin = Marker<"expo", ExpoOptions>;
export type TwoFactorPlugin = Marker<"two-factor", TwoFactorOptions>;
export type AdminPlugin = Marker<"admin", AdminOptions>;
export type ApiKeyPlugin = Marker<"api-key", ApiKeyOptions> & {
  /** True when the call had a second argument, which checkOptions refuses (plan 12k Task 12 review, L7). */
  readonly secondArgument?: true;
};
export type SsoPlugin = Marker<"sso", SsoOptions>;
/**
 * The options that the `scim` marker keeps: each credential with the
 * SHA-256 of its token in hex, never the token. `tokenHash` is null for a
 * token that is not a non-empty string, which checkOptions refuses.
 */
export type ScimMarkerOptions = Omit<ScimOptions, "connections"> & {
  connections: readonly {
    id: string;
    credentials: readonly (Omit<ScimCredentialOptions, "token"> & { tokenHash: string | null })[];
    provisioningDomainId?: string;
  }[];
};
export type ScimPlugin = Marker<"scim", ScimMarkerOptions>;
export type AnonymousPlugin = Marker<"anonymous", AnonymousOptions>;
export type UsernamePlugin = Marker<"username", UsernameOptions>;
export type PhoneNumberPlugin = Marker<"phone-number", PhoneNumberOptions>;
export type OneTapPlugin = Marker<"one-tap", OneTapOptions>;
export type MultiSessionPlugin = Marker<"multi-session", MultiSessionOptions>;
export type LastLoginMethodPlugin = Marker<"last-login-method", LastLoginMethodOptions>;
export type CompatPlugin =
  | AnonymousPlugin
  | UsernamePlugin
  | PhoneNumberPlugin
  | OneTapPlugin
  | MultiSessionPlugin
  | LastLoginMethodPlugin
  | SsoPlugin
  | ScimPlugin
  | AdminPlugin
  | OrganizationPlugin
  | PasskeyPlugin
  | MagicLinkPlugin
  | EmailOtpPlugin
  | BearerPlugin
  | ExpoPlugin
  | TwoFactorPlugin
  | ApiKeyPlugin;

/** A plugin from a package this one does not replace, for example `@better-auth/sso`. The check refuses it by id. */
export interface ForeignPlugin {
  id: string;
  [key: string]: unknown;
}

export type BetterAuthPlugin = CompatPlugin | ForeignPlugin;

/**
 * Better Auth 1.7.2's per-provider `disableSignUp`, which votes in core's one
 * sign-up rule (plan 12b). `disableImplicitSignUp` is refused, so it is not
 * here and fails the compile in a literal.
 */
export interface ProviderSignUp {
  disableSignUp?: boolean;
  /**
   * Core's `redirectURI` override (plan 12i Task 16). Default on an https
   * `baseURL`: Better Auth's own callback, `<baseURL><basePath>/callback/<id>`.
   */
  redirectURI?: string;
}

/**
 * Better Auth 1.7's option object, with the keys authtempo maps. Since plan
 * 9b no option type has an index signature, so a refused key in an object
 * literal of a plugin's options, or of an object that `satisfies` this type,
 * fails the compile. `betterAuth(options)` infers its type parameter from the
 * literal, so TypeScript does not check that literal for extra keys. One
 * check stays: the weak-type rule (TS2559; TS2353 for a literal). Each nested
 * option type has only optional keys, so a nested object with no key in
 * common with its type stops the compile, for example consumerd's
 * `rateLimit: { customStorage }`. Then the compile shows that one key, not the
 * full list. The runtime allow list (spec 16.1) stays the one complete
 * control, and it lists every refused key at construction. typetest/options.ts
 * pins both rules.
 */
/**
 * Better Auth's dynamic base URL (`@better-auth/core` 1.7.2
 * `types/init-options.d.mts`, read 2026-10-14). The shim maps it to core's
 * `baseURL` list (plan 12i Task 18): exact hosts only, and `protocol` must
 * be `https` or `http`.
 */
export interface DynamicBaseURLConfig {
  allowedHosts: string[];
  fallback?: string | undefined;
  protocol?: "http" | "https" | "auto" | undefined;
}

export interface BetterAuthOptions {
  appName?: string;
  baseURL?: string | DynamicBaseURLConfig;
  basePath?: string;
  secret?: string;
  /** The app secrets by version, the current first (Better Auth 1.7). Mapped to core's `secrets` (plan 12b). */
  secrets?: Array<{ version: number; value: string }>;
  trustedOrigins?: string[] | ((request?: Request) => string[] | Promise<string[]>);
  database?: CompatDatabase;
  emailAndPassword?: {
    enabled?: boolean;
    minPasswordLength?: number;
    maxPasswordLength?: number;
    requireEmailVerification?: boolean;
    autoSignIn?: boolean;
    disableSignUp?: boolean;
    revokeSessionsOnPasswordReset?: boolean;
    resetPasswordTokenExpiresIn?: number;
    sendResetPassword?: SendEmail;
  };
  emailVerification?: {
    sendVerificationEmail?: SendEmail;
    sendOnSignUp?: boolean;
    sendOnSignIn?: boolean;
    autoSignInAfterVerification?: boolean;
    expiresIn?: number;
    /**
     * Core's `user.beforeVerify` and `user.afterVerify` (plan 12a), on each
     * path that proves the address of an unverified user. The change of
     * address calls them too, as Better Auth 1.7.2 does. Both paths call the
     * after hook, and the code path also calls the before hook.
     */
    beforeEmailVerification?: (user: User, request?: Request) => HookResult<void>;
    afterEmailVerification?: (user: User, request?: Request) => HookResult<void>;
  };
  socialProviders?: {
    /**
     * A list of client ids is Better Auth's form for more ID-token audiences:
     * the first runs the redirect sign-in, and each id is an audience.
     */
    google?: { clientId: string | string[]; clientSecret: string } & ProviderSignUp;
    apple?: {
      clientId: string;
      /** The audiences of an Apple ID token, as in Better Auth: core's `social.apple.audiences`. */
      audience?: string | string[];
      /** The bundle id of the app: an audience when `audience` is absent, as in Better Auth. */
      appBundleIdentifier?: string;
      teamId?: string;
      keyId?: string;
      privateKey?: string;
      clientSecret?: string;
    } & ProviderSignUp;
    /** Core's GitHub preset (plan 9c). */
    github?: { clientId: string; clientSecret: string } & ProviderSignUp;
    /** Core's LinkedIn preset (plan 9c). */
    linkedin?: { clientId: string; clientSecret: string } & ProviderSignUp;
    /** Core's `tiktokEntry` (plan 12i Task 22): a list entry with no address. */
    tiktok?: { clientKey: string; clientSecret: string } & ProviderSignUp;
    /** Core's `wechatEntry` (plan 12i Task 22): the AppID and the AppSecret, with no address. */
    wechat?: { clientId: string; clientSecret: string } & ProviderSignUp;
    /** Core's Entra ID preset (plan 12i Task 16). `tenantId` is core's `tenant`, default `common`. */
    microsoft?: { clientId: string; clientSecret: string; tenantId?: string } & ProviderSignUp;
    /** Core's Discord preset (plan 12i Task 16). */
    discord?: { clientId: string; clientSecret: string } & ProviderSignUp;
    /** Core's GitLab preset (plan 12i Task 16). `issuer` is the origin of the instance. */
    gitlab?: { clientId: string; clientSecret: string; issuer?: string } & ProviderSignUp;
    /** Core's X preset (plan 12i Task 16). */
    twitter?: { clientId: string; clientSecret: string } & ProviderSignUp;
    /** Core's Facebook preset (plan 12i Task 16). */
    facebook?: { clientId: string; clientSecret: string } & ProviderSignUp;
  };
  session?: {
    expiresIn?: number;
    updateAge?: number;
    cookieCache?: { enabled?: boolean; maxAge?: number };
    storeSessionInDatabase?: boolean;
    /** Seconds, 1 to 86400. Core rounds up to whole minutes (plan 12a). */
    freshAge?: number;
    /**
     * Core's `session.deferRefresh` (plan 12a). A GET writes no session row,
     * `GET /get-session` answers `needsRefresh`, and `POST /get-session` slides the expiry.
     */
    deferSessionRefresh?: boolean;
  };
  /** Better Auth 1.7.2's `user` options that the shim maps (plan 12a). */
  user?: {
    changeEmail?: {
      enabled?: boolean;
      sendChangeEmailConfirmation?: unknown;
      updateEmailWithoutVerification?: boolean;
    };
    deleteUser?: {
      enabled?: boolean;
      beforeDelete?: (user: User, request?: Request) => HookResult<void>;
      afterDelete?: (user: User, request?: Request) => HookResult<void>;
      /**
       * Turns on core's mailed confirm, `account.deleteConfirm` (plan 12a
       * Task 20). The shim calls it with `{ user, url, token }` and no request.
       * `url` opens core's confirm page, which posts the token.
       */
      sendDeleteAccountVerification?: SendEmail;
      /** Seconds, a whole number of minutes from 300 to 86400. Core's `ttlMinutes`. Default 86400, as in Better Auth. */
      deleteTokenExpiresIn?: number;
    };
  };
  /** Better Auth 1.7.2's `account.accountLinking`, mapped onto core's link rule (plan 12a). */
  account?: {
    accountLinking?: {
      enabled?: boolean;
      allowDifferentEmails?: boolean;
      trustedProviders?: string[];
      allowUnlinkingAll?: boolean;
      updateUserInfoOnLink?: boolean;
      disableImplicitLinking?: boolean;
    };
  };
  advanced?: {
    ipAddress?: {
      ipAddressHeaders?: string[];
      disableIpTracking?: boolean;
    };
    defaultCookieAttributes?: { sameSite?: string };
    database?: { generateId?: unknown };
  };
  rateLimit?: { enabled?: boolean };
  plugins?: readonly BetterAuthPlugin[];
  telemetry?: { enabled?: boolean };
  /**
   * Plan 9d: `session.create.before` and `session.create.after`
   * (@better-auth/core 1.7.2 dist/types/init-options.d.mts, the databaseHooks
   * type, read 2026-10-13). `before` may answer `{ data }` with `ipAddress`,
   * `userAgent`, or `activeOrganizationId` changed, or `false` to refuse.
   * Plan 12a adds `user` and `account`. `user.create.before` may answer
   * `{ data }` with `name` and `image`. An account hook fires for a provider
   * account only: a credential account is core's password row.
   */
  databaseHooks?: {
    session?: {
      create?: {
        before?: (
          session: SessionDraftFields,
          context: null,
        ) => HookResult<boolean | BeforeHookAnswer>;
        after?: (session: Session, context: null) => HookResult<void>;
      };
    };
    user?: {
      create?: {
        before?: (user: User, context: null) => HookResult<boolean | BeforeHookAnswer>;
        after?: (user: User, context: null) => HookResult<void>;
      };
      update?: {
        before?: (data: Partial<User>, context: null) => HookResult<boolean | BeforeHookAnswer>;
        after?: (user: User, context: null) => HookResult<void>;
      };
      delete?: {
        // biome-ignore lint/suspicious/noConfusingVoidType: with undefined, a hook with no return statement does not type-check.
        before?: (user: User, context: null) => HookResult<boolean | void>;
        after?: (user: User, context: null) => HookResult<void>;
      };
    };
    account?: {
      create?: {
        // biome-ignore lint/suspicious/noConfusingVoidType: with undefined, a hook with no return statement does not type-check.
        before?: (account: AccountHookFields, context: null) => HookResult<boolean | void>;
        after?: (account: AccountHookFields, context: null) => HookResult<void>;
      };
      delete?: {
        // biome-ignore lint/suspicious/noConfusingVoidType: with undefined, a hook with no return statement does not type-check.
        before?: (account: AccountHookFields, context: null) => HookResult<boolean | void>;
        after?: (account: AccountHookFields, context: null) => HookResult<void>;
      };
    };
  };
  /**
   * The one key that is not Better Auth's. `passwordHash` replaces
   * `betterAuthPasswordHash()`, for example with a low cost in tests.
   * `appURL` is the origin the browser lands on after a sign-in (core's
   * `appURL`); default the origin of `baseURL`; it must be in
   * `trustedOrigins`. An absolute `callbackURL` or `redirectTo` must have
   * this origin, because core lands every sign-in on it.
   * `platformOrganization` is the slug of the platform organization, whose
   * members with the rank of `adminRoles` are platform operators (plan 12f,
   * spec section 26 item 1). The `admin` plugin needs it, and nothing else
   * takes it. `authtempo create-admin` creates the organization.
   */
  authtempo?: {
    passwordHash?: PasswordHashSeam;
    appURL?: string;
    platformOrganization?: string;
    /**
     * The rank of each role of `organization({ roles })` (plan 12k): Better
     * Auth's roles have none. Without `roles` the defaults are member 1,
     * admin 2, owner 3.
     */
    roleRanks?: Record<string, number>;
    /**
     * The prefixes of moved Better Auth keys beside the api-key plugin's
     * `defaultPrefix` (plan 12k Task 12). `moveBetterAuthApiKeys` reports
     * each stored prefix. Core's `tokens.movedPrefixes` rule checks them.
     */
    movedKeyPrefixes?: string[];
    /**
     * The DNS resolvers of the domain proof of the `sso` plugin (plan 12d
     * Task 14), core's `sso.dns`. Better Auth reads node:dns; core has no
     * default resolver. Pass `[dohCloudflare(fetch), dohGoogle(fetch)]` from
     * `@authtempo/core`, or your own ports. Every resolver must give the record.
     */
    ssoDns?: DnsTxtPort[];
    /**
     * The phone-number plugin's core settings (plan 12i Task 16). Better
     * Auth has none. `regions` lists the calling-code prefixes that get an
     * SMS, such as "+1": core has no default. `dailyCap` is the codes of
     * the deployment per 24 hours, 1 to 100000, default 1000.
     */
    phone?: { regions: string[]; dailyCap?: number };
    /**
     * The anonymous users that the deployment makes per 24 hours, 1 to
     * 100000 (plan 12i Task 16). Default 1000. Better Auth has no cap.
     */
    anonymousDailyCap?: number;
    /**
     * The most live sessions of one user, 1 to 1000: core's
     * `session.maxPerUser` (plan 12q). Default 100. Better Auth has no cap. A
     * sign-in past the cap ends the oldest session of the user, with the
     * reason `capped`. Sign-ins at once can leave more until the next
     * sign-in, as in core.
     */
    sessionMaxPerUser?: number;
  };
}

/** Better Auth 1.7.2's sign-in answer for a user with the factor on (dist/plugins/two-factor/index.mjs, the after hook, read 2026-10-13). */
export interface TwoFactorRedirect {
  twoFactorRedirect: true;
  twoFactorMethods: string[];
}

/**
 * True when the option type names the two-factor plugin. A wide
 * `BetterAuthOptions` (no literal plugin list) is false, so code that types
 * its options wide keeps the old sign-in type; the README says so.
 */
export type HasTwoFactor<O extends BetterAuthOptions> = O extends {
  plugins: readonly (infer P)[];
}
  ? BetterAuthPlugin extends P
    ? false
    : [Extract<P, TwoFactorPlugin>] extends [never]
      ? false
      : true
  : false;

/** True when the option type names the api-key plugin, as `HasTwoFactor` does. */
export type HasApiKey<O extends BetterAuthOptions> = O extends {
  plugins: readonly (infer P)[];
}
  ? BetterAuthPlugin extends P
    ? false
    : [Extract<P, ApiKeyPlugin>] extends [never]
      ? false
      : true
  : false;

/** Better Auth's answer of a key check. `error` holds Better Auth's code. */
export interface ApiKeyVerifyResult {
  valid: boolean;
  error: { code: string; message: string } | null;
  key: Omit<ApiKey, "key"> | null;
}

/**
 * The api-key calls of `auth.api` (@better-auth/api-key 1.7.5, plan 12k
 * Task 12), on core's tokens. With `references: "organization"` each call
 * acts on `api.organizationTokens`. With `headers` the caller is the session;
 * without them the body's `userId` is, as in Better Auth. The server-only
 * fields answer SERVER_ONLY_PROPERTY with `headers`.
 */
export interface ApiKeyServerApi {
  createApiKey(input: {
    body: {
      configId?: string;
      name?: string;
      /** Seconds, whole days only. */
      expiresIn?: number | null;
      /** Accepted and not used: a new key has core's prefix. */
      prefix?: string;
      remaining?: number | null;
      metadata?: Record<string, unknown>;
      refillAmount?: number;
      /** Milliseconds, whole seconds only. */
      refillInterval?: number;
      /** Milliseconds, whole seconds only. */
      rateLimitTimeWindow?: number;
      rateLimitMax?: number;
      rateLimitEnabled?: boolean;
      permissions?: Record<string, string[]>;
      userId?: string;
      organizationId?: string;
    };
    headers?: Headers;
  }): Promise<ApiKey & { key: string }>;
  /** Through `auth.authenticate`: it spends one call of the key's quota, as Better Auth does. */
  verifyApiKey(input: {
    body: { key: string; configId?: string; permissions?: Record<string, string[]> };
  }): Promise<ApiKeyVerifyResult>;
  getApiKey(input: {
    query: { id: string; configId?: string };
    headers: Headers;
  }): Promise<Omit<ApiKey, "key">>;
  listApiKeys(input: {
    query?: { configId?: string; organizationId?: string };
    headers: Headers;
  }): Promise<Omit<ApiKey, "key">[]>;
  /** Narrows only, as core's update. A wider value answers Better Auth's error for a bad body. */
  updateApiKey(input: {
    body: {
      keyId: string;
      configId?: string;
      userId?: string;
      name?: string;
      enabled?: boolean;
      remaining?: number;
      refillAmount?: number;
      refillInterval?: number;
      metadata?: Record<string, unknown>;
      expiresIn?: number | null;
      rateLimitEnabled?: boolean;
      rateLimitTimeWindow?: number;
      rateLimitMax?: number;
      permissions?: Record<string, string[]>;
    };
    headers?: Headers;
  }): Promise<Omit<ApiKey, "key">>;
  deleteApiKey(input: {
    body: { keyId: string; configId?: string };
    headers: Headers;
  }): Promise<{ success: true }>;
  /** Through core's `sweepExpired`, which deletes every expired row of core. */
  deleteAllExpiredApiKeys(): Promise<{ success: boolean; error: unknown }>;
}

/**
 * True when the option type has the key
 * `emailAndPassword.requireEmailVerification`, optional or not, with a type
 * other than `false` (plan 12b Task 15). Then `signUpEmail` can answer
 * `token: null`. A wide `BetterAuthOptions` has the optional key, so it is
 * true: its value at run time can be true. Only a literal object with no
 * such key, or with `false` as a literal type, keeps `token: string`.
 */
export type RequiresVerification<O extends BetterAuthOptions> =
  "requireEmailVerification" extends keyof NonNullable<O["emailAndPassword"]>
    ? [NonNullable<O["emailAndPassword"]>["requireEmailVerification"]] extends [false | undefined]
      ? false
      : true
    : false;

/**
 * The token type of `signUpEmail` by the flag. An indexed access, not a
 * conditional type, so that TypeScript measures `RV` as covariant: an
 * instance with `RV` false (token `string`) is assignable to the wide
 * `BetterAuthInstance` with `RV` true (token `string | null`), plan 12b Task 15.
 */
interface SignUpTokenOf {
  false: string;
  true: string | null;
}

export interface CompatServerApi<TF extends boolean = false, RV extends boolean = false> {
  /**
   * `user.twoFactorEnabled` is set with the two-factor plugin (plan 9f).
   * `role`, `banned`, `banReason`, and `banExpires` are set with the admin
   * plugin (plan 12f), and so is `session.impersonatedBy`.
   */
  getSession(input: { headers: Headers }): Promise<{
    session: Session & Partial<Omit<AdminSession, keyof Session>>;
    user: User & { twoFactorEnabled?: boolean } & Partial<Omit<AdminUser, keyof User>>;
    /** With `session.deferSessionRefresh` on only (plan 12a): the refresh is due. */
    needsRefresh?: boolean;
  } | null>;
  /**
   * `image` and `callbackURL` throw `APIError` NOT_SUPPORTED (501): core keeps neither.
   * `token` is null with `emailAndPassword.requireEmailVerification` (plan 12b): no session opens.
   * `signUpProof` is core's sign-up proof (plan 12q), a member that Better Auth does not have.
   * Set it as the HttpOnly cookie `__Host-tempo_signup` of the browser, or the confirm of the
   * link deletes the password.
   */
  signUpEmail(input: {
    body: {
      email: string;
      password: string;
      name: string;
      image?: string;
      callbackURL?: string;
      /** With the username plugin (plan 12i Task 16). */
      username?: string;
      /** The typed username only: core keeps it as displayUsername. */
      displayUsername?: string;
    };
    headers?: Headers;
  }): Promise<{ token: SignUpTokenOf[`${RV}`]; user: User; signUpProof: string }>;
  /** `callbackURL` and `rememberMe: false` throw `APIError` NOT_SUPPORTED (501): core keeps neither. */
  signInEmail(input: {
    body: { email: string; password: string; callbackURL?: string; rememberMe?: boolean };
    headers?: Headers;
  }): Promise<
    | { redirect: false; token: string; url: undefined; user: User }
    | (TF extends true ? TwoFactorRedirect : never)
  >;
  signOut(input: { headers: Headers }): Promise<{ success: true }>;
  signInMagicLink(input: {
    body: { email: string; callbackURL?: string; name?: string };
    headers?: Headers;
  }): Promise<{ status: true }>;
  /** Core's resend route (plan 8b). A `callbackURL` throws `APIError` NOT_SUPPORTED (501): core lands the link on the app origin. */
  sendVerificationEmail(input: {
    body: { email: string; callbackURL?: string };
    headers?: Headers;
  }): Promise<{ status: true }>;
  createInvitation(input: {
    body: { email: string; role: string; organizationId?: string };
    headers: Headers;
  }): Promise<Invitation>;
  cancelInvitation(input: {
    body: { invitationId: string };
    headers: Headers;
  }): Promise<Invitation>;
  listOrganizations(input: { headers: Headers }): Promise<Organization[]>;
  setActiveOrganization(input: {
    body: { organizationId: string | null };
    headers: Headers;
  }): Promise<Organization | null>;
  /**
   * Plan 12a. The id answers in `token` too: the shim never holds a clear
   * session token. No fresh rule, where Better Auth 1.7.2 asks for one.
   */
  listSessions(input: { headers: Headers }): Promise<Session[]>;
  /** `token` is a session id from the list, or a clear session token. Always `{ status: true }`, as in Better Auth. Fresh rule. */
  revokeSession(input: { body: { token: string }; headers: Headers }): Promise<{ status: true }>;
  /** Every session of the user, the caller's too. Fresh rule. */
  revokeSessions(input: { headers: Headers }): Promise<{ status: true }>;
  /** Every other session of the user. Fresh rule. */
  revokeOtherSessions(input: { headers: Headers }): Promise<{ status: true }>;
  /** `name` and `image`. `email` throws EMAIL_CAN_NOT_BE_UPDATED, and any other field FIELD_NOT_ALLOWED. */
  updateUser(input: { body: Record<string, unknown>; headers: Headers }): Promise<{ status: true }>;
  /** With `user.changeEmail.enabled`; else CHANGE_EMAIL_DISABLED. Fresh rule. */
  changeEmail(input: {
    body: { newEmail: string; callbackURL?: string };
    headers: Headers;
  }): Promise<{ status: true }>;
  /**
   * With `user.deleteUser.enabled`; else 404. `password` re-authenticates
   * first, as Better Auth's password path skips freshAge. Fresh rule. With
   * `sendDeleteAccountVerification`, it mails the link and answers
   * "Verification email sent" (plan 12a Task 20). `token` is the confirm of
   * that link, with a session of the same user and no fresh rule.
   * `callbackURL` throws NOT_SUPPORTED.
   */
  deleteUser(input: {
    body: { password?: string; token?: string; callbackURL?: string };
    headers: Headers;
  }): Promise<{ success: true; message: "User deleted" | "Verification email sent" }>;
  listUserAccounts(input: { headers: Headers }): Promise<Account[]>;
  /** `accountId` is an `id` from the list. A credential account throws NOT_SUPPORTED. Fresh rule. */
  unlinkAccount(input: {
    body: { accountId: string };
    headers: Headers;
  }): Promise<{ status: true }>;
  /**
   * The admin calls of plan 12f (ruling 60 m2). Each one runs the steps of
   * its `/admin/*` path with the caller's headers, so core's operator guard
   * decides. Each refusal throws `APIError` with the code of the path.
   * Without the `admin` plugin, each call throws 404.
   */
  listUsers(input: { query?: AdminListUsersQuery; headers: Headers }): Promise<AdminUserList>;
  getUser(input: { query: { id: string }; headers: Headers }): Promise<AdminUser>;
  /** `banExpiresIn` is in seconds. */
  banUser(input: {
    body: { userId: string; banReason?: string; banExpiresIn?: number };
    headers: Headers;
  }): Promise<AdminActAnswer>;
  unbanUser(input: { body: { userId: string }; headers: Headers }): Promise<{ user: AdminUser }>;
  /** The platform role grants it, and `user` revokes it. */
  setRole(input: {
    body: { userId: string; role: string | string[] };
    headers: Headers;
  }): Promise<AdminActAnswer>;
  /** One page per call: while sessions stay, `{ success: false, more: true, ended }`. */
  revokeUserSessions(input: {
    body: { userId: string };
    headers: Headers;
  }): Promise<{ success: true } | { success: false; more: true; ended: number }>;
  impersonateUser(input: {
    body: { userId: string };
    headers: Headers;
  }): Promise<{ session: AdminSession; user: AdminUser }>;
  /** Null fields when no operator session comes back. */
  stopImpersonating(input: {
    headers: Headers;
  }): Promise<{ session: AdminSession | null; user: AdminUser | null }>;
  /**
   * Plan 12f2. `data` takes `name` and `image` only; any other key throws.
   * It answers the user itself, as Better Auth 1.7.7 does.
   */
  adminUpdateUser(input: {
    body: { userId: string; data: { name?: string | null; image?: string | null } };
    headers: Headers;
  }): Promise<AdminUser>;
  /** Plan 12f2. Core's operator delete: the account and its solo organizations go. */
  removeUser(input: { body: { userId: string }; headers: Headers }): Promise<{ success: true }>;
  /**
   * Plan 12f2. Core's operator create, with no mail. It takes no password:
   * any password, a role other than `user`, a ban key, and any other key of
   * `data` throw. It answers `{ user }`, as Better Auth 1.7.7 does.
   */
  createUser(input: { body: AdminCreateUserBody; headers: Headers }): Promise<{ user: AdminUser }>;
  /**
   * The calls of the sign-in plugins (plan 12i Task 16). Each runs the
   * handler's steps of its path with the caller's headers. Without the
   * plugin, each throws 404. A server caller has no cookie jar: a sign-in
   * answers the token, and a multi-session call reads the cookies of `headers`.
   */
  signInAnonymous(input?: { headers?: Headers }): Promise<{ token: string; user: User }>;
  deleteAnonymousUser(input: { headers: Headers }): Promise<{ success: true }>;
  signInUsername(input: {
    body: { username: string; password: string; rememberMe?: boolean; callbackURL?: string };
    headers?: Headers;
  }): Promise<{ token: string; user: User } | TwoFactorRedirect>;
  isUsernameAvailable(input: {
    body: { username: string };
    headers?: Headers;
  }): Promise<{ available: boolean }>;
  /** With a session in `headers`, the code adds the number to that user; else it signs in. */
  sendPhoneNumberOTP(input: {
    body: { phoneNumber: string };
    headers?: Headers;
  }): Promise<{ message: "code sent" }>;
  verifyPhoneNumber(input: {
    body: {
      phoneNumber: string;
      code: string;
      disableSession?: boolean;
      updatePhoneNumber?: boolean;
    };
    headers?: Headers;
  }): Promise<{ status: true; token: string | null; user: User }>;
  signInPhoneNumber(input: {
    body: { phoneNumber: string; password: string; rememberMe?: boolean };
    headers?: Headers;
  }): Promise<{ token: string; user: User } | TwoFactorRedirect>;
  oneTapCallback(input: {
    body: { idToken: string };
    headers?: Headers;
  }): Promise<{ token: string; user: User }>;
  /** The ID token form only, for google and apple. `nonce` comes from core's nonce route. */
  signInSocial(input: {
    body: { provider: string; idToken: { token: string; nonce?: string } };
    headers?: Headers;
  }): Promise<{ redirect: false; token: string; user: User }>;
  /** `session.token` holds the session id: the shim never holds a clear token. */
  listDeviceSessions(input: { headers: Headers }): Promise<{ session: Session; user: User }[]>;
  /** `sessionToken` is a `session.token` of the list. */
  setActiveSession(input: {
    body: { sessionToken: string };
    headers: Headers;
  }): Promise<{ session: Session; user: User }>;
  revokeDeviceSession(input: {
    body: { sessionToken: string };
    headers: Headers;
  }): Promise<{ status: true }>;
}

/** Better Auth's list-users query (dist/plugins/admin/routes.mjs, read 2026-10-21), and the shim's `after`. */
export interface AdminListUsersQuery {
  searchValue?: string;
  searchField?: "email" | "name";
  searchOperator?: "contains" | "starts_with" | "ends_with";
  limit?: string | number;
  offset?: string | number;
  sortBy?: string;
  sortDirection?: "asc" | "desc";
  filterField?: string;
  filterValue?: string | number | boolean;
  /** Only `eq` maps onto core; each other operator throws NOT_SUPPORTED. */
  filterOperator?: string;
  /** The shim's own key: the `next` of the page before. */
  after?: string;
}

/**
 * Better Auth's create-user body (dist/plugins/admin/routes.mjs, read
 * 2026-10-25) as core's operator create takes it (plan 12f2). It has no
 * `password`: core lets no operator set one (spec section 26).
 */
export interface AdminCreateUserBody {
  email: string;
  name: string;
  /** The default role only: a grant of the platform role goes through set-role. */
  role?: "user" | ["user"];
  data?: { emailVerified?: boolean; image?: string | null; role?: "user" | ["user"] };
}

/**
 * The answer of a ban and a set-role. `familyEndFailed: true`: the act ran,
 * but the end of the OAuth refresh families failed. End the user's sessions
 * again with `/admin/revoke-user-sessions` (ruling 62 m2).
 */
export interface AdminActAnswer {
  user: AdminUser;
  familyEndFailed?: true;
}

/**
 * The list-users answer (rulings 53 and 62). `total` comes only on a first
 * page that ends the list. `next` comes on a page that does not end it.
 */
export interface AdminUserList {
  users: AdminUser[];
  total?: number;
  limit?: number;
  offset: number;
  next?: string;
}

export interface BetterAuthInstance<O extends BetterAuthOptions = BetterAuthOptions> {
  /**
   * Serves the routes. On Workers pass `{ waitUntil: (p) => ctx.waitUntil(p) }`:
   * the handler then starts one flush of `tempo.observe` after the answer
   * (plan 12h). The shim has no `observe` option yet. The engine keeps the
   * default observer, which writes each fault line at once, so the flush has
   * nothing to send.
   */
  handler(request: Request, options?: HandleOptions): Promise<Response>;
  api: CompatServerApi<HasTwoFactor<O>, RequiresVerification<O>> &
    (HasApiKey<O> extends true ? ApiKeyServerApi : unknown);
  /** Type-only, as in Better Auth: `Auth["$Infer"]["Session"]["user"]`. The runtime value is an empty object. */
  $Infer: { Session: { session: Session; user: User } };
  options: O;
  /** The engine under the shim, for `tempo.api.sweepExpired()` in a scheduled handler. */
  tempo: Auth;
}

// The client.

/**
 * The user of the client. The fields of `PluginUserFields` are there with
 * their client plugin, on each answer of a shim path and on the session read.
 */
export interface ClientUser extends PluginUserFields {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
}

/**
 * The fields of the admin plugin on the session user (ruling 54 of plan
 * 12f). The client gives them with `adminClient()` only, read from the
 * shim's `/get-session`.
 */
export interface ClientAdminFields {
  role: string;
  banned: boolean;
  banReason: string | null;
  banExpires: Date | null;
}

/** The user of a session read: `ClientUser`, and the admin fields with `adminClient()`. */
export type ClientSessionUser = ClientUser & Partial<ClientAdminFields>;

export interface ClientSession {
  id: string;
  userId: string;
  expiresAt: Date;
  activeOrganizationId: string | null;
  /** Better Auth's teams option (plan 12k ruling 41): the active team, or null. */
  activeTeamId: string | null;
}

/**
 * The passkey of `POST /passkey/update-passkey` (plan 12a): Better Auth
 * 1.7.2's row without `publicKey`, `counter`, `transports`, and `aaguid`,
 * which core keeps out of its answers. `createdAt` is ISO 8601 text.
 */
export interface Passkey {
  id: string;
  name: string | null;
  userId: string;
  credentialID: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
}

export interface ClientPasskey {
  id: string;
  name: string | null;
  credentialID: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: Date;
}

export interface CompatClientError {
  code: string;
  message: string;
  status: number;
  statusText: string;
}

export type CompatClientResult<T> =
  | { data: T; error: null }
  | { data: null; error: CompatClientError };

export interface SuccessContext {
  data: unknown;
  response: Response;
  request: { url: string; method: string };
}

export interface ErrorContext {
  error: CompatClientError;
  response: Response | null;
  request: { url: string; method: string };
}

export interface ClientFetchOptions {
  /** Written out, not the DOM `RequestCredentials`: tsconfig.d1.json compiles this file with workers-types, which has no such name. */
  credentials?: "include" | "omit" | "same-origin";
  headers?: Record<string, string>;
  onSuccess?: (ctx: SuccessContext) => void | Promise<void>;
  onError?: (ctx: ErrorContext) => void | Promise<void>;
  customFetchImpl?: typeof fetch;
}

/** The part of `expo-secure-store` the Expo plugin calls. Pass the module itself. */
export interface ExpoStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ExpoClientOptions {
  scheme: string;
  storagePrefix?: string;
  storage: ExpoStorageLike;
  /** `expo-web-browser`, for `signIn.social` and `signIn.magicLink` through the handoff. Without it those two answer NOT_SUPPORTED. */
  webBrowser?: ExpoWebBrowserLike;
  /** `expo-crypto`, for the handoff's PKCE on Hermes. */
  crypto?: ExpoCryptoLike<unknown>;
}

/** `twoFactorClient(options)` of Better Auth 1.7.2 (dist/plugins/two-factor/client.mjs, read 2026-10-13). */
export interface TwoFactorClientOptions {
  /** Where the browser goes on a challenge, as Better Auth's twoFactorPage. */
  twoFactorPage?: string;
  onTwoFactorRedirect?: (ctx: { twoFactorMethods: string[] }) => void | Promise<void>;
}

export const COMPAT_CLIENT_PLUGIN = "authtempo-compat-client-plugin";

/** `organizationClient(options)` of Better Auth 1.7.2 (dist/plugins/organization/client.mjs, read 2026-10-21). */
export interface OrganizationClientOptions {
  ac?: AccessControl;
  /** The roles that `checkRolePermission` reads, over Better Auth's three defaults. */
  roles?: Record<string, Role>;
  /** Accepted: the role calls are always on the client, and the server decides. */
  dynamicAccessControl?: { enabled?: boolean };
}

export type ClientPlugin =
  | {
      readonly kind: typeof COMPAT_CLIENT_PLUGIN;
      readonly id:
        | "passkey"
        | "magic-link"
        | "email-otp"
        | "admin"
        | "api-key"
        | "sso"
        | "anonymous"
        | "username"
        | "phone-number"
        | "multi-session";
    }
  | {
      readonly kind: typeof COMPAT_CLIENT_PLUGIN;
      readonly id: "last-login-method";
      readonly options?: { cookieName?: string };
    }
  | {
      readonly kind: typeof COMPAT_CLIENT_PLUGIN;
      readonly id: "organization";
      readonly options?: OrganizationClientOptions;
    }
  | {
      readonly kind: typeof COMPAT_CLIENT_PLUGIN;
      readonly id: "expo";
      readonly options: ExpoClientOptions;
    }
  | {
      readonly kind: typeof COMPAT_CLIENT_PLUGIN;
      readonly id: "two-factor";
      readonly options: TwoFactorClientOptions;
    };

/** True only for client options whose literal plugin list holds `twoFactorClient()`. */
export type HasTwoFactorClient<O extends ClientOptions> = O extends {
  plugins: readonly (infer P)[];
}
  ? ClientPlugin extends P
    ? false
    : [Extract<P, { id: "two-factor" }>] extends [never]
      ? false
      : true
  : false;

export interface ClientOptions {
  baseURL?: string | undefined;
  basePath?: string;
  fetchOptions?: ClientFetchOptions;
  plugins?: readonly ClientPlugin[];
  /** The one key that is not Better Auth's. `webauthn` replaces the browser's WebAuthn, for example with a soft authenticator in tests. */
  authtempo?: { webauthn?: BrowserWebAuthn };
}

export interface SessionState {
  data: { session: ClientSession; user: ClientSessionUser } | null;
  error: CompatClientError | null;
  isPending: boolean;
  isRefetching: boolean;
}

export interface SessionStore {
  get(): SessionState;
  subscribe(listener: () => void): () => void;
  refetch(): Promise<void>;
}

/** A stored role as Better Auth's role calls answer it, with Better Auth's resource names. */
export interface OrganizationRoleData {
  id: string;
  organizationId: string;
  role: string;
  permission: Record<string, string[]>;
  createdAt: Date;
  updatedAt: Date;
}

/** A stored role by name or by id, as Better Auth's role calls take it. */
export type RoleRef = { roleName: string; roleId?: never } | { roleId: string; roleName?: never };

export interface AuthClient<TF extends boolean = false> {
  signIn: {
    email(input: {
      email: string;
      password: string;
      callbackURL?: string;
      rememberMe?: boolean;
    }): Promise<
      CompatClientResult<
        | { redirect: boolean; token: string; url?: string; user: ClientUser }
        | (TF extends true ? TwoFactorRedirect : never)
      >
    >;
    social(input: {
      provider: string;
      callbackURL?: string;
      disableRedirect?: boolean;
      /** Answers NOT_SUPPORTED: no shim hook can read it. Core's `social.stateData` takes its place (plan 12i ruling 5). */
      additionalData?: Record<string, unknown>;
    }): Promise<CompatClientResult<{ url: string; redirect: boolean }>>;
    magicLink(input: {
      email: string;
      callbackURL?: string;
      name?: string;
    }): Promise<CompatClientResult<{ status: true }>>;
    passkey(input?: {
      autoFill?: boolean;
    }): Promise<CompatClientResult<{ session: ClientSession; user: ClientUser }>>;
    /**
     * `POST /sign-in/sso` of @better-auth/sso 1.7.2 (plan 12d Task 14): the
     * start path of the connection that one key names. In a browser the
     * client goes there. The keys that core has no feature for answer
     * NOT_SUPPORTED from the server.
     */
    sso(input: {
      email?: string;
      organizationSlug?: string;
      providerId?: string;
      domain?: string;
      callbackURL: string;
      providerType?: "oidc" | "saml";
      errorCallbackURL?: string;
      newUserCallbackURL?: string;
      scopes?: string[];
      loginHint?: string;
      additionalParams?: Record<string, string>;
      requestSignUp?: boolean;
    }): Promise<CompatClientResult<{ url: string; redirect: boolean }>>;
    /** Core's sign-in by email code (plan 9e). `name`, `image`, and other user fields answer NOT_SUPPORTED. */
    emailOtp(input: {
      email: string;
      otp: string;
      name?: string;
      image?: string;
    }): Promise<CompatClientResult<{ token: string; user: ClientUser }>>;
    /** The anonymous plugin (plan 12i Task 16): core's anonymous sign-in. */
    anonymous(): Promise<CompatClientResult<{ token: string; user: ClientUser }>>;
    /** The username plugin (plan 12i Task 16): core's password sign-in by username. */
    username(input: {
      username: string;
      password: string;
      rememberMe?: boolean;
      callbackURL?: string;
    }): Promise<
      CompatClientResult<
        { token: string; user: ClientUser } | (TF extends true ? TwoFactorRedirect : never)
      >
    >;
    /** The phone-number plugin (plan 12i Task 16): core's password sign-in by phone. */
    phoneNumber(input: {
      phoneNumber: string;
      password: string;
      rememberMe?: boolean;
    }): Promise<
      CompatClientResult<
        { token: string; user: ClientUser } | (TF extends true ? TwoFactorRedirect : never)
      >
    >;
  };
  /** The anonymous plugin: core's delete of the caller's own anonymous user. */
  deleteAnonymousUser(): Promise<CompatClientResult<{ success: true }>>;
  /** The username plugin: true when no user holds the name. */
  isUsernameAvailable(input: {
    username: string;
  }): Promise<CompatClientResult<{ available: boolean }>>;
  /** The phone-number plugin. With a session, the code adds the number to the caller. */
  phoneNumber: {
    sendOtp(input: { phoneNumber: string }): Promise<CompatClientResult<{ message: string }>>;
    verify(input: {
      phoneNumber: string;
      code: string;
      disableSession?: boolean;
      updatePhoneNumber?: boolean;
    }): Promise<CompatClientResult<{ status: true; token: string | null; user: ClientUser }>>;
  };
  /** The multi-session plugin. `session.token` holds the session id: the client never sees a token. */
  multiSession: {
    listDeviceSessions(): Promise<
      CompatClientResult<{ session: ClientSession; user: ClientUser }[]>
    >;
    setActive(input: {
      sessionToken: string;
    }): Promise<CompatClientResult<{ session: ClientSession; user: ClientUser }>>;
    revoke(input: { sessionToken: string }): Promise<CompatClientResult<{ status: true }>>;
  };
  /**
   * The last-login-method plugin: the method of core's readable cookie in
   * Better Auth's names (`email`, `magic-link`, `email-otp`, `passkey`, a
   * provider id, `username`, `phone-number`), or null. A hint only.
   */
  getLastUsedLoginMethod(): string | null;
  isLastUsedLoginMethod(method: string): boolean;
  clearLastUsedLoginMethod(): void;
  signUp: {
    email(input: {
      email: string;
      password: string;
      name: string;
      image?: string;
      callbackURL?: string;
      /** With the username plugin (plan 12i Task 16). */
      username?: string;
      /** The typed username only: core keeps it as displayUsername. */
      displayUsername?: string;
      // null while the server's requireEmailVerification is on (plan 12b): no session opens.
    }): Promise<CompatClientResult<{ token: string | null; user: ClientUser }>>;
  };
  signOut(): Promise<CompatClientResult<{ success: true }>>;
  /** With `adminClient()`, the user holds `role`, `banned`, `banReason`, and `banExpires` (plan 12f). */
  getSession(): Promise<
    CompatClientResult<{ session: ClientSession; user: ClientSessionUser } | null>
  >;
  /** Core's resend route (plan 8b). A `callbackURL` answers NOT_SUPPORTED: core lands the link on the app origin. */
  sendVerificationEmail(input: {
    email: string;
    callbackURL?: string;
  }): Promise<CompatClientResult<{ status: true }>>;
  requestPasswordReset(input: {
    email: string;
    redirectTo?: string;
  }): Promise<CompatClientResult<{ status: true }>>;
  /** The Better Auth 1.6 name of `requestPasswordReset`, and Better Auth 1.7.2's `forgetPassword.emailOtp` (plan 9e). */
  forgetPassword: {
    (input: { email: string; redirectTo?: string }): Promise<CompatClientResult<{ status: true }>>;
    /** A reset code. Better Auth 1.7.2 marks this path deprecated for `emailOtp.requestPasswordReset`. */
    emailOtp(input: { email: string }): Promise<CompatClientResult<{ success: true }>>;
  };
  resetPassword(input: {
    newPassword: string;
    token: string;
  }): Promise<CompatClientResult<{ status: true }>>;
  /** Better Auth 1.7.2's email OTP calls on core's email codes (plan 9e; dist/plugins/email-otp, read 2026-10-13). */
  emailOtp: {
    /** `sign-in` and `forget-password`; the other types answer NOT_SUPPORTED. */
    sendVerificationOtp(input: {
      email: string;
      type: EmailOtpType;
    }): Promise<CompatClientResult<{ success: true }>>;
    requestPasswordReset(input: { email: string }): Promise<CompatClientResult<{ success: true }>>;
    resetPassword(input: {
      email: string;
      otp: string;
      password: string;
    }): Promise<CompatClientResult<{ success: true }>>;
  };
  organization: {
    create(input: {
      name: string;
      slug: string;
      logo?: string;
      metadata?: Record<string, unknown>;
    }): Promise<CompatClientResult<Organization & { members: Member[] }>>;
    list(): Promise<CompatClientResult<Organization[]>>;
    setActive(input: {
      organizationId: string | null;
    }): Promise<CompatClientResult<Organization | null>>;
    inviteMember(input: {
      email: string;
      role: string;
      organizationId?: string;
    }): Promise<CompatClientResult<Invitation>>;
    acceptInvitation(input: {
      invitationId: string;
    }): Promise<CompatClientResult<{ member: Member; organization: Organization }>>;
    getFullOrganization(input?: {
      organizationId?: string;
    }): Promise<
      CompatClientResult<(Organization & { members: Member[]; invitations: Invitation[] }) | null>
    >;
    /**
     * Core's dynamic roles in Better Auth's shapes (plan 12k). A role's
     * `additionalFields` and a new `roleName` answer NOT_SUPPORTED (501): core
     * keeps no extra field and renames no role.
     */
    createRole(input: {
      role: string;
      permission: Record<string, readonly string[]>;
      organizationId?: string;
      additionalFields?: Record<string, unknown>;
    }): Promise<
      CompatClientResult<{
        success: true;
        roleData: OrganizationRoleData;
        statements: Record<string, readonly string[]>;
      }>
    >;
    deleteRole(
      input: { organizationId?: string } & RoleRef,
    ): Promise<CompatClientResult<{ success: true }>>;
    listRoles(input?: {
      query?: { organizationId?: string };
    }): Promise<CompatClientResult<OrganizationRoleData[]>>;
    getRole(input: {
      query: { organizationId?: string } & RoleRef;
    }): Promise<CompatClientResult<OrganizationRoleData>>;
    updateRole(
      input: {
        organizationId?: string;
        data: {
          permission?: Record<string, readonly string[]>;
          roleName?: string;
          [field: string]: unknown;
        };
      } & RoleRef,
    ): Promise<CompatClientResult<{ success: true; roleData: OrganizationRoleData }>>;
    /**
     * Core's check of the session in the organization. `allowCreatorAllPermissions`
     * answers NOT_SUPPORTED (501). Better Auth's body takes `permission` or
     * `permissions` (organization.mjs:21, read 2026-10-21), so this call takes both.
     */
    hasPermission(input: {
      permissions?: Record<string, readonly string[]>;
      permission?: Record<string, readonly string[]>;
      organizationId?: string;
      allowCreatorAllPermissions?: boolean;
    }): Promise<CompatClientResult<{ error: null; success: boolean }>>;
    /**
     * Better Auth's client check over the roles of `organizationClient`. It only
     * hides a control. Better Auth reads `permissions` only (client.mjs:44 and
     * client.d.mts:130, read 2026-10-21), so this call takes no `permission`.
     */
    checkRolePermission(input: {
      role: string;
      permissions: Record<string, readonly string[]>;
    }): boolean;
    /**
     * Core's teams in Better Auth's shapes (plan 12k Task 11). Each call with
     * no `organizationId` takes the active organization. A team's
     * `additionalFields` answer NOT_SUPPORTED (501): core keeps no extra field.
     */
    createTeam(input: {
      name: string;
      organizationId?: string;
      [field: string]: unknown;
    }): Promise<CompatClientResult<Team>>;
    updateTeam(input: {
      teamId: string;
      data: { name?: string; organizationId?: string; [field: string]: unknown };
    }): Promise<CompatClientResult<Team>>;
    removeTeam(input: {
      teamId: string;
      organizationId?: string;
    }): Promise<CompatClientResult<{ message: string }>>;
    listTeams(input?: { query?: { organizationId?: string } }): Promise<CompatClientResult<Team[]>>;
    /** `null` clears the active team. */
    setActiveTeam(input?: { teamId?: string | null }): Promise<CompatClientResult<Team | null>>;
    /** The session user's teams. A `userId` of another person answers NOT_SUPPORTED (501). */
    listUserTeams(input?: {
      query?: { userId?: string; organizationId?: string };
    }): Promise<CompatClientResult<Team[]>>;
    /** With no `teamId`, the members of the active team. */
    listTeamMembers(input?: {
      query?: { teamId?: string };
    }): Promise<CompatClientResult<TeamMember[]>>;
    addTeamMember(input: {
      teamId: string;
      userId: string;
      organizationId?: string;
    }): Promise<CompatClientResult<TeamMember>>;
    removeTeamMember(input: {
      teamId: string;
      userId: string;
      organizationId?: string;
    }): Promise<CompatClientResult<{ message: string }>>;
    /**
     * Core's slug check. A free slug answers `{ status: true }`. A taken or
     * reserved slug answers ORGANIZATION_SLUG_ALREADY_TAKEN (409), and a slug
     * that core's rule refuses answers VALIDATION_ERROR (400).
     */
    checkSlug(input: { slug: string }): Promise<CompatClientResult<{ status: true }>>;
  };
  /**
   * Better Auth's api-key calls on core's tokens (plan 12k Task 12). A call
   * with `organizationId` acts on the organization's tokens, else on the
   * session user's own. The server-only fields answer SERVER_ONLY_PROPERTY,
   * as in Better Auth. `enabled` and a `metadata` change answer
   * NOT_SUPPORTED (501): core has no disabled token and keeps its metadata.
   */
  apiKey: {
    create(input: {
      name?: string;
      /** Seconds, whole days only. */
      expiresIn?: number | null;
      /** Accepted and not used: a new key has core's prefix. */
      prefix?: string;
      metadata?: Record<string, unknown>;
      organizationId?: string;
      [field: string]: unknown;
    }): Promise<CompatClientResult<ApiKey & { key: string }>>;
    list(input?: {
      query?: { organizationId?: string };
    }): Promise<CompatClientResult<Omit<ApiKey, "key">[]>>;
    get(input: {
      query: { id: string; organizationId?: string };
    }): Promise<CompatClientResult<Omit<ApiKey, "key">>>;
    update(input: {
      keyId: string;
      name?: string;
      /** Seconds from now, whole days only. Earlier than the key's expiry only. */
      expiresIn?: number;
      organizationId?: string;
      [field: string]: unknown;
    }): Promise<CompatClientResult<Omit<ApiKey, "key">>>;
    delete(input: {
      keyId: string;
      organizationId?: string;
    }): Promise<CompatClientResult<{ success: true }>>;
  };
  passkey: {
    addPasskey(input?: { name?: string }): Promise<CompatClientResult<ClientPasskey>>;
    listUserPasskeys(): Promise<CompatClientResult<ClientPasskey[]>>;
    deletePasskey(input: { id: string }): Promise<CompatClientResult<{ status: true }>>;
    /**
     * Core's `passkeys.rename` (plan 12a). The name is trimmed, as Better Auth
     * 1.7.2 does. An unknown id and the id of another user's passkey answer
     * `PASSKEY_NOT_FOUND` (404).
     */
    updatePasskey(input: {
      id: string;
      name: string;
    }): Promise<CompatClientResult<{ passkey: ClientPasskey }>>;
  };
  /**
   * Better Auth's two-factor calls (plan 9f). `enable`, `disable`,
   * `getTotpUri`, and `generateBackupCodes` take the password. After a
   * sign-in that answered `twoFactorRedirect`, `verifyTotp` and
   * `verifyBackupCode` send the challenge that the client keeps; with a
   * session and no challenge, `verifyTotp` turns the factor on.
   */
  twoFactor: {
    enable(input: {
      password: string;
      issuer?: string;
    }): Promise<CompatClientResult<{ totpURI: string; backupCodes: string[] }>>;
    disable(input: { password: string }): Promise<CompatClientResult<{ status: true }>>;
    getTotpUri(input: { password: string }): Promise<CompatClientResult<{ totpURI: string }>>;
    generateBackupCodes(input: {
      password: string;
    }): Promise<CompatClientResult<{ status: true; backupCodes: string[] }>>;
    verifyTotp(input: {
      code: string;
      trustDevice?: boolean;
    }): Promise<CompatClientResult<{ token: string; user: ClientUser }>>;
    verifyBackupCode(input: {
      code: string;
      trustDevice?: boolean;
      disableSession?: boolean;
    }): Promise<CompatClientResult<{ token: string; user: ClientUser }>>;
    /** Core has no email or SMS second factor: NOT_SUPPORTED (501). */
    sendOtp(): Promise<CompatClientResult<never>>;
    verifyOtp(input: { code: string }): Promise<CompatClientResult<never>>;
  };
  /** In `./client` a store. `./react` replaces it with the hook. */
  /**
   * Better Auth's `authClient.admin` calls (ruling 60 m1 of plan 12f). The
   * mapped calls send the shim's `/admin/*` paths, so core's operator guard
   * decides. Each call that core does not serve answers NOT_SUPPORTED.
   */
  admin: AdminClientCalls;
  /**
   * The `authClient.sso` calls of @better-auth/sso 1.7.2's client
   * (dist/client.d.mts, read 2026-10-22), on the shim's `/sso/*` paths
   * (plan 12d Task 14). Core's session, manager guard, and audit decide.
   */
  sso: SsoClientCalls;
  useSession: SessionStore;
  /** Expo only: the stored session as one cookie header value, `__Host-tempo_session=<token>`, or "" when none. */
  getCookie(): string;
  $Infer: { Session: { session: ClientSession; user: ClientSessionUser } };
}

/** One provider as the shim's `/sso/*` paths answer it, in Better Auth's shape. */
export type SsoProviderAnswer = Record<string, unknown> & {
  providerId: string;
  type: "oidc" | "saml";
  organizationId: string;
  domainVerified: boolean;
};

/** The calls of `authClient.sso` (plan 12d Task 14). Each body is Better Auth's. */
export interface SsoClientCalls {
  register(input: Record<string, unknown>): Promise<CompatClientResult<SsoProviderAnswer>>;
  providers(): Promise<CompatClientResult<{ providers: SsoProviderAnswer[] }>>;
  getProvider(input: {
    query: { providerId: string };
  }): Promise<CompatClientResult<SsoProviderAnswer>>;
  updateProvider(
    input: Record<string, unknown> & { providerId: string },
  ): Promise<CompatClientResult<SsoProviderAnswer>>;
  deleteProvider(input: { providerId: string }): Promise<CompatClientResult<{ success: boolean }>>;
  requestDomainVerification(input: { providerId: string }): Promise<
    CompatClientResult<{
      domainVerificationToken: string;
      domainVerificationRecords: { name: string; type: "TXT"; value: string }[];
    }>
  >;
  /** Better Auth answers 204 with no body: `data` is null on success. */
  verifyDomain(input: { providerId: string }): Promise<CompatClientResult<null>>;
}

/** A call of `authClient.admin` that core does not serve: it answers NOT_SUPPORTED with a section 26 line. */
type AdminNotSupported = (input?: unknown) => Promise<CompatClientResult<never>>;

/** Better Auth 1.7.7's `authClient.admin` (dist/plugins/admin/client.mjs and routes.mjs, read 2026-10-21). */
export interface AdminClientCalls {
  listUsers(input?: { query?: AdminListUsersQuery }): Promise<CompatClientResult<AdminUserList>>;
  getUser(input: { query: { id: string } }): Promise<CompatClientResult<AdminUser>>;
  /** `banExpiresIn` is in seconds. */
  banUser(input: {
    userId: string;
    banReason?: string;
    banExpiresIn?: number;
  }): Promise<CompatClientResult<AdminActAnswer>>;
  unbanUser(input: { userId: string }): Promise<CompatClientResult<{ user: AdminUser }>>;
  /** The platform role grants it, and `user` revokes it. */
  setRole(input: {
    userId: string;
    role: string | string[];
  }): Promise<CompatClientResult<AdminActAnswer>>;
  /** One page per call: while sessions stay, `{ success: false, more: true, ended }`. */
  revokeUserSessions(input: {
    userId: string;
  }): Promise<
    CompatClientResult<{ success: true } | { success: false; more: true; ended: number }>
  >;
  impersonateUser(input: {
    userId: string;
  }): Promise<CompatClientResult<{ session: AdminSession; user: AdminUser }>>;
  stopImpersonating(): Promise<
    CompatClientResult<{ session: AdminSession | null; user: AdminUser | null }>
  >;
  /** Plan 12f2. `data` takes `name` and `image` only. It answers the user itself. */
  updateUser(input: {
    userId: string;
    data: { name?: string | null; image?: string | null };
  }): Promise<CompatClientResult<AdminUser>>;
  /** Plan 12f2. Core's operator delete. */
  removeUser(input: { userId: string }): Promise<CompatClientResult<{ success: true }>>;
  /** Plan 12f2. Core's operator create, with no mail and no password. It answers `{ user }`. */
  createUser(input: AdminCreateUserBody): Promise<CompatClientResult<{ user: AdminUser }>>;
  listUserSessions: AdminNotSupported;
  revokeUserSession: AdminNotSupported;
  setUserPassword: AdminNotSupported;
  hasPermission: AdminNotSupported;
  /**
   * Better Auth answers a boolean here, with no request. Core has no
   * permission statements, so this call throws: an answer could read as a grant.
   */
  checkRolePermission(input?: unknown): never;
}

export interface ReactAuthClient<TF extends boolean = false>
  extends Omit<AuthClient<TF>, "useSession"> {
  useSession(): SessionState & { refetch(): Promise<void> };
}
