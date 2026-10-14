/** Every failure code with its HTTP status. A new code is a minor version. */
export const ERRORS = {
  invalid_body: 400,
  invalid_token: 400,
  token_expired: 400,
  oauth_denied: 400,
  oauth_failed: 400,
  email_required: 400,
  passkey_failed: 400,
  email_unverified: 403,
  unauthorized: 401,
  origin_not_trusted: 403,
  not_found: 404,
  rate_limited: 429,
  email_taken_unverified: 409,
  // plan 6: organizations
  forbidden_rank: 403,
  slug_reserved: 400,
  slug_taken: 409,
  last_owner: 409,
  already_member: 409,
  email_mismatch: 403,
  // plan 6: a concurrent write changed the row; the caller retries
  conflict: 409,
  // plan 8: passwords
  invalid_credentials: 401,
  password_policy: 400,
  password_breached: 400,
  email_taken: 409,
  // plan 8b: a user holds API_TOKEN_CAP tokens
  token_limit: 409,
  // plan 9d: a before hook refused (with a message) or threw
  hook_refused: 403,
  hook_failed: 500,
  // plan 9d: organizations.limits
  organization_limit: 409,
  member_limit: 409,
  invitation_limit: 409,
  // plan 9e: email codes. A wrong, expired, spent, or unknown code is one code: no probe.
  invalid_code: 400,
  too_many_attempts: 400,
  // plan 9f: the TOTP second factor
  totp_enabled: 409,
  totp_not_enabled: 400,
  // plan 12c: the last passkey of a user whose passkey is a second-factor
  // method stays; the person turns the method off first.
  second_factor_last_method: 409,
  // plan 12b: the sign-up rule refused a new user
  sign_up_closed: 403,
  // plan 12b: the captcha port
  captcha_required: 400,
  captcha_failed: 403,
  captcha_unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERRORS;

/**
 * The OAuth 2.1 and OIDC wire errors of the provider routes (plan 9g), with
 * their status. A key is the string an OAuth client reads, so no map stands
 * between them. RFC 6749 sections 4.1.2.1 and 5.2, RFC 7591 section 3.2.2,
 * RFC 8707 section 2, RFC 6750 section 3.1, and OIDC Core 1.0 section
 * 3.1.2.6 (not re-read on 2026-10-13). `rate_limited` is core's own name.
 * A provider route never answers a code of `ERRORS`, and `ERRORS` gains none,
 * so the client codes and the compatibility table do not change.
 */
export const OAUTH_ERRORS = {
  invalid_request: 400,
  invalid_client: 401,
  // RFC 7009 section 2.1: a revoke of a token that was not issued to the
  // client is refused. Section 2.2.1 takes the codes of RFC 6749 section 5.2
  // and names none for this case; the owner chose unauthorized_client
  // (plan 9h, decision 1a of 2026-10-14). RFC 6749 section 5.2: 400.
  unauthorized_client: 400,
  invalid_grant: 400,
  unsupported_grant_type: 400,
  invalid_scope: 400,
  invalid_target: 400,
  unsupported_response_type: 400,
  access_denied: 400,
  login_required: 400,
  consent_required: 400,
  invalid_redirect_uri: 400,
  invalid_client_metadata: 400,
  // RFC 6750: the bearer of the userinfo endpoint. Not ERRORS.invalid_token (400), which is a mailed link.
  invalid_token: 401,
  insufficient_scope: 403,
  rate_limited: 429,
} as const;

export type OAuthErrorCode = keyof typeof OAUTH_ERRORS;
