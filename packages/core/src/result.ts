import { ERRORS, type ErrorCode } from "./errors.js";

export type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; status: number };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ErrorCode): Result<T> {
  return { ok: false, code, status: ERRORS[code] };
}
