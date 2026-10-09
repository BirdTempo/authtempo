import type { ErrorCode } from "@tempo-auth/core/errors";

/**
 * The core error table, plus the three codes only a client can see:
 * `network` (the fetch rejected), `unexpected` (an answer the client cannot
 * read), `cancelled` (the person dismissed a prompt).
 */
export type ClientCode = ErrorCode | "network" | "unexpected" | "cancelled";

export interface ClientFailure {
  ok: false;
  code: ClientCode;
  /** The HTTP status, or 0 when no answer arrived. */
  status: number;
}

export type ClientResult<T> = { ok: true; value: T } | ClientFailure;

export function ok<T>(value: T): ClientResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ClientCode, status: number): ClientResult<T> {
  return { ok: false, code, status };
}
