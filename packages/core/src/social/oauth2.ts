import type { OAuth2Provider, RedirectOverride, SocialProfile } from "./provider.js";

/**
 * An entry of `social.oauth2`: a provider that issues no ID token (plan 9c).
 * `userinfo` turns the access token into a profile. Call the provider with
 * the `fetch` it gets: core puts the timeout on that fetch. Core wraps it:
 * no redirect is followed. Answer `emailVerified: true` only when the
 * provider says that this person proved the address; core counts nothing
 * else as verified.
 */
export interface OAuth2Entry extends RedirectOverride {
  /** The route segment and the identity provider name. `^[a-z][a-z0-9-]{0,31}$`. */
  name: string;
  /** The sign-in page button text. 1 to 80 characters, no control character. */
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Extra authorize parameters. Core's own keys are refused. */
  authorizeParams?: Record<string, string>;
  userinfo(accessToken: string, fetch: typeof globalThis.fetch): Promise<SocialProfile>;
}

/** Builds the provider. `resolveConfig` has checked the entry. */
export function oauth2Provider(entry: OAuth2Entry): OAuth2Provider {
  return {
    kind: "oauth2",
    name: entry.name,
    label: entry.label,
    authorizeUrl: entry.authorizeUrl,
    tokenUrl: entry.tokenUrl,
    clientId: entry.clientId,
    scope: entry.scope,
    authorizeParams: { ...(entry.authorizeParams ?? {}) },
    callbackMethod: "GET",
    clientSecret: async () => entry.clientSecret,
    userinfo: entry.userinfo,
  };
}
