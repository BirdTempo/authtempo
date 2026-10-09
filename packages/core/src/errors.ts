/** Every failure code with its HTTP status. A new code is a minor version. */
export const ERRORS = {
  invalid_body: 400,
  invalid_token: 400,
  token_expired: 400,
  oauth_denied: 400,
  oauth_failed: 400,
  email_required: 400,
  unauthorized: 401,
  origin_not_trusted: 403,
  not_found: 404,
  rate_limited: 429,
  email_taken_unverified: 409,
} as const;

export type ErrorCode = keyof typeof ERRORS;
