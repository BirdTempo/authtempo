import type { BrowserWebAuthn } from "@tempo-auth/client";
import type { Auth, LimiterPort, PasswordHashSeam, StorageAdapter } from "@tempo-auth/core";
import type { ExpoCryptoLike, ExpoWebBrowserLike } from "@tempo-auth/handoff/expo";

// Shapes copied from Better Auth 1.7.2 (@better-auth/core src/db/schema/*.ts and
// better-auth dist/client/react/index.d.mts), read on 2026-10-10. Only the fields
// that tempo-auth can fill are here. The converters in src/server/shapes.ts and
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
  readonly kind: "tempo-auth-compat-database";
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

export const COMPAT_PLUGIN = "tempo-auth-compat-plugin";

/** A Better Auth hook may answer a value or a promise. */
type HookResult<T> = T | Promise<T>;

/** A before hook's answer: nothing, or Better Auth's `{ data }`. A hook with no return statement returns void. */
// biome-ignore lint/suspicious/noConfusingVoidType: with undefined, a hook with no return statement does not type-check.
type BeforeHookAnswer = void | { data: object };

/**
 * `organization({ organizationHooks })` (plan 9d): Better Auth 1.7.2's names
 * and argument shapes (dist/plugins/organization/types.d.mts:296-690, read
 * 2026-10-13), with the fields tempo-auth fills. A before hook may return
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

/** The types of Better Auth 1.7.2's `sendVerificationOTP` (dist/plugins/email-otp/types.d.mts, read 2026-10-13). Core sends `sign-in` and `forget-password` only. */
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
  changeEmail?: unknown;
  rateLimit?: unknown;
}

/**
 * Better Auth 1.7.2's two-factor options (dist/plugins/two-factor/types.d.mts,
 * totp/index.d.mts, backup-codes/index.d.mts, read 2026-10-13). Plan 9f maps
 * `issuer`, `backupCodeOptions.amount` and `length`, and `trustDeviceMaxAge`;
 * `totpOptions.digits` 6 and `period` 30 and `accountLockout: { enabled: false }`
 * are accepted; the check refuses every other key by name.
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

export interface BearerOptions {
  requireSignature?: boolean;
}

/** `expo()` takes no option that tempo-auth maps. */
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
export type CompatPlugin =
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
 * Better Auth 1.7's option object, with the keys tempo-auth maps. Since plan
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
    autoSignInAfterVerification?: boolean;
    expiresIn?: number;
  };
  socialProviders?: {
    google?: { clientId: string; clientSecret: string };
    apple?: {
      clientId: string;
      teamId?: string;
      keyId?: string;
      privateKey?: string;
      clientSecret?: string;
    };
    /** Core's GitHub preset (plan 9c). */
    github?: { clientId: string; clientSecret: string };
    /** Core's LinkedIn preset (plan 9c). */
    linkedin?: { clientId: string; clientSecret: string };
  };
  session?: {
    expiresIn?: number;
    updateAge?: number;
    cookieCache?: { enabled?: boolean; maxAge?: number };
    storeSessionInDatabase?: boolean;
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
   * Plan 9d: `session.create.before` and `session.create.after` only
   * (@better-auth/core 1.7.2 dist/types/init-options.d.mts, the databaseHooks
   * type, read 2026-10-13). `before` may answer `{ data }` with `ipAddress`,
   * `userAgent`, or `activeOrganizationId` changed, or `false` to refuse.
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
  };
  /**
   * The one key that is not Better Auth's. `passwordHash` replaces
   * `betterAuthPasswordHash()`, for example with a low cost in tests.
   * `appURL` is the origin the browser lands on after a sign-in (core's
   * `appURL`); default the origin of `baseURL`; it must be in
   * `trustedOrigins`. An absolute `callbackURL` or `redirectTo` must have
   * this origin, because core lands every sign-in on it.
   */
  tempoAuth?: { passwordHash?: PasswordHashSeam; appURL?: string };
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

export interface CompatServerApi<TF extends boolean = false> {
  /** `user.twoFactorEnabled` is set with the two-factor plugin (plan 9f). */
  getSession(input: {
    headers: Headers;
  }): Promise<{ session: Session; user: User & { twoFactorEnabled?: boolean } } | null>;
  /** `image` and `callbackURL` throw `APIError` NOT_SUPPORTED (501): core keeps neither. */
  signUpEmail(input: {
    body: { email: string; password: string; name: string; image?: string; callbackURL?: string };
    headers?: Headers;
  }): Promise<{ token: string; user: User }>;
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
}

export interface BetterAuthInstance<O extends BetterAuthOptions = BetterAuthOptions> {
  handler(request: Request): Promise<Response>;
  api: CompatServerApi<HasTwoFactor<O>>;
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

export const COMPAT_CLIENT_PLUGIN = "tempo-auth-compat-client-plugin";

export type ClientPlugin =
  | {
      readonly kind: typeof COMPAT_CLIENT_PLUGIN;
      readonly id: "organization" | "passkey" | "magic-link" | "email-otp";
    }
  | {
      readonly kind: typeof COMPAT_CLIENT_PLUGIN;
      readonly id: "expo";
      readonly options: ExpoClientOptions;
    };

export interface ClientOptions {
  baseURL?: string | undefined;
  basePath?: string;
  fetchOptions?: ClientFetchOptions;
  plugins?: readonly ClientPlugin[];
  /** The one key that is not Better Auth's. `webauthn` replaces the browser's WebAuthn, for example with a soft authenticator in tests. */
  tempoAuth?: { webauthn?: BrowserWebAuthn };
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

export interface AuthClient {
  signIn: {
    email(input: {
      email: string;
      password: string;
      callbackURL?: string;
      rememberMe?: boolean;
    }): Promise<
      CompatClientResult<{ redirect: boolean; token: string; url?: string; user: ClientUser }>
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
    }): Promise<CompatClientResult<{ token: string; user: ClientUser }>>;
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
  };
  /** In `./client` a store. `./react` replaces it with the hook. */
  useSession: SessionStore;
  /** Expo only: the stored session as one cookie header value, `tempo_session=<token>`, or "" when none. */
  getCookie(): string;
  $Infer: { Session: { session: ClientSession; user: ClientUser } };
}

export interface ReactAuthClient extends Omit<AuthClient, "useSession"> {
  useSession(): SessionState & { refetch(): Promise<void> };
}
