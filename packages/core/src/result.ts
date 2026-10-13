import { ERRORS, type ErrorCode } from "./errors.js";

/**
 * `message` is set by `hook_refused` only (plan 9d): the app's refusal
 * text, already checked by `publicHookMessage`. `respond` writes it into the
 * JSON body.
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; status: number; message?: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ErrorCode): Result<T> {
  return { ok: false, code, status: ERRORS[code] };
}
