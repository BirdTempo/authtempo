import type { JwtSeam } from "../seams/jwt.js";

/**
 * A provider name: a preset (`google`, `apple`, `github`, `linkedin`) or the
 * name of an entry of `social.oidc` or `social.oauth2` (plan 9c). It is the
 * route segment and the `provider` of the identity row.
 */
export type SocialProviderName = string;

/** The name rule of a list entry. The name goes into a route path and an identity row. */
export const PROVIDER_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Names a list entry must not take. The presets own the first four. `email`
 * is core's identity for a verified address: the engine finds an identity by
 * `(provider, subject)`, so a list provider named `email` could sign in as
 * the owner of any address that its user info answers as the subject.
 * `credential` is the Better Auth password row, which the compatibility
 * package refuses as an identity (plan 9c).
 */
export const RESERVED_PROVIDER_NAMES: ReadonlySet<string> = new Set([
  "google",
  "apple",
  "github",
  "linkedin",
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
}

/** The provider issues an ID token. The engine verifies it through the jwt seam and maps its claims. */
export interface OidcProvider extends ProviderBase {
  kind: "oidc";
  jwksUrl: string;
  /** Every issuer value the provider puts in `iss`. */
  issuer: string[];
  profile(claims: Record<string, unknown>, extra: CallbackExtra): SocialProfile;
}

/**
 * The provider issues no ID token (plan 9c). After the code exchange the
 * engine calls `userinfo` with the access token and a fetch that carries
 * the timeout. The engine reads the answer as untrusted.
 */
export interface OAuth2Provider extends ProviderBase {
  kind: "oauth2";
  userinfo(accessToken: string, fetch: typeof globalThis.fetch): Promise<SocialProfile>;
}

export type Provider = OidcProvider | OAuth2Provider;

/** What the config holds for one provider. */
export type ConfiguredProvider = Provider;

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
