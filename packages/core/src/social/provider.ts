import type { Observer } from "../observe/observer.js";
import type { JwtSeam } from "../seams/jwt.js";

/**
 * A provider name: a preset (`PRESET_PROVIDER_NAMES`) or the name of an
 * entry of `social.oidc` or `social.oauth2` (plan 9c). It is the route
 * segment and the `provider` of the identity row.
 */
export type SocialProviderName = string;

/** The name rule of a list entry. The name goes into a route path and an identity row. */
export const PROVIDER_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The presets that exist, in the order that the config builds them. The
 * compatibility package reads this list, so a preset added here changes its
 * refusal text with no compat edit.
 */
export const PRESET_PROVIDER_NAMES: readonly string[] = Object.freeze([
  "google",
  "apple",
  "github",
  "linkedin",
  "microsoft",
  "discord",
  "gitlab",
  "slack",
  "twitter",
  "facebook",
]);

/**
 * The names kept for presets that do not exist yet, so no list entry takes
 * one. Plan 12i Task 13 kept `slack`, `twitter`, and `facebook`. Task 14
 * moved them to `PRESET_PROVIDER_NAMES`, so the list is empty now. Both
 * lists are frozen: `RESERVED_PROVIDER_NAMES` and compat read them, so a
 * change at run time would open a reserved name.
 */
export const COMING_PRESET_NAMES: readonly string[] = Object.freeze([]);

/**
 * Names a list entry must not take: each preset, each coming preset, `email`,
 * and `credential`. `email` is core's identity for a verified address. The
 * engine finds an identity by `(provider, subject)`. So a list provider named
 * `email` could sign in as the owner of any address that its user info
 * answers as the subject. `credential` is the Better Auth password row, which
 * the compatibility package refuses as an identity (plan 9c).
 */
export const RESERVED_PROVIDER_NAMES: ReadonlySet<string> = new Set([
  ...PRESET_PROVIDER_NAMES,
  ...COMING_PRESET_NAMES,
  "email",
  "credential",
]);

/**
 * The authorize parameters that core writes. An entry's `authorizeParams`
 * go into the query last, so one of these keys would replace the state, the
 * nonce, or the PKCE challenge. Construction refuses them (plan 9c).
 */
export const CORE_AUTHORIZE_PARAMS: ReadonlySet<string> = new Set([
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
]);

/**
 * One limit for every call to a provider: the token exchange, the user
 * info step, and the discovery read. A provider that hangs must not hold
 * the request open. 10 s covers a slow token endpoint (plan 3).
 */
export const PROVIDER_TIMEOUT_MS = 10_000;

export interface SocialProfile {
  subject: string;
  /** Raw address from the provider; the engine normalizes it. Null when absent. */
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
  /**
   * True when `name` is the client's word, not a claim of the provider
   * (plan 12i Task 10): the name that Apple's native sheet gives the app.
   * Such a name fills a new user only, never an existing user.
   */
  nameOnCreate?: true;
}

/**
 * The ID-token route of a provider (plan 12i Task 10, spec 32 item 10).
 * `audiences` are the client ids beside `clientId` that a token may name,
 * such as an iOS bundle id or an Android client id. `nonceForm` is the
 * form of the `nonce` claim: the raw nonce, or the raw nonce or the
 * lowercase SHA-256 hex of it.
 */
export interface IdTokenRoute {
  audiences: readonly string[];
  nonceForm: "raw" | "raw-or-sha256";
}

export interface CallbackExtra {
  /** Apple's `user` form field, a JSON string, present on the first sign-in only. */
  user?: string | undefined;
}

export interface ProviderContext {
  jwt: JwtSeam;
  now: Date;
}

/**
 * One provider is its endpoints, its client secret rule, and its profile
 * rule. The engine owns the flow; a provider never redirects or stores.
 * Exported because exported interfaces extend it, and the declaration
 * build refuses a private base (TS4022).
 */
export interface ProviderBase {
  name: SocialProviderName;
  /** The sign-in page button text, for example "Continue with GitHub". */
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
  /** Extra authorize parameters, for example Apple's `response_mode`. */
  authorizeParams: Record<string, string>;
  callbackMethod: "GET" | "POST";
  clientSecret(ctx: ProviderContext): Promise<string>;
  /**
   * How the token exchange proves the client secret (plan 12i Task 14).
   * Absent: `client_secret_post`, the method of every preset before X.
   */
  tokenAuth?: TokenEndpointAuthMethod;
  /**
   * A check of the token answer before the engine reads its token (plan
   * 12i Task 14). False refuses the sign-in with `oauth_failed`. Slack
   * answers an error with status 200 and `ok: false`.
   */
  tokenAnswerOk?(body: Record<string, unknown>): boolean;
  /**
   * The callback URL that this provider has registered, in place of
   * `<baseURL><basePath>/social/<name>/callback` (plan 12i Task 12).
   * Construction checks it, and the router serves its path as an alias of
   * the callback. Absent: the default callback.
   */
  redirectURI?: string;
}

/**
 * The per-provider redirect override of each preset and list entry (plan
 * 12i Task 12, spec 32 item 11). An `https:` URL on the origin of `baseURL`,
 * with a path under `basePath`, no query, and no fragment. It must not be
 * the path of a route of core, nor of another provider. The provider must
 * have this exact URL registered.
 */
export interface RedirectOverride {
  redirectURI?: string;
}

/** The provider issues an ID token. The engine verifies it through the jwt seam and maps its claims. */
export interface OidcProvider extends ProviderBase {
  kind: "oidc";
  jwksUrl: string;
  /** Every issuer value the provider puts in `iss`. */
  issuer: string[];
  /**
   * The issuers of one token, from its payload before the verify, or null
   * to refuse it (plan 12i Task 13). Set by a provider whose issuer names
   * the person's own tenant. The engine then verifies against this list in
   * place of `issuer`, so `checkClaims` must bind it to a verified claim.
   */
  issuerOf?(idToken: string): string[] | null;
  /**
   * A last check of the verified claims (plan 12i Task 13). False refuses
   * the sign-in with `oauth_failed`, for example a token of another tenant.
   */
  checkClaims?(claims: Record<string, unknown>): boolean;
  profile(claims: Record<string, unknown>, extra: CallbackExtra): SocialProfile;
  /** Set on `google` and `apple` only: the provider serves the ID-token route (plan 12i Task 10). */
  idToken?: IdTokenRoute;
}

/**
 * The input of a `tokenRequest` hook (plan 12i Task 22). `fetch` is the
 * engine's fetch: it carries the timeout, follows no redirect, and calls
 * only the origin and path of the entry's `tokenUrl`. `codeVerifier` is
 * null when the entry sets `pkce: false`.
 */
export interface TokenRequestInput {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string | null;
  fetch: typeof globalThis.fetch;
}

/**
 * The answer of a `tokenRequest` hook. The engine checks its shape and
 * gives `extra` to `userinfo` as its third argument. `extra` holds at most
 * `TOKEN_EXTRA_MAX` string values, such as WeChat's `openid`.
 */
export interface TokenRequestAnswer {
  accessToken: string;
  extra: Record<string, string>;
}

/** The longest access token of a `tokenRequest` answer. */
export const TOKEN_REQUEST_ACCESS_MAX = 4096;
/** The most keys of `extra`, and the longest value of one key. */
export const TOKEN_EXTRA_MAX = 16;
export const TOKEN_EXTRA_VALUE_MAX = 1024;
/** The rule of an `extra` key. */
export const TOKEN_EXTRA_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * The provider issues no ID token (plan 9c). After the code exchange the
 * engine calls `userinfo` with the access token and a fetch that carries
 * the timeout. The engine reads the answer as untrusted. The third
 * argument is the `extra` of `tokenRequest`, else `{}` (plan 12i Task 22).
 */
export interface OAuth2Provider extends ProviderBase {
  kind: "oauth2";
  userinfo(
    accessToken: string,
    fetch: typeof globalThis.fetch,
    extra: Record<string, string>,
  ): Promise<SocialProfile>;
  /**
   * App code that runs in place of the standard token exchange (plan 12i
   * Task 22). It runs only after the engine has spent the state row and
   * checked the binding cookie. It answers a token or throws, and a throw
   * is `oauth_failed`. It cannot open a session or pick a user.
   */
  tokenRequest?(input: TokenRequestInput): Promise<TokenRequestAnswer>;
  /** The authorize parameter that carries `clientId`. Absent: `client_id`. */
  authorizeClientIdParam?: string;
  /** A fixed fragment after the authorize query, such as `#wechat_redirect`. */
  authorizeSuffix?: string;
  /**
   * False: no `code_challenge` at the start and no `code_verifier` at the
   * exchange. The state row and the binding cookie still bind the callback
   * (spec 8.3). Absent: PKCE with S256.
   */
  pkce?: boolean;
  /**
   * The provider proves no address. The engine drops any address of the
   * profile, and finds or makes the user by the identity alone.
   */
  addressless?: true;
}

export type Provider = OidcProvider | OAuth2Provider;

/**
 * An `oidc` list entry with no `endpoints` (plan 9c). The engine calls
 * `resolve` on each start and callback. It reads the issuer's discovery
 * document on the first call and keeps the provider for the life of the
 * `createAuth` instance. A failure is not kept, so the next call reads again.
 */
export interface OidcDiscovery extends Omit<ProviderBase, "authorizeUrl" | "tokenUrl"> {
  kind: "oidc-discovery";
  resolve(fetch: typeof globalThis.fetch, observe: Observer): Promise<OidcProvider | null>;
}

/** What the config holds for one provider. */
export type ConfiguredProvider = Provider | OidcDiscovery;

/**
 * How a client proves its secret at the token endpoint (RFC 6749 section
 * 2.3.1, OIDC Core section 9): in the form body, or as HTTP Basic.
 */
export type TokenEndpointAuthMethod = "client_secret_post" | "client_secret_basic";

/**
 * The `Authorization` value of `client_secret_basic`. RFC 6749 section
 * 2.3.1 form-encodes the id and the secret first, so a colon or a space
 * in either one stays inside its half. The result is ASCII, so `btoa`
 * takes it.
 */
export function basicAuthorization(clientId: string, clientSecret: string): string {
  const form = (v: string) => new URLSearchParams([["", v]]).toString().slice(1);
  return `Basic ${btoa(`${form(clientId)}:${form(clientSecret)}`)}`;
}

/**
 * A query string with `%20` for a space. `URLSearchParams` writes `+`, and
 * Apple rejects `+` inside `scope` (field reports, checked 2026-10-09).
 */
export function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const v = claims[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** True for an absolute URL whose scheme is `https:`. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
