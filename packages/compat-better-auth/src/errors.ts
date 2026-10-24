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
  // Plan 11g. authtempo's own name: no Better Auth file names one (read
  // 2026-10-19). Better Auth 1.7.2's BASE_ERROR_CODES (@better-auth/core
  // dist/error/codes.mjs) has no code for an unhandled error; its routes throw
  // APIError("INTERNAL_SERVER_ERROR", ...), the status name of better-call.
  internal: "INTERNAL_ERROR",
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
  // Plan 12a. Better Auth 1.7.2's name for the same refusal (@better-auth/core
  // dist/error/codes.mjs:13, read 2026-10-17). Better Auth answers 409 CONFLICT
  // with it (better-auth dist/api/routes/account.mjs:208), as core does.
  identity_taken: "SOCIAL_ACCOUNT_ALREADY_LINKED",
  // Plan 12a. Better Auth 1.7.2 has no such refusal: its deleteUser deletes the
  // sessions, the accounts, and the user, and keeps the organizations
  // (better-auth dist/db/internal-adapter.mjs:233, read 2026-10-17). Core's own name.
  sole_owner: "SOLE_OWNER",
  // Plan 12f (ruling 18; Task 13 reviews these names). The names come from
  // Better Auth 1.7.7's admin plugin (better-auth dist/plugins/admin/error-codes.mjs
  // in consumera's pnpm store, read 2026-10-20). The statuses stay core's.
  account_banned: "BANNED_USER",
  // Better Auth names one refusal per admin action, such as
  // YOU_ARE_NOT_ALLOWED_TO_BAN_USERS. Core has one code for every action, so no name fits.
  operator_required: "FORBIDDEN",
  // YOU_CANNOT_BAN_YOURSELF names the ban only. Core refuses every act on the
  // operator's own account and on another platform operator, so no name fits.
  operator_self: "FORBIDDEN",
  // Core refuses the operator, a platform operator, a banned user, and an absent
  // user with one code. The admin target is the nearest case of Better Auth.
  impersonation_refused: "YOU_CANNOT_IMPERSONATE_ADMINS",
  // Better Auth lets an impersonation session reach every route, so it has no
  // name for this refusal.
  impersonation_session: "FORBIDDEN",
  // Plan 12k Task 10 (ruling 22). Better Auth 1.7.2's own names
  // (dist/plugins/organization/error-codes.mjs:57, :59, :61, and
  // routes/crud-access-control.mjs, read 2026-10-21). Better Auth answers
  // each 400; the status stays core's, 409.
  role_in_use: "ROLE_IS_ASSIGNED_TO_MEMBERS",
  role_limit: "TOO_MANY_ROLES",
  role_taken: "ROLE_NAME_IS_ALREADY_TAKEN",
  // Plan 12k Task 11. Better Auth 1.7.2's own names
  // (dist/plugins/organization/error-codes.mjs:32, :41, :33, read
  // 2026-10-21). Better Auth answers 400, 403, and 400; the status stays
  // core's, 409.
  team_limit: "YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_TEAMS",
  team_member_limit: "TEAM_MEMBER_LIMIT_REACHED",
  last_team: "UNABLE_TO_REMOVE_LAST_TEAM",
  // Plan 12k Task 7. authtempo's own names: no @better-auth/api-key source is in
  // this repo (read 2026-10-21). Task 12 of plan 12k reads the plugin's codes
  // and maps the shim's api-key answers to them.
  token_exhausted: "TOKEN_EXHAUSTED",
  token_retired: "TOKEN_RETIRED",
  // Plan 12k Task 8. authtempo's own name: Better Auth has no cap of organization tokens.
  organization_token_limit: "ORGANIZATION_TOKEN_LIMIT",
  // Plan 12h. A name of our own: Better Auth 1.7 has no readiness route.
  not_ready: "NOT_READY",
  // Plan 12d Task 2b. authtempo's own names until plan 12d Task 14 reads the
  // codes of @better-auth/sso. The status stays core's.
  domain_unverified: "DOMAIN_UNVERIFIED",
  domain_taken: "DOMAIN_TAKEN",
  domain_limit: "DOMAIN_LIMIT",
  // Plan 12d ruling 30. Better Auth's deleteUser has no such limit: core's own name.
  delete_too_large: "DELETE_TOO_LARGE",
  // Plan 12d Task 3. authtempo's own names until plan 12d Task 14 reads the
  // codes of @better-auth/sso. The status stays core's.
  connection_limit: "CONNECTION_LIMIT",
  second_factor_required: "SECOND_FACTOR_REQUIRED",
  // Plan 12d Task 4, by the same rule until Task 14.
  sso_failed: "SSO_FAILED",
  sso_not_configured: "SSO_NOT_CONFIGURED",
  // Plan 12d Task 5, by the same rule until Task 14.
  sso_required: "SSO_REQUIRED",
  sso_domain_mismatch: "SSO_DOMAIN_MISMATCH",
  sso_not_provisioned: "SSO_NOT_PROVISIONED",
  account_disabled: "ACCOUNT_DISABLED",
  role_not_found: "ROLE_NOT_FOUND",
  // Plan 12i deviation 10: @better-auth/passkey 1.7.2's name for a sign-in by a
  // credential with no row (dist/index.mjs:470, read 2026-10-22). The status stays core's.
  passkey_unknown: "PASSKEY_NOT_FOUND",
  // Plan 12i deviation 10: the names of Better Auth 1.7.2's username plugin
  // (plugins/username/error-codes.mjs). The status stays core's.
  username_taken: "USERNAME_IS_ALREADY_TAKEN",
  username_invalid: "INVALID_USERNAME",
  // Plan 12i deviation 10: Better Auth 1.7.2's phone-number plugin names a
  // number that it refuses INVALID_PHONE_NUMBER (plugins/phone-number
  // error-codes.mjs, read 2026-10-14). It has no region list, so a number
  // outside the regions gets the same name. It has no name for an SMS
  // outage: the shim answers SMS_UNAVAILABLE. The statuses stay core's.
  phone_invalid: "INVALID_PHONE_NUMBER",
  phone_region: "INVALID_PHONE_NUMBER",
  sms_unavailable: "SMS_UNAVAILABLE",
  // Plan 12i Task 18: Better Auth 1.7.2 throws at a host outside allowedHosts
  // and names no code. The shim answers HOST_NOT_ALLOWED. The status stays core's.
  host_not_allowed: "HOST_NOT_ALLOWED",
  // Plan 12i Task 5: the phone-number plugin's name for a number that another
  // user holds (plugins/phone-number/error-codes.mjs, read 2026-10-24).
  phone_taken: "PHONE_NUMBER_EXIST",
  // Plan 12i Task 6: an anonymous session at a route of ANONYMOUS_REFUSED, or
  // another session at the anonymous delete. Better Auth 1.7.2 refuses no
  // route to an anonymous user, and its USER_IS_NOT_ANONYMOUS names only the
  // delete case (dist/plugins/anonymous/error-codes.mjs, read 2026-10-24).
  // So the name is core's own. Task 16 maps the anonymous plugin.
  anonymous_refused: "ANONYMOUS_REFUSED",
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
  // Plan 12a. Better Auth 1.7.2's names and statuses (@better-auth/core
  // dist/error/codes.mjs:25, :46, :30, and :26, read 2026-10-17). Better Auth
  // answers each with 400 BAD_REQUEST (better-auth dist/api/routes/update-user.mjs
  // and account.mjs). Better Auth drops a field it does not know; the shim
  // refuses it with FIELD_NOT_ALLOWED, because core keeps name and image only.
  EMAIL_CAN_NOT_BE_UPDATED: 400,
  FIELD_NOT_ALLOWED: 400,
  ACCOUNT_NOT_FOUND: 400,
  CHANGE_EMAIL_DISABLED: 400,
  // Plan 12a. POST /get-session with deferSessionRefresh off (@better-auth/core
  // dist/error/codes.mjs:50 and better-auth dist/api/routes/session.mjs:37, read 2026-10-17).
  METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED: 405,
  // Plan 12a Task 19. @better-auth/passkey 1.7.2's name and status for an unknown
  // passkey id (dist/index.mjs:640, dist/version-D9KSwkEL.mjs:7, and better-auth
  // dist/api/middlewares/authorization.mjs:32, read 2026-10-17). Better Auth answers
  // 401 for another user's passkey; core answers that as an unknown id, with no oracle.
  PASSKEY_NOT_FOUND: 404,
} as const;

export type CompatCode = keyof typeof COMPAT_CODES;

/**
 * The codes of @better-auth/api-key 1.7.5 that the shim's api-key calls
 * answer, with Better Auth's status and text (plan 12k Task 12). They come
 * from dist/version-DPvml-_8.mjs and each throw of dist/index.mjs, read
 * 2026-10-21. `KEY_DISABLED` also answers a moved prefix with no row.
 */
export const API_KEY_CODES = {
  INVALID_API_KEY: { status: 401, message: "Invalid API key." },
  KEY_DISABLED: { status: 401, message: "API Key is disabled" },
  KEY_NOT_FOUND: { status: 404, message: "API Key not found" },
  USAGE_EXCEEDED: { status: 429, message: "API Key has reached its usage limit" },
  RATE_LIMITED: { status: 429, message: "Rate limit exceeded." },
  SERVER_ONLY_PROPERTY: {
    status: 400,
    message:
      "The property you're trying to set can only be set from the server auth instance only.",
  },
  UNAUTHORIZED_SESSION: { status: 401, message: "Unauthorized or invalid session" },
  ORGANIZATION_ID_REQUIRED: {
    status: 400,
    message: "Organization ID is required for organization-owned API keys.",
  },
  USER_NOT_MEMBER_OF_ORGANIZATION: {
    status: 403,
    message: "You are not a member of the organization that owns this API key.",
  },
  INSUFFICIENT_API_KEY_PERMISSIONS: {
    status: 403,
    message: "You do not have permission to perform this action on organization API keys.",
  },
  NAME_REQUIRED: { status: 400, message: "API Key name is required." },
  INVALID_NAME_LENGTH: {
    status: 400,
    message: "The name length is either too large or too small.",
  },
  METADATA_DISABLED: { status: 400, message: "Metadata is disabled." },
  INVALID_METADATA_TYPE: { status: 400, message: "metadata must be an object or undefined" },
  KEY_DISABLED_EXPIRATION: { status: 400, message: "Custom key expiration values are disabled." },
  EXPIRES_IN_IS_TOO_SMALL: {
    status: 400,
    message: "The expiresIn is smaller than the predefined minimum value.",
  },
  EXPIRES_IN_IS_TOO_LARGE: {
    status: 400,
    message: "The expiresIn is larger than the predefined maximum value.",
  },
  REFILL_AMOUNT_AND_INTERVAL_REQUIRED: {
    status: 400,
    message: "refillAmount is required when refillInterval is provided",
  },
  REFILL_INTERVAL_AND_AMOUNT_REQUIRED: {
    status: 400,
    message: "refillInterval is required when refillAmount is provided",
  },
  NO_VALUES_TO_UPDATE: { status: 400, message: "No values to update." },
} as const;

export type ApiKeyCode = keyof typeof API_KEY_CODES;

/**
 * The text of a moved prefix with no row (plan 12k Task 12). The shim cannot
 * tell the cause: a revoke, a skip at the move (disabled, expired, or no
 * digest), or an expiry after it. So the text names each cause (review
 * finding L3). Better Auth answered `KEY_EXPIRED` for an expired key.
 */
export const RETIRED_KEY_MESSAGE =
  "This key does not act: it was revoked, disabled, or expired, or it did not move. Create a new key.";

/** The server `APIError` of an api-key code, with Better Auth's status and text. */
export function apiKeyError(code: ApiKeyCode, message?: string): APIError {
  const c = API_KEY_CODES[code];
  return new APIError(c.status, code, message ?? c.message);
}

/** The code of a call that authtempo does not serve, with HTTP status 501. */
export const NOT_SUPPORTED = "NOT_SUPPORTED" satisfies CompatCode;

const STATUS_NAMES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
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
  405: "Method Not Allowed",
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
