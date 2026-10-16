import type { ClientCode } from "@authtempo/client";
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
  // authtempo's own name: no Better Auth source is in this repo, so no Better
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
  // authtempo's own names: Better Auth has no code for a hook's refusal or failure.
  hook_refused: "HOOK_REFUSED",
  hook_failed: "HOOK_FAILED",
  // Plan 9e. Better Auth 1.7.2's own names (dist/plugins/email-otp/error-codes.mjs:4-8, read
  // 2026-10-13). Core answers an expired code invalid_code, so OTP_EXPIRED never appears.
  // Better Auth answers TOO_MANY_ATTEMPTS 403; the status stays core's, 400.
  invalid_code: "INVALID_OTP",
  too_many_attempts: "TOO_MANY_ATTEMPTS",
  // Plan 9f. TOTP_NOT_ENABLED is Better Auth 1.7.2's own name
  // (dist/plugins/two-factor/error-code.mjs, read 2026-10-13). Better Auth has
  // no code for a factor that is on already: its enable replaces the secret.
  // TOTP_ALREADY_ENABLED is authtempo's own name.
  totp_enabled: "TOTP_ALREADY_ENABLED",
  totp_not_enabled: "TOTP_NOT_ENABLED",
  // Plan 12c. Better Auth has no passkey second factor, so the name is authtempo's own.
  second_factor_last_method: "SECOND_FACTOR_LAST_METHOD",
  // Plan 12b, the sign-up rule. The name is authtempo's own. Better Auth 1.7.2
  // has no one code for a closed sign-up; it answers four (read 2026-10-15):
  // the password sign-up EMAIL_PASSWORD_SIGN_UP_DISABLED 400
  // (dist/api/routes/sign-up.mjs:147), the magic link a redirect with
  // error=new_user_signup_disabled (dist/plugins/magic-link/index.mjs:176),
  // social "signup disabled" (dist/oauth2/link-account.mjs:202), and the
  // email code INVALID_OTP (dist/plugins/email-otp/routes.mjs:413).
  sign_up_closed: "SIGN_UP_CLOSED",
  // Plan 12b, the captcha port. The names are Better Auth 1.7.2's captcha
  // plugin codes (dist/plugins/captcha/error-codes.mjs, read 2026-10-15):
  // MISSING_RESPONSE, VERIFICATION_FAILED, and UNKNOWN_ERROR, its external
  // code for a service that gives no answer. The plugin answers 400 for the
  // refusals (index.mjs:35) and 500 for the rest (index.mjs:71); the shim
  // keeps core's statuses (400, 403, 503).
  captcha_required: "MISSING_RESPONSE",
  captcha_failed: "VERIFICATION_FAILED",
  captcha_unavailable: "UNKNOWN_ERROR",
  // Plan 12b, the breach check. The name is authtempo's own. Better Auth
  // 1.7.2's haveIBeenPwned plugin has one code, PASSWORD_COMPROMISED
  // (dist/plugins/haveibeenpwned/index.mjs:9, read 2026-10-15). When the
  // range API gives no answer, it answers 500 with no code (:20, :27).
  breach_check_unavailable: "BREACH_CHECK_UNAVAILABLE",
  // Plan 12a. Better Auth 1.7.2's own name (@better-auth/core dist/error/codes.mjs:36, read
  // 2026-10-14). Better Auth answers 403 on a list and SESSION_EXPIRED 400 on a delete; the
  // status stays core's, 403, on every route.
  session_not_fresh: "SESSION_NOT_FRESH",
  // Plan 12a. Better Auth 1.7.2's name for the same refusal (@better-auth/core
  // dist/error/codes.mjs:29, read 2026-10-17). Better Auth answers 400 BAD_REQUEST
  // with it; the status stays core's, 409.
  last_credential: "FAILED_TO_UNLINK_LAST_ACCOUNT",
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

/** The code of a call that authtempo does not serve, with HTTP status 501. */
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

const STATUS_CODES: Record<string, number> = Object.fromEntries(
  Object.entries(STATUS_NAMES).map(([code, name]) => [name, Number(code)]),
);

/** The body of Better Auth's form (better-call 1.4.0, dist/error.mjs:102, read 2026-10-13). */
export interface APIErrorBody {
  message?: string;
  code?: string;
}

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

/**
 * Better Auth's server error (better-call's APIError): `status` is the name,
 * `statusCode` the number, `body.code` the code. Two forms: this package's
 * own, `new APIError(403, "FORBIDDEN", message?)`, and Better Auth's, which
 * an app's hook throws, `new APIError("FORBIDDEN", { message })` (plan 9d).
 * A status name this table does not know reads as 500.
 */
export class APIError extends Error {
  readonly status: string;
  readonly statusCode: number;
  readonly body: { code: string; message: string };
  constructor(status: number | string, codeOrBody?: string | APIErrorBody, message?: string) {
    const statusCode = typeof status === "number" ? status : (STATUS_CODES[status] ?? 500);
    const statusName = STATUS_NAMES[statusCode] ?? "INTERNAL_SERVER_ERROR";
    const code = typeof codeOrBody === "string" ? codeOrBody : (codeOrBody?.code ?? statusName);
    const text =
      (typeof codeOrBody === "string" ? message : codeOrBody?.message) ?? messageOf(code);
    super(text);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.status = statusName;
    this.body = { code, message: text };
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
