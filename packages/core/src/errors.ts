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
} as const;

export type ErrorCode = keyof typeof ERRORS;
