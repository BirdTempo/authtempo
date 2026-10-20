import type { BrowserWebAuthn } from "@authtempo/client";
import type { Auth, LimiterPort, PasswordHashSeam, StorageAdapter } from "@authtempo/core";
import type { ExpoCryptoLike, ExpoWebBrowserLike } from "@authtempo/handoff/expo";

// Shapes copied from Better Auth 1.7.2 (@better-auth/core src/db/schema/*.ts and
// better-auth dist/client/react/index.d.mts), read on 2026-10-10. Only the fields
// that authtempo can fill are here. The converters in src/server/shapes.ts and
// src/client/create-auth-client.ts build object literals under these types, so a
// field added here and not filled there fails the compile (Review Focus 4).

/** Better Auth's user as the server answers it. `name` is "" when core holds no name. */
export interface User {
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

/** What `drizzleAdapter` and `betterAuthSchemaStorage` answer. `betterAuth` refuses any other `database`. */
export interface CompatDatabase {
  readonly kind: "authtempo-compat-database";
  readonly dialect: "postgres" | "d1";
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
 * row. The team hooks, `beforeCancelInvitation`, and `beforeRejectInvitation`
 * are not here, so a literal that names one fails the compile; the start
 * check refuses them by name.
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
}

export interface PasskeyOptions {
  rpID?: string;
  rpName?: string;
  origin?: string | string[] | null;
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
export type CompatPlugin =
  | AdminPlugin
  | OrganizationPlugin
  | PasskeyPlugin
  | MagicLinkPlugin
  | EmailOtpPlugin
  | BearerPlugin
  | ExpoPlugin
  | TwoFactorPlugin;

/** A plugin from a package this one does not replace, for example `@better-auth/api-key`. The check refuses it by id. */
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
export interface BetterAuthOptions {
  appName?: string;
  baseURL?: string;
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
    google?: { clientId: string; clientSecret: string } & ProviderSignUp;
    apple?: {
      clientId: string;
      teamId?: string;
      keyId?: string;
      privateKey?: string;
      clientSecret?: string;
    } & ProviderSignUp;
    /** Core's GitHub preset (plan 9c). */
    github?: { clientId: string; clientSecret: string } & ProviderSignUp;
    /** Core's LinkedIn preset (plan 9c). */
    linkedin?: { clientId: string; clientSecret: string } & ProviderSignUp;
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
  authtempo?: { passwordHash?: PasswordHashSeam; appURL?: string; platformOrganization?: string };
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
   * plugin (plan 12f).
   */
  getSession(input: { headers: Headers }): Promise<{
    session: Session;
    user: User & { twoFactorEnabled?: boolean } & Partial<Omit<AdminUser, keyof User>>;
    /** With `session.deferSessionRefresh` on only (plan 12a): the refresh is due. */
    needsRefresh?: boolean;
  } | null>;
  /**
   * `image` and `callbackURL` throw `APIError` NOT_SUPPORTED (501): core keeps neither.
   * `token` is null with `emailAndPassword.requireEmailVerification` (plan 12b): no session opens.
   */
  signUpEmail(input: {
    body: { email: string; password: string; name: string; image?: string; callbackURL?: string };
    headers?: Headers;
  }): Promise<{ token: SignUpTokenOf[`${RV}`]; user: User }>;
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
}

export interface BetterAuthInstance<O extends BetterAuthOptions = BetterAuthOptions> {
  handler(request: Request): Promise<Response>;
  api: CompatServerApi<HasTwoFactor<O>, RequiresVerification<O>>;
  /** Type-only, as in Better Auth: `Auth["$Infer"]["Session"]["user"]`. The runtime value is an empty object. */
  $Infer: { Session: { session: Session; user: User } };
  options: O;
  /** The engine under the shim, for `tempo.api.sweepExpired()` in a scheduled handler. */
  tempo: Auth;
}

// The client.

export interface ClientUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
}

export interface ClientSession {
  id: string;
  userId: string;
  expiresAt: Date;
  activeOrganizationId: string | null;
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

export type ClientPlugin =
  | {
      readonly kind: typeof COMPAT_CLIENT_PLUGIN;
      readonly id: "organization" | "passkey" | "magic-link" | "email-otp";
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
  data: { session: ClientSession; user: ClientUser } | null;
  error: CompatClientError | null;
  isPending: boolean;
  isRefetching: boolean;
}

export interface SessionStore {
  get(): SessionState;
  subscribe(listener: () => void): () => void;
  refetch(): Promise<void>;
}

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
    }): Promise<CompatClientResult<{ url: string; redirect: boolean }>>;
    magicLink(input: {
      email: string;
      callbackURL?: string;
      name?: string;
    }): Promise<CompatClientResult<{ status: true }>>;
    passkey(input?: {
      autoFill?: boolean;
    }): Promise<CompatClientResult<{ session: ClientSession; user: ClientUser }>>;
    /** Core's sign-in by email code (plan 9e). `name`, `image`, and other user fields answer NOT_SUPPORTED. */
    emailOtp(input: {
      email: string;
      otp: string;
      name?: string;
      image?: string;
    }): Promise<CompatClientResult<{ token: string; user: ClientUser }>>;
  };
  signUp: {
    email(input: {
      email: string;
      password: string;
      name: string;
      image?: string;
      callbackURL?: string;
      // null while the server's requireEmailVerification is on (plan 12b): no session opens.
    }): Promise<CompatClientResult<{ token: string | null; user: ClientUser }>>;
  };
  signOut(): Promise<CompatClientResult<{ success: true }>>;
  getSession(): Promise<CompatClientResult<{ session: ClientSession; user: ClientUser } | null>>;
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
  useSession: SessionStore;
  /** Expo only: the stored session as one cookie header value, `__Host-tempo_session=<token>`, or "" when none. */
  getCookie(): string;
  $Infer: { Session: { session: ClientSession; user: ClientUser } };
}

export interface ReactAuthClient<TF extends boolean = false>
  extends Omit<AuthClient<TF>, "useSession"> {
  useSession(): SessionState & { refetch(): Promise<void> };
}
