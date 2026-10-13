import type { ClientCode } from "@tempo-auth/client";
import type { CompatClientError } from "./types.js";

/**
 * One Better Auth code per core and client code (Review Focus 5). The codes
 * are Better Auth 1.7.2's own names (@better-auth/core src/error/codes.ts,
 * better-auth dist/plugins/organization/error-codes.mjs, @better-auth/passkey
 * dist/index.mjs, read 2026-10-10) where one fits. The HTTP status stays
 * core's. `satisfies` fails the compile when core adds a code.
 */
export const BETTER_AUTH_CODES = {
  invalid_body: "VALIDATION_ERROR",
  invalid_token: "INVALID_TOKEN",
  token_expired: "TOKEN_EXPIRED",
  oauth_denied: "FAILED_TO_GET_USER_INFO",
  oauth_failed: "FAILED_TO_GET_USER_INFO",
  email_required: "USER_EMAIL_NOT_FOUND",
  passkey_failed: "AUTHENTICATION_FAILED",
  email_unverified: "EMAIL_NOT_VERIFIED",
  unauthorized: "UNAUTHORIZED",
  origin_not_trusted: "INVALID_ORIGIN",
  not_found: "NOT_FOUND",
  rate_limited: "TOO_MANY_REQUESTS",
  email_taken_unverified: "USER_ALREADY_EXISTS",
  forbidden_rank: "FORBIDDEN",
  slug_reserved: "ORGANIZATION_SLUG_ALREADY_TAKEN",
  slug_taken: "ORGANIZATION_SLUG_ALREADY_TAKEN",
  last_owner: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
  already_member: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
  email_mismatch: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
  conflict: "CONFLICT",
  invalid_credentials: "INVALID_EMAIL_OR_PASSWORD",
  password_policy: "INVALID_PASSWORD",
  password_breached: "PASSWORD_COMPROMISED",
  email_taken: "USER_ALREADY_EXISTS",
  // tempo-auth's own name: no Better Auth source is in this repo, so no Better
  // Auth code was checked. On the compat storage `tempo.api.tokens.create`
  // never answers `token_limit`: it throws `unknown_model` after it takes a
  // limiter slot, because the model is unmapped (spec 8.8 item 9). Only core's
  // api.tokens on its own storage can answer `token_limit`.
  token_limit: "TOKEN_LIMIT_REACHED",
  // Plan 9d. Better Auth 1.7.2's own names for its limits
  // (dist/plugins/organization/error-codes.mjs:5, :35, :40, read 2026-10-13).
  // Better Auth answers them 403; the status stays core's, 409.
  organization_limit: "YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS",
  member_limit: "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED",
  invitation_limit: "INVITATION_LIMIT_REACHED",
  // tempo-auth's own names: Better Auth has no code for a hook's refusal or failure.
  hook_refused: "HOOK_REFUSED",
  hook_failed: "HOOK_FAILED",
  network: "NETWORK_ERROR",
  unexpected: "UNEXPECTED_RESPONSE",
  cancelled: "AUTH_CANCELLED",
} as const satisfies { readonly [C in ClientCode]: string };

/**
 * The shim's own codes, with their status: the cases that no core or client
 * code names (plan 9 final review M-5). The server `api`, the client, and a
 * README test read this one table. The names are Better Auth 1.7.2's where
 * one exists. Status 0 means that no HTTP response exists: a client with no
 * base sends no request, and a server outage must not look the same.
 */
export const COMPAT_CODES = {
  INVALID_CALLBACK_URL: 403,
  INVALID_REDIRECT_URL: 403,
  NO_ACTIVE_ORGANIZATION: 400,
  INVITATION_NOT_FOUND: 404,
  NOT_SUPPORTED: 501,
  BASE_URL_REQUIRED: 0,
} as const;

export type CompatCode = keyof typeof COMPAT_CODES;

/** The code of a call that tempo-auth does not serve, with HTTP status 501. */
export const NOT_SUPPORTED = "NOT_SUPPORTED" satisfies CompatCode;

const STATUS_NAMES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR",
  501: "NOT_IMPLEMENTED",
};

const REASONS: Record<number, string> = {
  0: "",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
};

/** `INVALID_EMAIL_OR_PASSWORD` to "Invalid email or password". Apps switch on the code, not on this text. */
export function messageOf(code: string): string {
  const s = code.toLowerCase().replaceAll("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Core's fixed maximum, in code points (core `engine/password-policy.ts`
 * `PASSWORD_MAX_LENGTH`, read 2026-10-10). Core does not export it; the
 * check refuses any other `maxPasswordLength`, so the two cannot differ for
 * an app that starts.
 */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Core answers `password_policy` for every policy refusal. Better Auth names
 * the two length cases. `minLength` is the configured
 * `emailAndPassword.minPasswordLength` (Mapped.minPasswordLength), not a copy
 * of the default. The length is in code points, as core counts it.
 */
export function passwordPolicyCode(
  password: string,
  minLength: number,
): "PASSWORD_TOO_SHORT" | "PASSWORD_TOO_LONG" | "INVALID_PASSWORD" {
  const length = [...password].length;
  if (length < minLength) return "PASSWORD_TOO_SHORT";
  if (length > PASSWORD_MAX_LENGTH) return "PASSWORD_TOO_LONG";
  return "INVALID_PASSWORD";
}

/** Better Auth's server error (better-call's APIError): `status` is the name, `statusCode` the number, `body.code` the code. */
export class APIError extends Error {
  readonly status: string;
  readonly statusCode: number;
  readonly body: { code: string; message: string };
  constructor(statusCode: number, code: string, message: string = messageOf(code)) {
    super(message);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.status = STATUS_NAMES[statusCode] ?? "INTERNAL_SERVER_ERROR";
    this.body = { code, message };
  }
}

export function apiError(code: ClientCode, status: number): APIError {
  return new APIError(status, BETTER_AUTH_CODES[code]);
}

/** The server `APIError` of one of the shim's own codes, with the table's status. */
export function compatApiError(code: CompatCode, message?: string): APIError {
  return new APIError(COMPAT_CODES[code], code, message);
}

/** The client error of one of the shim's own codes, with the table's status. */
export function compatClientError(code: CompatCode, message?: string): CompatClientError {
  return clientError(code, COMPAT_CODES[code], message);
}

export function clientError(
  code: string,
  status: number,
  message: string = messageOf(code),
): CompatClientError {
  return { code, message, status, statusText: REASONS[status] ?? "" };
}
