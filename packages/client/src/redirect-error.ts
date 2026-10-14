import { ERRORS, type ErrorCode } from "@authtempo/core/errors";
import { AUTH_ERROR_PARAM } from "@authtempo/core/routes";

/**
 * The error code of a URL that a browser flow failure landed on (plan 11d):
 * core sends every browser failure to `appURL/?auth_error=<code>`. A code
 * that core's table lacks answers `unexpected`; a URL with no code answers
 * null. A relative URL is read against a dummy origin.
 */
export function readRedirectError(url: string | URL): ErrorCode | "unexpected" | null {
  let u: URL;
  try {
    u = new URL(url, "https://app.invalid");
  } catch {
    return null;
  }
  const value = u.searchParams.get(AUTH_ERROR_PARAM);
  if (value === null) return null;
  return Object.hasOwn(ERRORS, value) ? (value as ErrorCode) : "unexpected";
}
