import { ERRORS, type ErrorCode, OAUTH_ERRORS, type OAuthErrorCode } from "@authtempo/core/errors";
import { AUTH_ERROR_PARAM } from "@authtempo/core/routes";

/**
 * The error code of a URL that a browser flow failure landed on (plan 11d):
 * core sends every browser failure to `appURL/?auth_error=<code>`. The code
 * is of core's `ERRORS` or, from the OAuth sign-in route, of `OAUTH_ERRORS`. A
 * code that neither table has answers `unexpected`; a URL with no code answers
 * null. A relative URL is read against a dummy origin.
 */
export function readRedirectError(
  url: string | URL,
): ErrorCode | OAuthErrorCode | "unexpected" | null {
  let u: URL;
  try {
    u = new URL(url, "https://app.invalid");
  } catch {
    return null;
  }
  const value = u.searchParams.get(AUTH_ERROR_PARAM);
  if (value === null) return null;
  if (Object.hasOwn(ERRORS, value)) return value as ErrorCode;
  return Object.hasOwn(OAUTH_ERRORS, value) ? (value as OAuthErrorCode) : "unexpected";
}
