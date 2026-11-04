import { ERRORS, type ErrorCode } from "./errors.js";

/**
 * `message` is set by `hook_refused` only (plan 9d): the app's refusal
 * text, already checked by `publicHookMessage`. `detail` is set by
 * `sso_required` (plan 12d): the SSO start URL of the address, on the
 * origin of `baseURL`. The `conflict` of a sign-up confirm that lost its
 * flip sets it too (plan 12o): a sentence that says to sign in.
 * `respond` writes each into the JSON body.
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; status: number; message?: string; detail?: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ErrorCode): Result<T> {
  return { ok: false, code, status: ERRORS[code] };
}
