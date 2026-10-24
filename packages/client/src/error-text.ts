import type { ErrorCode, OAuthErrorCode } from "@authtempo/core/errors";
import { DOCS_ORIGIN, type ErrorTable, errorAnchor } from "@authtempo/core/routes";
import type { ClientCode, OAuthClientCode } from "./result.js";

/**
 * One sentence for each error code, in Simplified Technical English, for an
 * app to show, and the docs page of each code (plan 11d, spec 20). The tables
 * are typed by core's code unions, so a code that core adds fails this
 * package's compile until it has a text. The site check `check-error-links`
 * holds each text to the glossary and each link to an anchor of the build.
 */

/** The docs origin, the table of a code, and the errors anchor live in core (plan 11g); this package re-exports them. */
export { DOCS_ORIGIN, type ErrorTable, errorAnchor };

/** The codes that only an SDK answers. `redirect_mismatch` is the handoff's and the OAuth client's. */
export type SdkCode = "network" | "unexpected" | "cancelled" | "redirect_mismatch";

const CORE_TEXT: Readonly<Record<ErrorCode, string>> = {
  invalid_body: "The request has a field that is missing or wrong.",
  invalid_token: "The link or the token is not valid. Ask for a new one.",
  token_expired: "The link or the token expired. Ask for a new one.",
  oauth_denied:
    "The sign-in with the provider was cancelled or refused. Try again, or use another sign-in method.",
  oauth_failed: "The sign-in with the provider failed. Try again.",
  email_required: "The provider gave no email address. Use another sign-in method.",
  passkey_failed: "The passkey was not accepted. Try again, or use another method.",
  email_unverified: "Verify your email address first.",
  unauthorized: "You are not signed in, or your session ended. Sign in again.",
  origin_not_trusted: "The server does not accept requests from this app.",
  not_found: "The server does not have this feature.",
  rate_limited: "There were too many tries. Wait a few minutes, then try again.",
  email_taken_unverified:
    "An account with this email address waits for its verification. Sign in with an email link or code.",
  forbidden_rank: "Your role does not allow this action.",
  slug_reserved: "This name is reserved. Choose another name.",
  slug_taken: "Another organization has this name. Choose another name.",
  last_owner: "The organization needs another owner first.",
  already_member: "This person is a member already.",
  email_mismatch: "This invitation is for another email address.",
  conflict: "Another change happened at the same time. Try again.",
  invalid_credentials: "The email address or the password is wrong.",
  password_policy: "The password does not obey the password rules.",
  password_breached: "This password is in a known data breach. Choose another password.",
  email_taken: "An account with this email address exists. Sign in.",
  token_limit: "You have the maximum number of API tokens. Revoke one first.",
  hook_refused: "The app refused this action.",
  hook_failed: "The app could not finish this action. Try again later.",
  organization_limit: "You are a member of the maximum number of organizations.",
  member_limit: "The organization has the maximum number of members.",
  invitation_limit: "The organization has the maximum number of open invitations.",
  invalid_code: "The code is wrong or expired. Examine the code, or ask for a new one.",
  too_many_attempts: "There were too many wrong codes. Ask for a new code.",
  totp_enabled: "The second factor is on already.",
  totp_not_enabled: "The second factor is not on.",
  second_factor_last_method:
    "This is your last passkey, and passkeys are a second factor. Add another passkey, or turn off the passkey method.",
  sign_up_closed: "The app does not accept a new account for this email address.",
  captcha_required: "Complete the captcha, then try again.",
  captcha_failed: "The captcha check failed. Try again.",
  captcha_unavailable: "The captcha check is not available now. Try again later.",
  breach_check_unavailable:
    "The password check is not available now. Wait a few minutes, then start again. A used email code does not work again.",
  session_not_fresh:
    "Confirm that it is you to continue: enter your password, or use your passkey.",
  last_credential: "This is your last way to sign in. Add another one before you remove it.",
  identity_taken:
    "This provider account belongs to another account. Sign in to that account to use it.",
  sole_owner: "You are the only owner of a team. Make another member an owner first.",
  role_in_use: "A member or an invitation holds this role. Give them another role first.",
  role_limit: "This organization has the most roles that it can hold. Delete a role first.",
  role_taken: "This organization has a role with this name. Choose another name.",
  team_limit: "This organization has the most teams that it can hold. Delete a team first.",
  team_member_limit: "This team has the most members that it can hold. Remove a member first.",
  last_team: "This is the last team of the organization. Create another team first.",
  token_exhausted: "This API token has no calls left. Wait for its refill, or use another token.",
  token_retired: "This API token does not work now. Make a new token in the app.",
  organization_token_limit:
    "This organization has the most tokens it can have. Revoke a token first.",
  internal: "The server had an error. Try again later.",
  account_banned: "Your account is banned, so you cannot sign in.",
  operator_required: "You do not have the operator rights for this action.",
  operator_self: "You cannot do this action on your own account.",
  impersonation_refused: "You cannot act as this user.",
  impersonation_session: "You cannot do this while you act as another user.",
  not_ready: "The service is not ready. Try again later.",
  domain_unverified: "The DNS record of the domain was not found. Publish it and try again.",
  domain_taken: "Another organization holds this domain.",
  domain_limit: "The organization holds the most domains it can have.",
  delete_too_large:
    "The delete is too large for one request. Delete some organizations or SCIM groups first.",
  connection_limit: "The organization holds the most SSO connections it can have.",
  second_factor_required: "Turn on a second factor first, then try again.",
  sso_failed: "The single sign-on did not complete. Try again.",
  sso_not_configured: "Single sign-on is not set up for this address.",
  sso_required: "This address signs in with single sign-on only.",
  sso_domain_mismatch: "The organization did not prove the domain of this address.",
  sso_not_provisioned: "Ask your organization to give you access first.",
  account_disabled: "Your organization turned off this account.",
  role_not_found: "The organization no longer has the role of this sign-in.",
  passkey_unknown: "This site does not know this passkey. Use another passkey or another method.",
  username_taken: "Another account has this username. Choose another username.",
  username_invalid:
    "Use letters, digits, the underscore, and the dot only. This username is not available.",
  phone_invalid: "Enter the phone number with a plus sign and the country code.",
  phone_region: "This app does not send codes to numbers of this country.",
  sms_unavailable:
    "The text message could not be sent now. Try again later, or use another method.",
  host_not_allowed: "This server does not serve this address. Open the app at its usual address.",
};

const OAUTH_TEXT: Readonly<Record<OAuthErrorCode, string>> = {
  invalid_request: "The request to the provider is not valid.",
  invalid_client: "The provider does not know this app.",
  unauthorized_client: "This app may not use this token.",
  invalid_grant: "The code or the token is not valid. Sign in again.",
  unsupported_grant_type: "The provider does not support this kind of request.",
  invalid_scope: "The app asked for a scope that the provider does not have.",
  invalid_target: "The app asked for a resource that the provider does not serve.",
  unsupported_response_type: "The provider does not support this kind of request.",
  access_denied: "You did not allow the app.",
  login_required: "You must sign in first.",
  consent_required: "You must allow the app first.",
  request_not_supported: "The provider does not support this kind of request.",
  request_uri_not_supported: "The provider does not support this kind of request.",
  registration_not_supported: "The provider does not support this kind of request.",
  invalid_redirect_uri: "The return address of the app is not valid.",
  invalid_client_metadata: "The registration data of the app is not valid.",
  invalid_token: "The access token is not valid, or it expired.",
  insufficient_scope: "The access token does not allow this action.",
  invalid_dpop_proof: "The key proof of the app is not valid. Try again.",
  authorization_pending: "The device waits for your approval. Approve it on the other screen.",
  slow_down: "The device asked too often. It waits longer before it asks again.",
  expired_token: "The device code expired. Start again on the device.",
  rate_limited: "There were too many tries. Wait a few minutes, then try again.",
};

const SDK_TEXT: Readonly<Record<SdkCode, string>> = {
  network: "The server did not answer. Examine the connection, then try again.",
  unexpected: "The server sent an answer that the app cannot read. Try again later.",
  cancelled: "The action was cancelled.",
  redirect_mismatch:
    "The browser came back to an address that this sign-in did not start. Start the sign-in again.",
};

/** Every English text, by table. The site check reads all three. */
export const ERROR_TEXT = { core: CORE_TEXT, oauth: OAUTH_TEXT, sdk: SDK_TEXT } as const;

/**
 * The languages of the error texts (owner's addition of 2026-10-14). The owner
 * picks the list; English is the first. A language added here fails the
 * compile until ERROR_TEXTS has its table with every code.
 */
export const LOCALES = ["en"] as const;
export type Locale = (typeof LOCALES)[number];

export interface ErrorTexts {
  core: Readonly<Record<ErrorCode, string>>;
  oauth: Readonly<Record<OAuthErrorCode, string>>;
  sdk: Readonly<Record<SdkCode, string>>;
}

/** The texts of each language. The docs link of a code is the same in every language. */
export const ERROR_TEXTS: Readonly<Record<Locale, ErrorTexts>> = { en: ERROR_TEXT };

/**
 * The entry of `list` for a language tag: the exact tag, then its first part
 * (`en-GB` gives `en`), else English. Not a package export: the test runs it
 * over a list of two languages, because `LOCALES` holds one today.
 */
export function pickLocale<L extends string>(
  tag: string | null | undefined,
  list: readonly L[],
): L | "en" {
  const t = (tag ?? "").toLowerCase();
  // A tag may use "_", as `fr_FR` of a system setting does.
  const first = t.split(/[-_]/)[0] ?? "";
  return list.find((l) => l === t) ?? list.find((l) => l === first) ?? "en";
}

/** The locale of a language tag, such as `navigator.language`, else English. */
export function resolveLocale(tag: string | null | undefined): Locale {
  return pickLocale(tag, LOCALES);
}

const isSdk = (code: string): code is SdkCode => Object.hasOwn(SDK_TEXT, code);

/**
 * The sentence for a code in a locale (default English): a core code, an SDK
 * code, or with `"oauth"` first a code of the OAuth client.
 */
export function errorText(code: ErrorCode | SdkCode, locale?: Locale): string;
export function errorText(code: OAuthClientCode, table: "oauth", locale?: Locale): string;
export function errorText(
  code: ClientCode | OAuthClientCode,
  second?: ErrorTable | Locale,
  third?: Locale,
): string {
  const table: ErrorTable = second === "oauth" ? "oauth" : "core";
  const locale = (second === "oauth" || second === "core" ? third : second) ?? "en";
  // A locale outside LOCALES (a JavaScript caller, a stored value) answers English, never a throw.
  const texts = ERROR_TEXTS[resolveLocale(locale)];
  if (isSdk(code)) return texts.sdk[code];
  return table === "oauth" ? texts.oauth[code as OAuthErrorCode] : texts.core[code as ErrorCode];
}

/**
 * The docs page of a code: its anchor on the errors page, or for an SDK code
 * the section that explains it (the client's results, the handoff's failure codes).
 */
export function errorDocsURL(code: ErrorCode | SdkCode): string;
export function errorDocsURL(code: OAuthClientCode, table: "oauth"): string;
export function errorDocsURL(
  code: ClientCode | OAuthClientCode,
  table: ErrorTable = "core",
): string {
  if (code === "redirect_mismatch") return `${DOCS_ORIGIN}/docs/reference/handoff/#failure-codes`;
  if (isSdk(code)) return `${DOCS_ORIGIN}/docs/reference/client/#results`;
  return `${DOCS_ORIGIN}/docs/reference/errors/#${errorAnchor(code, table)}`;
}
