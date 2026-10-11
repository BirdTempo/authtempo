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
  status: "pending" | "canceled";
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

export interface OrganizationOptions {
  allowUserToCreateOrganization?: boolean | ((user: User) => boolean | Promise<boolean>);
  organizationLimit?: number | ((user: User) => boolean | Promise<boolean>);
  membershipLimit?: number;
  creatorRole?: string;
  invitationExpiresIn?: number;
  requireEmailVerificationOnInvitation?: boolean;
  cancelPendingInvitationsOnReInvite?: boolean;
  sendInvitationEmail?: (data: InvitationEmailData, request?: Request) => Promise<void> | void;
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
export type BearerPlugin = Marker<"bearer", BearerOptions>;
export type ExpoPlugin = Marker<"expo", ExpoOptions>;
export type CompatPlugin =
  | OrganizationPlugin
  | PasskeyPlugin
  | MagicLinkPlugin
  | BearerPlugin
  | ExpoPlugin;

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
   * The one key that is not Better Auth's. `passwordHash` replaces
   * `betterAuthPasswordHash()`, for example with a low cost in tests.
   * `appURL` is the origin the browser lands on after a sign-in (core's
   * `appURL`); default the origin of `baseURL`; it must be in
   * `trustedOrigins`. An absolute `callbackURL` or `redirectTo` must have
   * this origin, because core lands every sign-in on it.
   */
  tempoAuth?: { passwordHash?: PasswordHashSeam; appURL?: string };
}

export interface CompatServerApi {
  getSession(input: { headers: Headers }): Promise<{ session: Session; user: User } | null>;
  /** `image` and `callbackURL` throw `APIError` NOT_SUPPORTED (501): core keeps neither. */
  signUpEmail(input: {
    body: { email: string; password: string; name: string; image?: string; callbackURL?: string };
    headers?: Headers;
  }): Promise<{ token: string; user: User }>;
  /** `callbackURL` and `rememberMe: false` throw `APIError` NOT_SUPPORTED (501): core keeps neither. */
  signInEmail(input: {
    body: { email: string; password: string; callbackURL?: string; rememberMe?: boolean };
    headers?: Headers;
  }): Promise<{ redirect: false; token: string; url: undefined; user: User }>;
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
  api: CompatServerApi;
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
      readonly id: "organization" | "passkey" | "magic-link";
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
  /** The Better Auth 1.6 name of `requestPasswordReset`. */
  forgetPassword(input: {
    email: string;
    redirectTo?: string;
  }): Promise<CompatClientResult<{ status: true }>>;
  resetPassword(input: {
    newPassword: string;
    token: string;
  }): Promise<CompatClientResult<{ status: true }>>;
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
