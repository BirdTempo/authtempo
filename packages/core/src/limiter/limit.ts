import type { ResolvedConfig } from "../config.js";
import type { LimitWindow } from "./port.js";

/**
 * Every limit of core (plan 12h). The limits page lists exactly these, and
 * check-limits holds it. A key is <family>:<subject>. An event carries the
 * family only, because the subject is an address, an IP, or a user id (spec
 * 31 item 10).
 */
export const LIMIT_FAMILIES = Object.freeze([
  "magic-link:ip",
  "magic-link:email",
  "social-start:ip",
  "social-link:user",
  "passkey-options:ip",
  "passkey-verify:ip",
  "handoff-start:ip",
  "handoff-redeem:ip",
  "password-sign-up:ip",
  "password-sign-up:email",
  "password:ip",
  "password:email",
  "password:user",
  "password-resend:ip",
  "password-resend:email",
  "password-reset:ip",
  "password-reset:email",
  "password-reset-post:ip",
  "password-change:user",
  "otp:ip",
  "otp:email",
  "otp:email-day",
  "otp-verify:ip",
  "otp-verify:email",
  "totp-code:user",
  "totp-code:user-day",
  "totp-setup:user",
  "totp-verify:ip",
  "second-factor-passkey:ip",
  "second-factor-email:user",
  "totp:email-day",
  "invite:user",
  "invite:email",
  "invitation-accept:ip",
  "slug-check:user",
  "token-create:user",
  "token-use:tk",
  "token-use:to",
  "reauth:user",
  "reauth-mail:user",
  "session-revoke:user",
  "user-update:user",
  "passkey-rename:user",
  "email-change:user",
  "email-change:email",
  "email-change-confirm:ip",
  "unlink:user",
  "user-delete:user",
  "user-delete-confirm:ip",
  "token-live:session",
  "operator:ip",
  "operator-secrets:ip",
  "operator-users:ip",
  "operator-users:secret",
  "operator:user",
  "operator-impersonate:user",
  "oauth-register:ip",
  "oauth-authorize:ip",
  "oauth-token:ip",
  "oauth-token-origin:ip",
  "oauth-device:ip",
  "oauth-device-poll:code",
  "oauth-device-verify:ip",
  "oauth-device-verify:session",
  "oauth-device-verify:code",
  "oauth-introspect:ip",
  "oauth-introspect:client",
  "oauth-end-session:ip",
  "oauth-credentials:client",
  // Plan 12d: the SSO manager routes, the domain proof, the sign-in, and the SCIM server.
  "sso-manage:user",
  "sso-domain-verify:org",
  "sso-discover:ip",
  "sso-start:ip",
  "sso-acs:ip",
  "scim-auth:ip",
  "scim:token",
  // Plan 12i: the username set and the availability check.
  "username:user",
  "username-available:ip",
  // Plan 12i Task 3: the password sign-in by username and by phone.
  "password:username",
  "password:phone",
] as const);

export type LimitFamily = (typeof LIMIT_FAMILIES)[number];

/**
 * The one caller of `limiter.allow` in core (spec 31 item 10). It counts the
 * call on `<family>:<subject>`, the stored key of every release before, so a
 * window keeps its count across the upgrade. A refusal emits `limit.hit`
 * with the family and no part of the subject. It answers true when the call
 * is within the limit.
 */
export async function limit(
  config: ResolvedConfig,
  family: LimitFamily,
  subject: string,
  window: LimitWindow,
): Promise<boolean> {
  const allowed = await config.limiter.allow(`${family}:${subject}`, window);
  if (!allowed) config.observe.emit({ name: "limit.hit", family });
  return allowed;
}
