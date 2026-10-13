import type { ResolvedConfig, ResolvedOAuth } from "../config.js";
import { OAUTH_ERRORS, type OAuthErrorCode } from "../errors.js";

/** The result of a provider operation: an OAuth wire error, not a core code (plan 9g). */
export type OAuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OAuthErrorCode; status: number };

export function oauthOk<T>(value: T): OAuthResult<T> {
  return { ok: true, value };
}

export function oauthFail<T = never>(error: OAuthErrorCode): OAuthResult<T> {
  return { ok: false, error, status: OAUTH_ERRORS[error] };
}

/** The provider config. A route or a call that reaches here exists only while it is on. */
export function oauthOf(config: ResolvedConfig): ResolvedOAuth {
  if (!config.oauth) throw new Error("authtempo: oauth is off");
  return config.oauth;
}

/** The scopes core knows, with the consent page's text. An app adds its own in `oauth.scopes`. */
export const BUILT_IN_SCOPES: ReadonlyMap<string, string> = new Map([
  ["openid", "Confirm who you are"],
  ["profile", "See your name and picture"],
  ["email", "See your email address"],
  ["offline_access", "Stay connected after you close the app"],
]);

/** A scope token of RFC 6749 section 3.3 (printable ASCII less space, `"`, and `\`), at most 64 characters here. */
export const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/;
