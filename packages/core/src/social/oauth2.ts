import type {
  OAuth2Provider,
  RedirectOverride,
  SocialProfile,
  TokenRequestAnswer,
  TokenRequestInput,
} from "./provider.js";

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
  /** The token endpoint. With `tokenRequest`, the hook's fetch calls only this origin and path. */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Extra authorize parameters. Core's own keys are refused. */
  authorizeParams?: Record<string, string>;
  /**
   * The authorize parameter that carries `clientId`, such as TikTok's
   * `client_key` (plan 12i Task 22). Not a key that core writes, and not a
   * key of `authorizeParams`. Absent: `client_id`.
   */
  authorizeClientIdParam?: string;
  /** A fixed fragment after the authorize query, such as `#wechat_redirect`. */
  authorizeSuffix?: string;
  /**
   * False turns PKCE off, for a provider whose docs name no PKCE. Say why in
   * your docs. The state row and the binding cookie still bind the callback.
   */
  pkce?: boolean;
  /**
   * The provider proves no address. Core drops any address of the profile,
   * and finds or makes the user by the identity alone. Under
   * `signUp: "invited"` such an entry makes no user.
   */
  addressless?: true;
  /**
   * The token exchange, in place of the standard one (plan 12i Task 22).
   * Core runs it after the state and binding checks, with its own fetch. A
   * throw or an answer of the wrong shape is `oauth_failed`.
   */
  tokenRequest?(input: TokenRequestInput): Promise<TokenRequestAnswer>;
  /** The third argument is the `extra` of `tokenRequest`, else `{}`. */
  userinfo(
    accessToken: string,
    fetch: typeof globalThis.fetch,
    extra: Record<string, string>,
  ): Promise<SocialProfile>;
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
    ...(entry.tokenRequest ? { tokenRequest: entry.tokenRequest } : {}),
    ...(entry.authorizeClientIdParam !== undefined
      ? { authorizeClientIdParam: entry.authorizeClientIdParam }
      : {}),
    ...(entry.authorizeSuffix !== undefined ? { authorizeSuffix: entry.authorizeSuffix } : {}),
    ...(entry.pkce !== undefined ? { pkce: entry.pkce } : {}),
    ...(entry.addressless ? { addressless: true as const } : {}),
  };
}
