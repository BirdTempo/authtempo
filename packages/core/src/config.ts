import {
  CORE_STATEMENTS,
  NAME_RE,
  type RoleDef,
  type RoleTable,
  type Statements,
  statementFault,
  union,
} from "./access.js";
import { DEFAULT_BASE_PATH } from "./bindings.js";
import {
  CAPTCHA_FLOWS,
  type CaptchaConfig,
  type CaptchaFlow,
  type CaptchaPort,
  DEFAULT_CAPTCHA_FLOWS,
  type ResolvedCaptcha,
} from "./captcha.js";
import { configKeyPaths } from "./config-paths.js";
import { type AccountMailInput, defaultAccountMail } from "./engine/account-mail.js";
import {
  defaultEmailOtpMail,
  defaultResetOtpMail,
  defaultSecondFactorMail,
  type EmailOtpMailInput,
} from "./engine/email-otp-mail.js";
import {
  type HooksConfig,
  IDENTITY_HOOK_POINTS,
  type IdentityHooks,
  OPERATOR_HOOK_POINTS,
  type OperatorHooks,
  ORGANIZATION_HOOK_POINTS,
  type OrganizationHooks,
  type ResolvedHooks,
  SESSION_HOOK_POINTS,
  type SessionHooks,
  USER_HOOK_POINTS,
  type UserHooks,
} from "./engine/hooks.js";
import { defaultNoticeMail, type NoticeMailInput } from "./engine/notices.js";
import type { CimdEntry, JwksEntry } from "./engine/oauth-clients.js";
import { BUILT_IN_SCOPES, SCOPE_RE } from "./engine/oauth-result.js";
import { defaultExistingAccountMail, type ExistingAccountMailInput } from "./engine/password.js";
import { PASSWORD_MAX_LENGTH } from "./engine/password-policy.js";
import { deriveRoles, normalizeSlug, ROLE_RE } from "./engine/ranks.js";
import type { DnsTxtPort } from "./engine/sso/dns.js";
import { validWindow, WINDOW_CALLS_MAX, WINDOW_SECONDS_MAX } from "./engine/token-use.js";
import { type ConfirmPageInput, defaultConfirmPage } from "./http/confirm-page.js";
import { type ConsentPageInput, defaultConsentPage } from "./http/consent-page.js";
import { LEGACY_SESSION_COOKIE } from "./http/cookies.js";
import { type DevicePageInput, defaultDevicePage } from "./http/device-page.js";
import { defaultEmailChangePage, type EmailChangePageInput } from "./http/email-change-page.js";
import {
  defaultHandoffConfirmPage,
  type HandoffConfirmPageInput,
} from "./http/handoff-confirm-page.js";
import { defaultResetPage, type ResetPageInput } from "./http/password-pages.js";
import { defaultSignInPage, type SignInPageInput } from "./http/sign-in-page.js";
import { defaultTotpPage, type TotpChallengePageInput } from "./http/totp-page.js";
import { createMemoryLimiter } from "./limiter/memory.js";
import type { LimiterPort, LimitWindow } from "./limiter/port.js";
import { type ResolvedObserve, resolveObserve } from "./observe/config.js";
import { writeConstructionLine } from "./observe/default-output.js";
import { createDefaultObserver, createObserver, type Observer } from "./observe/observer.js";
import type { ObserveConfig } from "./observe/port.js";
import { type Clock, systemClock } from "./primitives/clock.js";
import { movedPrefixFault, sessionCookieNames } from "./primitives/credentials.js";
import { DPOP_WINDOW_SECONDS } from "./primitives/dpop.js";
import { FOREIGN_ALGS, type ForeignAlg } from "./primitives/foreign-jwk.js";
import { JWS_ALGS, type JwsAlg } from "./primitives/jwk.js";
import {
  createKeyring,
  currentSecret,
  ENTROPY_REFUSE_BITS,
  ENTROPY_WARN_BITS,
  entropyBits,
  type Keyring,
  SECRET_VERSION_MAX,
  type SecretVersion,
} from "./primitives/keyring.js";
import { isResourceUrl } from "./primitives/resource.js";
import { hasControlChar } from "./primitives/text.js";
import { secretParts } from "./redact.js";
import type { SessionRow, UserRow } from "./schema.js";
import { createJoseJwtSeam, type JwtSeam } from "./seams/jwt.js";
import { createPbkdf2PasswordHash, type PasswordHashSeam } from "./seams/password-hash.js";
import { createSimpleWebAuthnSeam, type WebAuthnSeam } from "./seams/webauthn.js";
import { type AppleConfig, appleProvider } from "./social/apple.js";
import { type GitHubConfig, githubProvider } from "./social/github.js";
import { type GoogleConfig, googleProvider } from "./social/google.js";
import { type LinkedInConfig, linkedinProvider } from "./social/linkedin.js";
import { type OAuth2Entry, oauth2Provider } from "./social/oauth2.js";
import { isIssuer, type OidcEntry, oidcProvider } from "./social/oidc.js";
import {
  CORE_AUTHORIZE_PARAMS,
  type ConfiguredProvider,
  isHttpsUrl,
  PROVIDER_NAME_RE,
  RESERVED_PROVIDER_NAMES,
} from "./social/provider.js";
import { providerFetch } from "./social/provider-fetch.js";
import type { StorageAdapter } from "./storage/port.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailPort {
  send(message: MailMessage): Promise<void>;
}

export interface AccountConfig {
  /**
   * The proof mails (plan 12a): the re-authentication code, the
   * change-of-address link and code, and the note to an address that an
   * account holds. Core sends each to the input's address, whatever `to` the
   * builder answers. Default `defaultAccountMail`.
   */
  mail?: (input: AccountMailInput) => MailMessage;
  /**
   * The notice mails after a change of a way in (plan 12a; ASVS 5.0.0
   * 6.3.7). They are on by default, and `false` turns every notice off.
   * `mail` replaces the default text. Core sends it to the input's address.
   */
  notices?: AccountNoticesConfig | false;
  /**
   * The HTML of the page a change-of-address link opens (plan 12a). The page
   * must post `token` to `action` by `method="post"`. Core sets the headers
   * and a policy with no script. Default `defaultEmailChangePage`.
   */
  confirmPage?: (input: EmailChangePageInput) => string;
  /**
   * `POST /user/delete` and `api.user.delete` (plan 12a). Default true: the
   * right to delete the account is the person's. `false` removes the route,
   * and the engine answers `not_found`. Better Auth's default is off.
   */
  delete?: boolean;
  /**
   * A mailed link before the delete (plan 12a Task 20). Default `false`: the
   * fresh session already proves the person (ASVS 5.0.0 7.5.1), and Better
   * Auth deletes at once unless an app sets `sendDeleteAccountVerification`.
   * The link adds a proof of the mailbox, for an app whose sessions live on
   * shared devices. `{}` turns it on with the defaults.
   */
  deleteConfirm?: false | AccountDeleteConfirmConfig;
}

export interface AccountDeleteConfirmConfig {
  /**
   * The life of the link, 5 to 1440 minutes. Default 60: a delete is not
   * undone, and a short window lowers the risk of a link in an old mailbox.
   * Better Auth's default is 24 hours (`deleteTokenExpiresIn`,
   * dist/api/routes/update-user.mjs:322, read 2026-10-14).
   */
  ttlMinutes?: number;
}

/** The bounds and the default of `account.deleteConfirm.ttlMinutes`. The shim reads them too. */
export const DELETE_CONFIRM_TTL_MINUTES = { min: 5, max: 1440, default: 60 } as const;

export interface AccountNoticesConfig {
  /** Default `defaultNoticeMail`. */
  mail?: (input: NoticeMailInput) => MailMessage;
}

export interface ResolvedAccount {
  mail: (input: AccountMailInput) => MailMessage;
  /** Null when `account.notices` is `false`. */
  notices: { mail: (input: NoticeMailInput) => MailMessage } | null;
  confirmPage: (input: EmailChangePageInput) => string;
  delete: boolean;
  /** Null when `account.deleteConfirm` is `false` or absent. */
  deleteConfirm: { ttlMinutes: number } | null;
}

export interface AuthConfig {
  /** Path prefix for the auth routes. Default "/auth". */
  basePath?: string;
  /** Origin of the server that mounts `handle`, no path, no trailing slash. */
  baseURL: string;
  /**
   * The app secret, read as version 1 (plan 12b). At least 32 characters and
   * an estimate of 100 bits or more: use 32 random bytes, for example
   * `openssl rand -base64 32`. Give `secret`, `secrets`, or both.
   */
  secret?: string;
  /**
   * The app secrets by version, the current version first (plan 12b, spec
   * 22). The current version seals and keys every new value. An old version
   * stays here until `api.secrets.status` counts no row under it. With
   * `secret` too, `secret` is version 1.
   */
  secrets?: SecretVersion[];
  /**
   * The name of the app, shown on the sign-in pages and in the mail
   * subjects. 1 to 80 characters, no control character. Default: the host
   * of `baseURL`.
   */
  appName?: string;
  /** Exact origins and app schemes. No wildcards in version 1. */
  trustedOrigins: string[];
  /**
   * The origin the browser lands on after a sign-in, and where
   * `?auth_error=` goes. Default `baseURL`. Set it when the app lives on
   * another origin. Must be `baseURL` or a member of `trustedOrigins`.
   */
  appURL?: string;
  /**
   * `SameSite` of the session cookie. `Lax` (default) is sent on every
   * same-site request and on top-level navigations. An app on another
   * site, not a sibling subdomain, needs `None`, which also lets any site
   * trigger credentialed requests that the Origin rule must then refuse.
   */
  cookie?: { sameSite?: "Lax" | "None" };
  storage: StorageAdapter;
  mail: MailPort;
  limiter?: LimiterPort;
  /**
   * Reads the client IP for the per-IP limit. The default reads
   * `cf-connecting-ip`, which only Cloudflare sets on Workers. On any other
   * host a caller sets that header freely and can rotate it past the limit,
   * so pass a function that reads the header your trusted proxy sets.
   */
  clientIp?: (request: Request) => string | null;
  clock?: Clock;
  /**
   * The session cookie. Default `__Host-tempo_session` (plan 12b). With that
   * name, core also reads the old `tempo_session` for one release and moves
   * it. Another name gets no such read.
   */
  cookieName?: string;
  session?: {
    ttlDays?: number;
    slidingRefreshDays?: number;
    /**
     * The absolute lifetime of a session, 1 to 365 days (plan 12b, ASVS
     * 5.0.0 7.3.2). Off by default. A session ends at `createdAt` plus this,
     * whatever its sliding refresh, and the person signs in again.
     */
    absoluteDays?: number;
    /**
     * The fresh window of a session in minutes, 1 to 1440 (plan 12a). A
     * sensitive change needs a sign-in or a re-authentication within it:
     * the address, a link, an unlink, the delete, a revoke, a passkey, an API
     * token, the second factor. Default 1440 (24 hours), Better Auth's
     * `freshAge`. A shorter window asks a person to prove it again sooner.
     */
    freshMinutes?: number;
    /**
     * Defer the sliding refresh of a GET to `POST /session/refresh` (plan
     * 12a, Better Auth's `deferSessionRefresh`). With it on, a GET request
     * writes no session row: it does not slide the expiry and it does not
     * delete an ended row. `GET /session` answers `needsRefresh`. Use it
     * when a GET reads from a replica or must not write. Default false. A
     * client that never posts the refresh would let an active session end
     * at its old expiry. The default keeps today's refresh for every client.
     */
    deferRefresh?: boolean;
  };
  magicLink?: {
    ttlMinutes?: number;
    linkBuilder?: (token: string, next: string) => string;
    /**
     * The HTML of the page a magic link opens. The page must contain a form
     * that posts `token` to `action` by `method="post"`. The default is
     * `defaultConfirmPage`. Core sets the headers, so return markup only.
     */
    confirmPage?: (input: ConfirmPageInput) => string;
  };
  social?: {
    google?: GoogleConfig;
    apple?: AppleConfig;
    /** GitHub, an oauth2 preset with scope `read:user user:email` (plan 9c). */
    github?: GitHubConfig;
    /**
     * LinkedIn, an oauth2 preset on the user info endpoint with scope
     * `openid profile email` (plan 9c). It ignores LinkedIn's ID token.
     */
    linkedin?: LinkedInConfig;
    /**
     * OpenID Connect providers (plan 9c). An entry with no `endpoints` reads
     * `<issuer>/.well-known/openid-configuration` on its first start and
     * keeps it for the life of this instance. Set `endpoints` to never read it.
     */
    oidc?: OidcEntry[];
    /**
     * Providers that issue no ID token (plan 9c). Each entry's `userinfo`
     * answers the profile from the access token. Core refuses a name that
     * fails `^[a-z][a-z0-9-]{0,31}$`, a preset name, `email`, `credential`,
     * and a name given twice.
     */
    oauth2?: OAuth2Entry[];
    /**
     * The fetch for every provider call. Default: the global fetch. Tests
     * inject one. Core wraps it: no redirect is followed.
     */
    fetch?: typeof fetch;
  };
  /** The ID token verifier and the Apple secret signer. Default: jose. Tests inject a fake. */
  jwt?: JwtSeam;
  /**
   * Passkeys are on when set. `rpID` is the registrable domain the
   * credentials bind to; every origin must be on that domain. Exact
   * origins, no path.
   */
  passkey?: { rpID: string; rpName: string; origins: string[] };
  /** The WebAuthn ceremonies. Default: @simplewebauthn/server. Tests inject a fake. */
  webauthn?: WebAuthnSeam;
  /**
   * The handoff for native and desktop apps. `schemes` are the app schemes
   * the one-time code may redirect to, each ending in `://`. In
   * development `devRedirectPattern` may admit a full redirect URL, for
   * example an Expo Go `exp://` address. `signInPage` replaces the page
   * core ships.
   */
  handoff?: {
    schemes: string[];
    devRedirectPattern?: RegExp;
    signInPage?: (input: SignInPageInput) => string;
    confirmPage?: (input: HandoffConfirmPageInput) => string;
  };
  /** Off when absent or `false`. `{}` turns it on with the defaults. */
  organizations?: OrganizationsConfig | false;
  /** API tokens (plan 12k). Tokens are always on; this block only sets their limits. */
  tokens?: TokensConfig;
  /**
   * Who may become a user (plan 12b). `"open"` (default): anyone who proves
   * an address or signs up. `"invited"`: only an address with a pending
   * invitation; needs `organizations`. `false`: nobody new; existing users
   * sign in as before. A refusal answers 403 `sign_up_closed`.
   */
  signUp?: "open" | "invited" | false;
  /**
   * Password sign-in is on when set. `{}` turns it on with the defaults.
   * Absent: no password route, no form on the sign-in page, no
   * `api.password`.
   */
  password?: PasswordConfig;
  /**
   * Email codes (plan 9e, spec 8.10): a sign-in by a code from the mail, and
   * a password reset by a code. On by default; `false` removes the routes
   * and `api.emailOtp`. The two reset routes also need `password`.
   */
  emailOtp?: EmailOtpConfig | false;
  /**
   * The TOTP second factor (plan 9f, spec 8.11). On by default when
   * `password` is set: a user turns it on for their own account. `false`
   * removes the routes and `api.totp`. Without `password` there is no
   * factor, because the gate covers the password sign-in only.
   */
  totp?: TotpConfig | false;
  /**
   * JWT minting (plan 9g, spec 8.12): `GET /jwks`, `GET /token`, and
   * `api.jwt`. On by default; `false` removes them. The OAuth provider
   * needs it. Not `jwt`: that key is the ID token seam (plan 3).
   */
  jwtMint?: JwtMintConfig | false;
  /**
   * The OAuth 2.1 and OIDC provider (plan 9g, spec 8.13), for agents and MCP
   * clients. Off when absent or `false`; on when `resources` is set. Needs
   * `jwtMint`: an access token is a JWT that core signs.
   */
  oauth?: OAuthConfig | false;
  /**
   * The operator routes (plans 11c and 11c2), under `Authorization:
   * Operator <secret>`. Off when absent or `false`. `POST
   * <basePath>/operator/keys/rotate` makes a new signing key, for
   * `authtempo keys rotate`; it exists only with `jwtMint`. `GET
   * <basePath>/operator/secrets/status`, `POST
   * <basePath>/operator/secrets/rewrap`, and `GET <basePath>/operator/info`
   * serve `authtempo secret status`, `secret rewrap`, and `info`, with or
   * without `jwtMint`. They answer counts and key names, never a value.
   */
  operator?: OperatorConfig | false;
  /**
   * Enterprise SSO (plan 12d, spec 30): the email domains that an
   * organization proves by DNS, and its connections to its IdP. Off when
   * absent or `false`. Needs `organizations` and `sso.dns`.
   */
  sso?: SsoConfig | false;
  /**
   * `GET <basePath>/openapi.json`, the OpenAPI document of the routes that
   * this config mounts (plan 11g). Off when absent. It lists no route of a
   * feature that is off, and holds no secret.
   */
  openapi?: boolean;
  /**
   * The app's code at named points of the organization and session flows
   * (plan 9d, spec 8.9). A before hook runs inside the flow's transaction and
   * refuses with `throw hookRefusal(message)`; an after hook runs after the
   * commit. Pass plain objects of functions. Organization hooks need
   * `organizations`.
   */
  hooks?: HooksConfig;
  /**
   * The settings page of a signed-in person (plan 12a, spec 8.15): the
   * proof mails, the notices, the confirm page of a change of address, and
   * the account delete. Pass `{}` or leave it out for the defaults.
   */
  account?: AccountConfig;
  /**
   * A captcha on the flows that send mail or write rows (plan 12b). The token
   * comes in the header `x-captcha-response`, after the flow's limits. Off
   * when absent. `@authtempo/captcha-turnstile` answers the port.
   */
  captcha?: CaptchaConfig;
  /**
   * The event port (plan 12h, spec 31). Off when absent: core then writes the
   * log lines of today and sends nothing anywhere. With a sink, core buffers
   * each event, and the flush of `auth.observe` sends the batch after the answer.
   */
  observe?: ObserveConfig;
}

export interface PasswordConfig {
  /** The hash seam. Default: PBKDF2-SHA256 (see `createPbkdf2PasswordHash`). */
  hash?: PasswordHashSeam;
  /** 8 to 128. Default 8. */
  minLength?: number;
  /**
   * True when the password is in a known breach: `password_breached`.
   * `"unavailable"` when the check got no answer: the password is refused
   * with 503 `breach_check_unavailable`, so the check fails closed (plan 12b).
   * A throw answers 500: it is a fault of the function, not an outage.
   * Default: no check. `@authtempo/breach-check` answers this port.
   */
  breachCheck?: (plain: string) => Promise<boolean | "unavailable">;
  /** 1 to 1440. Default 15. */
  resetTtlMinutes?: number;
  /** The HTML of the reset page. The default is `defaultResetPage`. */
  resetPage?: (input: ResetPageInput) => string;
  /**
   * The old system's password check, for users that an importer moved with
   * no exportable hash (Cognito; spec 17.4). Core calls `verify` only for a
   * user whose password row holds `LEGACY_VERIFY_HASH`, after the sign-in
   * limits, with the normalized email. `true` writes this config's hash over
   * the marker and signs in through the normal path. `false`, a throw, or no
   * answer within `timeoutMs` answers `invalid_credentials`. `verify` must
   * stop its call when `signal` aborts.
   */
  legacyVerify?: LegacyVerifyConfig;
  /**
   * True refuses a password sign-in of a user whose address is not
   * verified: the right password answers `email_unverified` (403) and
   * mails a new verify link, at most 3 per 15 minutes. A sign-up then
   * opens no session. Default `false`, because core signs in an
   * unverified password user since plan 8 (spec 8.7). A default of `true`
   * would lock out each unverified user of a live app at the upgrade.
   */
  requireVerified?: boolean;
  /**
   * The answer of a sign-up (plan 12b, ASVS 5.0.0 6.3.8). Default true: every
   * sign-up answers `{ sent: true }` with no session, and a known address
   * gets a mail. False: the answer of plan 8, a session or `email_taken`.
   * `requireVerified` changes only the answer of `false`.
   */
  uniformSignUp?: boolean;
  /** The mail to an address that has an account, at a uniform sign-up. Core sends it to the address, whatever `to` it answers. Default `defaultExistingAccountMail`. */
  existingAccountMail?: (input: ExistingAccountMailInput) => MailMessage;
}

export interface EmailOtpConfig {
  /** The life of a code, 1 to 60. Default 10. */
  ttlMinutes?: number;
  /** The digits of a code, 6 or 8. Default 6. */
  length?: 6 | 8;
  /** The wrong codes that spend a code, 3 to 10. Default 5. */
  maxAttempts?: number;
  /** The sign-in code mail. Core sends it to the code's address, whatever `to` it answers. Default `defaultEmailOtpMail`. */
  mail?: (input: EmailOtpMailInput) => MailMessage;
  /** The reset code mail, with the same rule. Default `defaultResetOtpMail`. */
  resetMail?: (input: EmailOtpMailInput) => MailMessage;
}

export interface ResolvedEmailOtp {
  ttlMinutes: number;
  length: 6 | 8;
  maxAttempts: number;
  mail: (input: EmailOtpMailInput) => MailMessage;
  resetMail: (input: EmailOtpMailInput) => MailMessage;
}

/**
 * The second factor's gate on the sign-in methods other than the password
 * (plan 12c, owner decision 2 of 2026-10-14). Each key is on by default: a
 * person who turns the factor on expects it on every pathway (ASVS 5.0
 * 6.3.4). `false` lets that method open a session with no second factor.
 * The password sign-in and the reset are always gated. The passkey needs no
 * key: every ceremony requires user verification, so it is two factors by
 * itself. The handoff has no key: it continues a browser session that passed
 * the gate.
 */
export interface TotpGateConfig {
  /** The magic link. Default true. */
  magicLink?: boolean;
  /** The email code sign-in. Default true. */
  emailOtp?: boolean;
  /** Every social provider. Default true. */
  social?: boolean;
}

export interface TotpConfig {
  /**
   * The issuer that an authenticator app shows: 1 to 80 characters, no
   * control character, no colon. Default `appName`, and with no `appName`
   * the host of `baseURL` with no port. An app whose `appName` holds a colon
   * sets `issuer`: the key URI uses the colon to split the issuer from the
   * account.
   */
  issuer?: string;
  /** The backup codes per setup and per regeneration, 5 to 20. Default 10. */
  backupCodes?: number;
  /**
   * The characters of a backup code, 23 to 32. Default 23: 23 characters of a
   * 31-symbol alphabet hold 113.9 bits, above the 112 bits at which ASVS 5.0
   * 6.5.2 allows a standard hash. Core stores HMAC-SHA256 under `secret`, so a
   * shorter code would need a slow salted hash on every wrong guess (plan 12c).
   */
  backupCodeLength?: number;
  /** The life of a trusted device, 1 to 365 days. Default 30. */
  trustDays?: number;
  /** The trust cookie: 1 to 64 letters, digits, `.`, `_`, or `-`, not `cookieName`. Default `tempo_totp_trust`. */
  trustCookieName?: string;
  /** The HTML of the challenge page. Default `defaultTotpPage`. */
  challengePage?: (input: TotpChallengePageInput) => string;
  /** The gate on the magic link, the email code, and social. Each is on by default (plan 12c). */
  gate?: TotpGateConfig;
  /**
   * The mail of a second-factor email code (plan 12c). Core sends it to the
   * user's address, whatever `to` it answers. Default `defaultSecondFactorMail`.
   */
  emailMail?: (input: EmailOtpMailInput) => MailMessage;
}

export interface ResolvedTotp {
  issuer: string;
  backupCodes: number;
  backupCodeLength: number;
  trustDays: number;
  trustCookieName: string;
  challengePage: (input: TotpChallengePageInput) => string;
  gate: { magicLink: boolean; emailOtp: boolean; social: boolean };
  emailMail: (input: EmailOtpMailInput) => MailMessage;
}

export interface JwtMintConfig {
  /**
   * `EdDSA` (Ed25519, default), `ES256` (ECDSA P-256), or `RS256` (RSA 2048, plan 12e).
   * With `RS256`, every JWT of the deployment then signs with RS256 (plan 12e).
   * A change retires the signing key at the next signature.
   */
  alg?: JwsAlg;
  /** The `aud` of a session JWT: 1 to 10 strings, each 1 to 2048 characters. Default `[baseURL]`. */
  audience?: string | string[];
  /** The life of a session JWT, 1 to 60. Default 15. A sign-out does not end a token. */
  ttlMinutes?: number;
  /**
   * The app's own claims. A reserved name (`iss`, `sub`, `aud`, `iat`,
   * `exp`, `nbf`, `jti`, `sid`, `email`, `email_verified`, `name`, `org`,
   * `act`) never comes from here. A throw answers `hook_failed`.
   */
  claims?: (
    user: UserRow,
    session: SessionRow,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * The days between two automatic rotations of the signing key: a whole
   * number from 1 to 365 (plan 11c). Off when absent. The timer is lazy: the
   * first signature with a key this old retires the key and signs with a new
   * one. A JWKS read never rotates. The retired key verifies for 24 hours.
   */
  rotateEvery?: number;
}

export interface ResolvedJwtMint {
  alg: JwsAlg;
  audience: string[];
  ttlMinutes: number;
  claims:
    | ((
        user: UserRow,
        session: SessionRow,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>)
    | null;
  /** Days, or null: no timer (plan 11c). */
  rotateEvery: number | null;
}

/** The scopes of a named operator secret (plan 12f). Each scope opens one group of operator routes. */
export type OperatorScope = "keys" | "secrets" | "users" | "sessions" | "audit" | "sso";

/** One named operator secret with its scopes (plan 12f, owner decision 1). */
export interface OperatorSecretEntry {
  /** 1 to 32 characters of `[a-z0-9_-]`, first a letter or a digit. The audit row names the secret by it. */
  name: string;
  /** The SHA-256 of the secret, as 64 lowercase hex characters. Core stores the hash and never the secret. */
  secretHash: string;
  /** At least one scope. A secret with no scope could do nothing, so the config refuses it. */
  scopes: OperatorScope[];
}

/**
 * One operator secret after construction. The entry and its scope list are
 * frozen, so no code can widen a secret at run time.
 */
export type ResolvedOperatorSecret = Readonly<Omit<OperatorSecretEntry, "scopes">> & {
  readonly scopes: readonly OperatorScope[];
};

/**
 * Set `secretHash` or `secrets`, not both. With `users` and
 * `organizations.platformRole`, you can set neither: only platform
 * operators then use the tools. Each tool is off by default, so an upgrade
 * from plan 11c opens no new route and widens no secret.
 */
export interface OperatorConfig {
  /**
   * The SHA-256 of the operator secret, as 64 lowercase hex characters
   * (plan 11c). Core stores this hash and never the secret, as it stores
   * every token. Make the secret from 32 random bytes or more. Plan 12f:
   * it is one secret, named "default", with the scopes keys and secrets
   * only, so an upgrade does not widen an 11c secret.
   */
  secretHash?: string;
  /**
   * Plan 12f: named secrets, each with its scopes (owner decision 1). No
   * default: an entry names its scopes, so no secret gets a scope by
   * accident. Core compares a presented secret against every entry.
   */
  secrets?: OperatorSecretEntry[];
  /**
   * Plan 12f: the user, session, and audit tools. Off by default, because
   * each tool reads or changes the accounts of every user. It needs a
   * secret with the scope users or `organizations.platformRole`, so that
   * an actor can use the tools.
   */
  users?: true;
  /**
   * Plan 12f: impersonation. Off by default, because an operator then acts
   * as the user. It needs `users` and `organizations.platformRole`: only a
   * platform operator starts one (owner decision 2). `ttlMinutes` is a
   * whole number from 5 to 240, default 60: an hour serves a support call,
   * and the session cannot outlive it. `notice` is true by default: the
   * user gets a mail at each start (owner decision 3).
   */
  impersonation?: { ttlMinutes?: number; notice?: boolean };
}

/** The operator config after construction (plan 12f). The 11c `secretHash` is the entry "default". */
export interface ResolvedOperator {
  secrets: readonly ResolvedOperatorSecret[];
  users: boolean;
  impersonation: { ttlMinutes: number; notice: boolean } | null;
}

export interface OAuthConfig {
  /**
   * The resource indicators (RFC 8707) that a client may ask for: 1 to 20
   * absolute http or https URLs, no query, fragment, or credentials. Each is
   * the `aud` of the access tokens for it, and `auth.caller` reads a request
   * under its path as that resource.
   */
  resources: string[];
  /**
   * The resource of a request that names none (plan 12e ruling 52). Absent
   * by default: then an authorize request, a `client_credentials` grant,
   * and a device start with no `resource` answer `invalid_target`. Set it
   * to one entry of `resources` for a client that cannot send RFC 8707
   * `resource`, such as the OpenID conformance suite. Each such token then
   * has this audience. A code exchange and a refresh with no `resource`
   * keep the resource of their grant, with or without this key.
   */
  defaultResource?: string;
  /** The app's scopes, name to the consent page's text. `openid`, `profile`, `email`, and `offline_access` are built in. */
  scopes?: Record<string, string>;
  /**
   * `dynamic`: RFC 7591 at `POST /oauth/register`, default false (plan 12e).
   * `cimd`: a client id that is the URL of its metadata document, default
   * true. Both may be off: `api.oauth.clients.create` is then the way in.
   * `initialAccessTokenHash`: the SHA-256 of an initial access token, as 64
   * lowercase hex characters. While it is set, the register route needs the
   * token as `Authorization: Bearer <token>` (RFC 7591 section 3).
   */
  registration?: { dynamic?: boolean; cimd?: boolean; initialAccessTokenHash?: string };
  /**
   * The fetch for a client metadata document, a client key set, and each
   * back-channel logout post: the app's own guarded fetch. It must refuse
   * private addresses (SSRF) for each of them. Core cannot resolve a name,
   * so a public name of a private address passes the host rule of core.
   * Required while `cimd` is on, and for a `backchannel_logout_uri`. Core
   * adds the timeout, the size cap, and `redirect: "manual"`.
   */
  fetch?: typeof fetch;
  /** The HTML of the consent page. Default `defaultConsentPage`. */
  consentPage?: (input: ConsentPageInput) => string;
  /** The life of an access token, 1 to 60. Default `jwtMint.ttlMinutes`. */
  accessTtlMinutes?: number;
  /** The life of a refresh token from its issue, 1 to 365. Default 30. */
  refreshTtlDays?: number;
  /** The life of an authorization code, 1 to 10. Default 5. */
  codeTtlMinutes?: number;
  /**
   * The resources that each introspection client may see, by client id
   * (plan 12e, RFC 7662 section 4). Each resource is an entry of
   * `resources`. Without the map, a client sees the one resource when
   * `resources` has one entry, and no resource when it has more.
   */
  introspection?: Record<string, string[]>;
  /**
   * DPoP of RFC 9449 (plan 12e). `algs`: the algs of a proof, distinct
   * values of EdDSA, Ed25519, ES256, RS256, and PS256; default all five.
   * `windowSeconds`: how far the `iat` of a proof may be from now, 10 to
   * 300; default 60. No key turns DPoP off: a client that sends no proof
   * pays nothing.
   */
  dpop?: { algs?: ForeignAlg[]; windowSeconds?: number };
  /**
   * The app's own sign-in route for the authorize step (plan 12e), in place
   * of `GET /oauth/sign-in`. An https URL on the origin of `baseURL`,
   * `appURL`, or an entry of `trustedOrigins`, or a path on `appURL`; no
   * query and no fragment. The browser comes to `<signInURL>?request_id=oq_…`.
   * After the sign-in, the app sends it to `continueAuthorizeURL` of
   * `@authtempo/client/oauth`.
   */
  signInURL?: string;
  /**
   * The refresh reuse window in seconds, 0 (off, the default) to 60 (plan
   * 12e). With it on, a spent refresh token that its own client presents
   * again within N seconds of its use answers a new child. The child of
   * the first use is then spent, so the family keeps one live branch.
   *
   * The odds. Without the window, a copy of a refresh token presented after
   * the client's own use deletes the family at once. Take a window of N
   * seconds. A copy presented within N seconds of the client's use gets an
   * access token and a refresh token. The holder of the copy can rotate
   * that refresh token until the client's next refresh. That refresh
   * presents the superseded child and deletes the family. So an attacker
   * who holds a copy has N seconds to act. Its access then lasts until the
   * client's next refresh, plus at most `accessTtlMinutes`. For a
   * confidential client or a bound refresh token, the copy is useless without
   * the secret or the key. The use: a client whose answer was lost on the
   * network retries and keeps its grant.
   *
   * RFC 9700 section 4.14.2 (read 2026-10-20) gives no grace period for
   * rotation, so the window is off by default.
   */
  refreshReuseSeconds?: number;
  /**
   * The device grant of RFC 8628 (plan 12e). Absent or `false`: off, and no
   * device route exists. `codeTtlMinutes`: the life of a device code and
   * its user code, 1 to 30; default 10. `interval`: the poll interval in
   * seconds, 5 to 60; default 5 (RFC 8628 section 3.2).
   */
  device?: false | { codeTtlMinutes?: number; interval?: number };
  /** The HTML of the device page. Default `defaultDevicePage`. */
  devicePage?: (input: DevicePageInput) => string;
}

/** The longest refresh reuse window: each second is a second an attacker with a copy can act (plan 12e). */
export const REUSE_WINDOW_MAX_S = 60;

export interface ResolvedOAuth {
  resources: readonly string[];
  /** The resource of a request that names none, or null: such a request answers `invalid_target` (plan 12e). */
  defaultResource: string | null;
  /** Name to text, the built-in four first. */
  scopes: ReadonlyMap<string, string>;
  dynamic: boolean;
  cimd: boolean;
  /** The SHA-256 hex of the initial access token of the register route, or null: no token (plan 12e). */
  initialAccessTokenHash: string | null;
  fetch: typeof fetch | null;
  consentPage: (input: ConsentPageInput) => string;
  accessTtlMinutes: number;
  refreshTtlDays: number;
  codeTtlMinutes: number;
  /** The resources of each introspection client, by client id, or null: no map (plan 12e). */
  introspection: ReadonlyMap<string, readonly string[]> | null;
  /** The algs and the window of a DPoP proof (plan 12e). */
  dpop: { algs: readonly ForeignAlg[]; windowSeconds: number };
  /** The absolute URL of the app's sign-in route, or null: core's own sign-in page (plan 12e). */
  signInURL: string | null;
  /** The refresh reuse window in seconds, 0 to `REUSE_WINDOW_MAX_S`; 0 is off (plan 12e). */
  refreshReuseSeconds: number;
  /** The device grant, or null: off (plan 12e). */
  device: { codeTtlMinutes: number; interval: number } | null;
  devicePage: (input: DevicePageInput) => string;
  /** The metadata documents this isolate read, by URL, each for one hour. */
  cimdCache: Map<string, CimdEntry>;
  /** The `jwks_uri` key sets of `private_key_jwt` clients that this isolate read, by URL, each for one hour (plan 12e). */
  jwksCache: Map<string, JwksEntry>;
}

export interface LegacyVerifyConfig {
  verify: (email: string, password: string, signal: AbortSignal) => Promise<boolean>;
  /**
   * 100 to 30000. Default 5000. While `legacyVerify` is set, every failed
   * password sign-in answers no earlier than this many milliseconds after its
   * check began, so a legacy row's network time does not tell an address with
   * a legacy row from an unknown one. The old system's deadline is the same
   * time, not `timeoutMs` from its call: core's lookups and dummy verify run
   * first, so `verify` gets a little less than `timeoutMs`. Set it longer
   * than the seam's dummy verify plus the old system's round trip; else
   * every check times out and every user gets `invalid_credentials`.
   */
  timeoutMs?: number;
}

export interface OrganizationsConfig {
  /** The rank form: a rank per role; core derives each role's permissions. Not with `roles`. */
  ranks?: Record<string, number>;
  /** The role form (plan 12k): a rank and the permissions per role. Not with `ranks`. */
  roles?: Record<string, { rank: number; permissions: Record<string, string[]> }>;
  /** The app's own resources and their actions, beside `CORE_STATEMENTS`. */
  statements?: Record<string, string[]>;
  reservedSlugs?: string[];
  platformOrganization?: string;
  platformRole?: string;
  invitationTtlDays?: number;
  /** The link in the invitation mail. Default `${appURL}/?invitation=<token>`. */
  invitationLinkBuilder?: (token: string, organization: { slug: string; name: string }) => string;
  limits?: OrganizationLimits;
  /**
   * Roles that each organization stores (plan 12k, spec 29 item 6). Absent:
   * off. `maxPerOrganization` is 1 to 1000, default 50.
   */
  dynamicRoles?: DynamicRolesConfig;
  /**
   * Teams inside each organization (plan 12k, spec 29 item 7). Absent: off.
   * A team has no role: every right comes from the organization role.
   */
  teams?: TeamsConfig;
}

/** The options of `organizations.teams` (plan 12k). Both default to false. */
export interface TeamsConfig {
  /** The create of an organization also creates one team named as the organization, with the creator in it. */
  defaultTeam?: boolean;
  /** The delete of the last team of an organization answers `last_team`. */
  keepLastTeam?: boolean;
}

/** The options of `organizations.dynamicRoles` (plan 12k). */
export interface DynamicRolesConfig {
  /** The role rows of one organization. A create at the cap answers `role_limit`. */
  maxPerOrganization?: number;
}

/** Each a positive integer. Absent: no limit (plan 9d). */
export interface OrganizationLimits {
  /** The member rows one user may hold, at any rank. Create answers `organization_limit` at it. */
  perUser?: number;
  /** The member rows one organization may hold. Add and accept answer `member_limit` at it. */
  membersPerOrganization?: number;
  /** The pending, unexpired invitations of one organization. Invite answers `invitation_limit` at it. */
  pendingInvitationsPerOrganization?: number;
  /** The teams of one organization (plan 12k). A team create answers `team_limit` at it. */
  teamsPerOrganization?: number;
  /** The member rows of one team (plan 12k). A team member add and an accept answer `team_member_limit` at it. */
  membersPerTeam?: number;
}

type ResolvedLimits = { [K in keyof OrganizationLimits]-?: number | null };

/** The API token options (plan 12k, spec 29 items 12 and 16). */
export interface TokensConfig {
  /**
   * The window of a new token that names none: `seconds` 1 to 86400 and
   * `max` 1 to 100000. Default null: no window. A token made through
   * `POST /tokens` or `POST /organizations/tokens` always gets it, because
   * those routes take no window.
   */
  defaultRateLimit?: LimitWindow | null;
  /**
   * The key prefixes of keys that moved into core's token table, such as
   * `laaa_` (rulings 4 and 12 of plan 12k). A bearer with one goes to the
   * hash lookup: a row acts as its token, and no row answers `token_retired`.
   * Each matches `^[a-z][a-z0-9]{0,15}_$` and never shadows a prefix of
   * `CORE_PREFIXES`.
   */
  movedPrefixes?: string[];
}

/** The SSO config (plan 12d, spec 30 item 1). */
export interface SsoConfig {
  /** OIDC connections (plan 12d Task 3). Off when absent. */
  oidc?: true;
  /** SAML connections (plan 12d Task 8). `clockSkewSeconds` is 0 to 300, default 120. */
  saml?: { clockSkewSeconds?: number } | true;
  /**
   * The DNS resolvers of the domain proof, each a `DnsTxtPort`. Required:
   * core has no default resolver (ruling 15 of plan 12d). Pass the presets
   * `dohCloudflare` and `dohGoogle` with your fetch, or your own ports.
   * Every resolver must give the value. Two resolvers: one resolver that
   * is wrong or compromised must not give a domain to an organization.
   */
  dns?: DnsTxtPort[];
  /** The fetch of the IdP calls. Core wraps it so that no redirect is followed (plan 12b). */
  fetch?: typeof fetch;
  /** Default 10 connections and 20 domains per organization. Each is a positive integer. */
  limits?: { connectionsPerOrganization?: number; domainsPerOrganization?: number };
}

/** The SSO config after construction (plan 12d). */
export interface ResolvedSso {
  oidc: boolean;
  saml: { clockSkewSeconds: number } | null;
  dns: readonly DnsTxtPort[];
  fetch: typeof fetch;
  limits: { connectionsPerOrganization: number; domainsPerOrganization: number };
}

export interface ResolvedConfig {
  basePath: string;
  baseURL: string;
  appName: string;
  /** The app secrets by version (plan 12b). No code reads one secret string: each read names its version. */
  keyring: Keyring;
  trustedOrigins: ReadonlySet<string>;
  appURL: string;
  cookie: { sameSite: "Lax" | "None" };
  storage: StorageAdapter;
  mail: MailPort;
  limiter: LimiterPort;
  clientIp: (request: Request) => string | null;
  clock: Clock;
  cookieName: string;
  /** The old session cookie that the router moves, or null when `cookieName` is not the default (plan 12b). */
  legacyCookieName: string | null;
  session: {
    ttlDays: number;
    slidingRefreshDays: number;
    absoluteDays: number | null;
    freshMinutes: number;
    deferRefresh: boolean;
  };
  magicLink: {
    ttlMinutes: number;
    linkBuilder: (token: string, next: string) => string;
    confirmPage: (input: ConfirmPageInput) => string;
  };
  social: { providers: ConfiguredProvider[]; fetch: typeof fetch };
  jwt: JwtSeam;
  passkey: { rpID: string; rpName: string; origins: string[] } | null;
  webauthn: WebAuthnSeam;
  handoff: {
    schemes: string[];
    devRedirectPattern: RegExp | null;
    signInPage: (input: SignInPageInput) => string;
    confirmPage: (input: HandoffConfirmPageInput) => string;
  } | null;
  organizations: {
    /** From `ranks`, or the rank of each role of `roles`. */
    ranks: Readonly<Record<string, number>>;
    /** From `roles`, or `deriveRoles(ranks)`. */
    roles: RoleTable;
    /** `CORE_STATEMENTS` and the app's own: the known set. */
    statements: Statements;
    reservedSlugs: ReadonlySet<string>;
    platformOrganization: string | null;
    platformRole: string | null;
    invitationTtlDays: number;
    invitationLinkBuilder: (token: string, organization: { slug: string; name: string }) => string;
    limits: ResolvedLimits;
    /** Null: dynamic roles are off, and no read of a role row runs (plan 12k). */
    dynamicRoles: { maxPerOrganization: number } | null;
    /** Null: teams are off, and no team route is mounted (plan 12k). */
    teams: { defaultTeam: boolean; keepLastTeam: boolean } | null;
  } | null;
  tokens: { defaultRateLimit: LimitWindow | null; movedPrefixes: readonly string[] };
  signUp: "open" | "invited" | false;
  password: {
    hash: PasswordHashSeam;
    minLength: number;
    breachCheck: ((plain: string) => Promise<boolean | "unavailable">) | null;
    resetTtlMinutes: number;
    resetPage: (input: ResetPageInput) => string;
    legacyVerify: Required<LegacyVerifyConfig> | null;
    requireVerified: boolean;
    uniformSignUp: boolean;
    existingAccountMail: (input: ExistingAccountMailInput) => MailMessage;
  } | null;
  emailOtp: ResolvedEmailOtp | null;
  totp: ResolvedTotp | null;
  jwtMint: ResolvedJwtMint | null;
  oauth: ResolvedOAuth | null;
  operator: ResolvedOperator | null;
  /** Null: SSO is off, and no SSO route is mounted (plan 12d). */
  sso: ResolvedSso | null;
  openapi: boolean;
  hooks: ResolvedHooks;
  account: ResolvedAccount;
  captcha: ResolvedCaptcha | null;
  /** The observer of this instance (plan 12h). With no `observe` config it sends nothing anywhere. */
  observe: Observer;
  observeConfig: ResolvedObserve | null;
  /**
   * The identity of this instance (plan 12h). The router copies the config
   * for each request, and each copy keeps this object. So a cache of the
   * instance keys on it, not on the config object.
   */
  instance: object;
  /**
   * The key paths of the input, sorted, for `GET /operator/info` (plan
   * 11c2): each top key that `AUTH_CONFIG_KEYS` names, and `<key>.<sub>`
   * under each option block of `CONFIG_BLOCKS`. Names only, never a value.
   */
  configKeys: readonly string[];
}

/**
 * The default client IP. On Workers the platform sets `cf-connecting-ip` and
 * a caller cannot forge it. `x-forwarded-for` is not read, because a caller
 * sets it freely. Null when the header is absent.
 */
export function workersClientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip") || null;
}

const DEFAULT_RANKS = { viewer: 1, member: 2, admin: 3, owner: 4 };

/** The known statement set: `CORE_STATEMENTS` and the app's own resources (plan 12k). */
function resolveStatements(input: Record<string, string[]> | undefined): Statements {
  if (input === undefined) return union(CORE_STATEMENTS);
  if (!isPlainObject(input)) throw new ConfigError("organizations.statements must be an object");
  for (const [name, actions] of Object.entries(input)) {
    // A core resource keeps core's actions, so an app cannot widen or rename them.
    if (Object.hasOwn(CORE_STATEMENTS, name))
      throw new ConfigError(`organizations.statements.${name} is a core resource`);
    if (!NAME_RE.test(name))
      throw new ConfigError(`organizations.statements has a bad resource name: ${name}`);
    if (!Array.isArray(actions) || actions.length === 0)
      throw new ConfigError(`organizations.statements.${name} must list at least one action`);
    for (const [i, action] of actions.entries()) {
      if (typeof action !== "string" || !NAME_RE.test(action))
        throw new ConfigError(
          `organizations.statements.${name} has a bad action name: ${String(action)}`,
        );
      if (actions.indexOf(action) !== i)
        throw new ConfigError(`organizations.statements.${name} repeats ${action}`);
    }
  }
  return union(CORE_STATEMENTS, input);
}

/**
 * The two role forms (plan 12k). `ranks` derives the permissions of each role;
 * `roles` names them. One form only, so no rank and no right has two sources.
 */
function resolveRoleForms(
  o: OrganizationsConfig,
  known: Statements,
): { ranks: Record<string, number>; roles: RoleTable } {
  if (o.ranks !== undefined && o.roles !== undefined)
    throw new ConfigError("organizations takes ranks or roles, not both");
  if (o.roles === undefined) {
    const ranks = o.ranks ?? DEFAULT_RANKS;
    checkRanks(ranks, "ranks");
    return { ranks, roles: deriveRoles(ranks) };
  }
  if (!isPlainObject(o.roles)) throw new ConfigError("organizations.roles must be an object");
  const entries = Object.entries(o.roles);
  for (const [name, def] of entries)
    if (!isPlainObject(def)) throw new ConfigError(`organizations.roles.${name} must be an object`);
  // fromEntries defines each key as an own property, so a role name such as `__proto__` stays data.
  const ranks = Object.fromEntries(entries.map(([name, def]) => [name, def.rank]));
  checkRanks(ranks, "roles");
  const roles = new Map<string, RoleDef>();
  for (const [name, def] of entries) {
    const fault = statementFault(def.permissions, known);
    if (fault !== null) throw new ConfigError(`organizations.roles.${name}.permissions: ${fault}`);
    roles.set(name, { rank: def.rank, permissions: union(def.permissions) });
  }
  return { ranks, roles: Object.fromEntries(roles) };
}

/** The name rule, the rank rule, and the owner rule of either form. */
function checkRanks(ranks: Record<string, number>, form: "ranks" | "roles"): void {
  for (const [role, rank] of Object.entries(ranks)) {
    if (!ROLE_RE.test(role) || role.includes(","))
      throw new ConfigError(`organizations.${form} has a bad role name: ${role}`);
    const where = form === "ranks" ? `ranks.${role}` : `roles.${role}.rank`;
    if (!Number.isSafeInteger(rank) || rank < 1)
      throw new ConfigError(`organizations.${where} must be a positive integer`);
  }
  // The create path makes the creator owner, and the last-owner rule reads that rank.
  if (!Object.hasOwn(ranks, "owner"))
    throw new ConfigError(`organizations.${form} must name owner`);
}
/**
 * Exported for the importer (plan 9b), which refuses the same slugs. One list
 * for both. Frozen: `resolveConfig` reads it on every call, so a caller that
 * empties it would let an organization take `admin` or `auth`.
 */
export const DEFAULT_RESERVED_SLUGS: readonly string[] = Object.freeze([
  "admin",
  "api",
  "auth",
  "internal",
  "operator",
  "ops",
  "platform",
  "system",
  "www",
]);

const APP_NAME_MAX = 80;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\/$/;

/**
 * An app scheme such as `myapp://`, the form `handoff.schemes` takes. A bare
 * `http://` or `https://` is not one. The one copy of this rule: the
 * Better Auth compatibility package reads its app schemes with it (plan 9).
 */
export function isAppScheme(s: string): boolean {
  return SCHEME_RE.test(s) && s !== "http://" && s !== "https://";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Applies defaults and refuses a config that cannot keep the security rules. */
export function resolveConfig(input: AuthConfig): ResolvedConfig {
  const keyring = resolveSecrets(input.secret, input.secrets);
  let origin: URL;
  try {
    origin = new URL(input.baseURL);
  } catch {
    throw new ConfigError("baseURL must be an absolute URL");
  }
  if (origin.pathname !== "/" || input.baseURL.endsWith("/") || origin.search || origin.hash) {
    throw new ConfigError("baseURL must be an origin with no path and no trailing slash");
  }
  // The public document of `GET /openapi.json` names this origin, so a password here would leak.
  if (origin.username || origin.password)
    throw new ConfigError("baseURL must have no user name and no password");
  const appName = input.appName ?? origin.host;
  // The name goes into a mail subject, so a CR or LF would inject a header.
  if (appName.length < 1 || appName.length > APP_NAME_MAX || hasControlChar(appName))
    throw new ConfigError(
      `appName must be 1 to ${APP_NAME_MAX} characters with no control character`,
    );
  for (const o of input.trustedOrigins) {
    if (o.includes("*")) throw new ConfigError(`trustedOrigins has a wildcard: ${o}`);
  }
  const appURL = input.appURL ?? input.baseURL;
  if (appURL !== input.baseURL) {
    let app: URL;
    try {
      app = new URL(appURL);
    } catch {
      throw new ConfigError("appURL must be an absolute URL");
    }
    if (app.origin !== appURL)
      throw new ConfigError("appURL must be an exact origin, no path and no trailing slash");
    if (!input.trustedOrigins.includes(appURL)) {
      throw new ConfigError(`appURL ${appURL} must be baseURL or a member of trustedOrigins`);
    }
  }
  const sameSite = input.cookie?.sameSite ?? "Lax";
  if (sameSite !== "Lax" && sameSite !== "None")
    throw new ConfigError("cookie.sameSite must be Lax or None");
  let handoff: ResolvedConfig["handoff"] = null;
  if (input.handoff) {
    if (input.handoff.schemes.length === 0)
      throw new ConfigError("handoff.schemes must not be empty");
    for (const s of input.handoff.schemes) {
      if (!isAppScheme(s))
        throw new ConfigError(
          SCHEME_RE.test(s)
            ? `handoff.schemes must not hold ${s}`
            : `handoff.schemes entry must be like app://, got ${s}`,
        );
    }
    const pattern = input.handoff.devRedirectPattern;
    // A global or sticky regex keeps state between test calls and alternates its answer.
    if (pattern && (pattern.flags.includes("g") || pattern.flags.includes("y")))
      throw new ConfigError("handoff.devRedirectPattern must not use the g or y flag");
    handoff = {
      schemes: [...input.handoff.schemes],
      devRedirectPattern: input.handoff.devRedirectPattern ?? null,
      signInPage: input.handoff.signInPage ?? defaultSignInPage,
      confirmPage: input.handoff.confirmPage ?? defaultHandoffConfirmPage,
    };
  }
  let organizations: ResolvedConfig["organizations"] = null;
  if (input.organizations) {
    const o = input.organizations;
    const statements = resolveStatements(o.statements);
    const forms = resolveRoleForms(o, statements);
    const ranks = forms.ranks;
    const reserved = new Set<string>();
    for (const s of o.reservedSlugs ?? DEFAULT_RESERVED_SLUGS) {
      const n = normalizeSlug(s);
      if (n === null)
        throw new ConfigError(`organizations.reservedSlugs entry is not a slug: ${s}`);
      reserved.add(n);
    }
    let platformOrganization: string | null = null;
    if (o.platformOrganization !== undefined) {
      platformOrganization = normalizeSlug(o.platformOrganization);
      if (platformOrganization === null)
        throw new ConfigError("organizations.platformOrganization is not a slug");
      // The app seeds the platform organization through storage or a migration. Nobody creates
      // it or renames into it through the engine, so no user can own a slug the platform role trusts.
      reserved.add(platformOrganization);
    }
    let platformRole: string | null = null;
    if (o.platformRole !== undefined) {
      if (!Object.hasOwn(ranks, o.platformRole))
        throw new ConfigError("organizations.platformRole must be a name of roles or ranks");
      if (platformOrganization === null)
        throw new ConfigError(
          "organizations.platformRole needs organizations.platformOrganization",
        );
      platformRole = o.platformRole;
    }
    const ttl = o.invitationTtlDays ?? 7;
    if (!Number.isSafeInteger(ttl) || ttl < 1)
      throw new ConfigError("organizations.invitationTtlDays must be a positive integer");
    organizations = {
      ranks: { ...ranks },
      roles: forms.roles,
      statements,
      reservedSlugs: reserved,
      platformOrganization,
      platformRole,
      invitationTtlDays: ttl,
      invitationLinkBuilder:
        o.invitationLinkBuilder ??
        ((token) => `${appURL}/?invitation=${encodeURIComponent(token)}`),
      limits: resolveLimits(o.limits),
      dynamicRoles: resolveDynamicRoles(o.dynamicRoles),
      teams: resolveTeams(o.teams),
    };
  }
  const basePath = input.basePath ?? DEFAULT_BASE_PATH;
  if (!basePath.startsWith("/") || basePath.endsWith("/")) {
    throw new ConfigError("basePath must start with / and not end with /");
  }
  // The router reads a segment that starts with ":" as a path parameter (plan 12d).
  if (basePath.split("/").some((segment) => segment.startsWith(":"))) {
    throw new ConfigError("basePath must not hold a segment that starts with :");
  }
  const clock = input.clock ?? systemClock;
  const providers = socialProviders(input.social);
  // A caller's fetch must be callable without a receiver. The engine calls it as a plain function.
  // Every provider call goes through providerFetch: no redirect is followed
  // (plan 12b). The jose seam gets the same fetch, so the JWKS read has the
  // rule twice: jose's own and ours.
  const fetchFn = providerFetch(input.social?.fetch ?? globalThis.fetch.bind(globalThis));
  let passkey: ResolvedConfig["passkey"] = null;
  if (input.passkey) {
    requireFields("passkey", input.passkey, ["rpID", "rpName"]);
    if (input.passkey.origins.length === 0)
      throw new ConfigError("passkey.origins must not be empty");
    for (const o of input.passkey.origins) {
      let u: URL;
      try {
        u = new URL(o);
      } catch {
        throw new ConfigError(`passkey.origins has a value that is not a URL: ${o}`);
      }
      if (u.origin !== o)
        throw new ConfigError(`passkey.origins must hold exact origins, no path: ${o}`);
      const host = u.hostname;
      const rp = input.passkey.rpID;
      if (host !== rp && !host.endsWith(`.${rp}`)) {
        throw new ConfigError(`passkey.origins host ${host} is not on rpID ${rp}`);
      }
      // The router answers 403 to a post from an origin that is not trusted, so an
      // origin the passkey config accepts but the router refuses is a silent break.
      if (o !== input.baseURL && !input.trustedOrigins.includes(o)) {
        throw new ConfigError(
          `passkey.origins has ${o}, which is neither baseURL nor in trustedOrigins; add it to trustedOrigins or the router answers 403 to its posts`,
        );
      }
    }
    passkey = {
      rpID: input.passkey.rpID,
      rpName: input.passkey.rpName,
      origins: [...input.passkey.origins],
    };
  }
  let password: ResolvedConfig["password"] = null;
  if (input.password) {
    const p = input.password;
    const minLength = p.minLength ?? 8;
    if (!Number.isSafeInteger(minLength) || minLength < 8 || minLength > PASSWORD_MAX_LENGTH)
      throw new ConfigError(
        `password.minLength must be an integer from 8 to ${PASSWORD_MAX_LENGTH}`,
      );
    const resetTtlMinutes = p.resetTtlMinutes ?? 15;
    if (!Number.isSafeInteger(resetTtlMinutes) || resetTtlMinutes < 1 || resetTtlMinutes > 1440)
      throw new ConfigError("password.resetTtlMinutes must be an integer from 1 to 1440");
    let legacyVerify: Required<LegacyVerifyConfig> | null = null;
    if (p.legacyVerify) {
      const timeoutMs = p.legacyVerify.timeoutMs ?? 5000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
        throw new ConfigError(
          "password.legacyVerify.timeoutMs must be an integer from 100 to 30000",
        );
      if (typeof p.legacyVerify.verify !== "function")
        throw new ConfigError("password.legacyVerify.verify must be a function");
      legacyVerify = { verify: p.legacyVerify.verify, timeoutMs };
    }
    // Default false: see `PasswordConfig.requireVerified`.
    const requireVerified = p.requireVerified ?? false;
    if (typeof requireVerified !== "boolean")
      throw new ConfigError("password.requireVerified must be a boolean");
    if (p.uniformSignUp !== undefined && typeof p.uniformSignUp !== "boolean")
      throw new ConfigError("password.uniformSignUp must be a boolean");
    if (p.existingAccountMail !== undefined && typeof p.existingAccountMail !== "function")
      throw new ConfigError("password.existingAccountMail must be a function");
    password = {
      hash: p.hash ?? createPbkdf2PasswordHash(),
      minLength,
      breachCheck: p.breachCheck ?? null,
      resetTtlMinutes,
      resetPage: p.resetPage ?? defaultResetPage,
      legacyVerify,
      requireVerified,
      uniformSignUp: p.uniformSignUp ?? true,
      existingAccountMail: p.existingAccountMail ?? defaultExistingAccountMail,
    };
  }
  const signUp = input.signUp ?? "open";
  if (signUp !== "open" && signUp !== "invited" && signUp !== false)
    throw new ConfigError('signUp must be "open", "invited", or false');
  if (signUp === "invited" && !organizations)
    throw new ConfigError("signUp invited needs organizations: an invitation is the only way in");
  // One source for the session cookie names: the trust cookie check of `totp` reads them too.
  const { cookieName, legacyCookieName } = sessionCookieNames(input.cookieName);
  const jwtMint = resolveJwtMint(input.jwtMint, input.baseURL);
  if (input.openapi !== undefined && typeof input.openapi !== "boolean")
    throw new ConfigError("openapi must be true or false");
  const openapi = input.openapi ?? false;
  const observeConfig = resolveObserve(input.observe);
  return {
    basePath,
    baseURL: input.baseURL,
    appName,
    keyring,
    trustedOrigins: new Set(input.trustedOrigins),
    appURL,
    cookie: { sameSite },
    storage: input.storage,
    mail: input.mail,
    limiter: input.limiter ?? createMemoryLimiter(clock),
    clientIp: input.clientIp ?? workersClientIp,
    clock,
    cookieName,
    legacyCookieName,
    session: resolveSessionConfig(input.session),
    magicLink: {
      ttlMinutes: input.magicLink?.ttlMinutes ?? 15,
      linkBuilder:
        input.magicLink?.linkBuilder ??
        ((token) =>
          `${input.baseURL}${basePath}/magic-link/verify?token=${encodeURIComponent(token)}`),
      confirmPage: input.magicLink?.confirmPage ?? defaultConfirmPage,
    },
    social: { providers, fetch: fetchFn },
    jwt: input.jwt ?? createJoseJwtSeam(fetchFn),
    passkey,
    webauthn: input.webauthn ?? createSimpleWebAuthnSeam(),
    handoff,
    organizations,
    tokens: resolveTokens(input.tokens),
    signUp,
    password,
    emailOtp: resolveEmailOtp(input.emailOtp),
    totp: resolveTotp(input.totp, password !== null, input.appName ?? origin.hostname, cookieName),
    jwtMint,
    oauth: resolveOAuth(input.oauth, jwtMint, {
      baseURL: input.baseURL,
      appURL,
      trustedOrigins: input.trustedOrigins,
    }),
    operator: resolveOperator(input.operator, organizations?.platformRole ?? null),
    sso: resolveSso(input.sso, organizations !== null),
    openapi,
    // The operator key resolved above, so `users` is true or absent here.
    hooks: resolveHooks(
      input.hooks,
      organizations !== null,
      typeof input.operator === "object" && input.operator.users === true,
    ),
    account: resolveAccount(input.account),
    captcha: resolveCaptcha(
      input.captcha,
      // Core's own sign-in page serves the handoff and the OAuth login step,
      // unless the app gives handoff.signInPage.
      (handoff !== null || (input.oauth !== undefined && input.oauth !== false)) &&
        input.handoff?.signInPage === undefined,
      password !== null,
    ),
    observe: observeConfig
      ? createObserver(observeConfig, {
          clock,
          hashSecret: () => currentSecret(keyring),
          secrets: secretValues(keyring, input.social),
        })
      : createDefaultObserver({ clock, secrets: secretValues(keyring, input.social) }),
    observeConfig,
    instance: Object.freeze({}),
    configKeys: configKeyPaths(input),
  };
}

function resolveTokens(input: TokensConfig | undefined): ResolvedConfig["tokens"] {
  const window = input?.defaultRateLimit ?? null;
  if (window !== null && !validWindow(window))
    throw new ConfigError(
      `tokens.defaultRateLimit must have whole seconds from 1 to ${WINDOW_SECONDS_MAX} and a whole max from 1 to ${WINDOW_CALLS_MAX}`,
    );
  const moved: string[] = [];
  for (const p of input?.movedPrefixes ?? []) {
    const fault = movedPrefixFault(p);
    if (fault === "form") throw new ConfigError(`tokens.movedPrefixes has a bad prefix: ${p}`);
    if (fault === "shadow")
      throw new ConfigError(`tokens.movedPrefixes must not shadow a core prefix: ${p}`);
    if (moved.includes(p)) throw new ConfigError(`tokens.movedPrefixes repeats ${p}`);
    moved.push(p);
  }
  return { defaultRateLimit: window === null ? null : { ...window }, movedPrefixes: moved };
}

function requireFields<T extends object>(path: string, obj: T, keys: (keyof T & string)[]): void {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v !== "string" || v.length === 0)
      throw new ConfigError(`${path}.${key} must be a non-empty string`);
  }
}

const LABEL_MAX = 80;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `undefined` gives an empty list. A value that is not an array, or an
 * entry that is not an object, throws: the checks below read the entry's
 * fields, and a null entry would throw a TypeError with no path.
 */
function listOf<T>(path: string, value: T[] | undefined): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be a list`);
  for (const [i, entry] of value.entries())
    if (!isPlainObject(entry)) throw new ConfigError(`${path}[${i}] must be an object`);
  return value;
}

/** The shortest secret value, in UTF-16 code units, as before plan 12b. */
const SECRET_MIN_LENGTH = 32;

/**
 * The scrub list of the events (spec 31 item 9). It holds each
 * secret string of the config: each keyring value, each social client
 * secret, and the Apple private key. It also holds the parts of each value
 * that a driver can print. The observer scrubs each event with it, with or
 * without a sink. The event recorder of the tests reads it as its deny list
 * of secrets (plan 12h Task 12).
 */
export function secretValues(keyring: Keyring, social: AuthConfig["social"]): ReadonlySet<string> {
  const strings: unknown[] = [
    ...keyring.versions.map((version) => keyring.valueOf(version)),
    social?.google?.clientSecret,
    social?.apple?.privateKey,
    social?.github?.clientSecret,
    social?.linkedin?.clientSecret,
    ...(social?.oidc ?? []).map((e) => e.clientSecret),
    ...(social?.oauth2 ?? []).map((e) => e.clientSecret),
  ];
  const values = new Set<string>();
  for (const value of strings)
    if (typeof value === "string") for (const part of secretParts(value)) values.add(part);
  return values;
}

/**
 * `secret` and `secrets` as one keyring (plan 12b, spec 22). The rules:
 * one of the two at least; a version is an integer from 1 to 999999; no
 * version and no value twice; with both keys, `secret` is version 1. The
 * entropy rule refuses only the current value: a weak old version gets one
 * warning line, because a refusal would block the move away from it.
 */
function resolveSecrets(secret: unknown, secrets: unknown): Keyring {
  if (secret === undefined && secrets === undefined)
    throw new ConfigError("secret or secrets is required");
  if (secret !== undefined && typeof secret !== "string")
    throw new ConfigError("secret must be a string");
  const entries: Array<SecretVersion & { path: string; index: number | null }> = [];
  if (secrets !== undefined) {
    if (!Array.isArray(secrets) || secrets.length < 1)
      throw new ConfigError("secrets must be a list of 1 or more { version, value } entries");
    for (const [i, entry] of secrets.entries()) {
      if (!isPlainObject(entry)) throw new ConfigError(`secrets[${i}] must be an object`);
      for (const key of Object.keys(entry))
        if (key !== "version" && key !== "value")
          throw new ConfigError(
            `secrets[${i}].${key} is not an option; an entry has version and value`,
          );
      const { version, value } = entry;
      if (
        typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        version > SECRET_VERSION_MAX
      )
        throw new ConfigError(
          `secrets[${i}].version must be an integer from 1 to ${SECRET_VERSION_MAX}`,
        );
      if (typeof value !== "string") throw new ConfigError(`secrets[${i}].value must be a string`);
      entries.push({ version, value, path: `secrets[${i}]`, index: i });
    }
  }
  if (secret !== undefined) {
    const one = entries.find((e) => e.version === 1);
    if (one && one.value !== secret)
      throw new ConfigError(
        "secret and secrets version 1 hold different values; give the old secret once, as version 1",
      );
    if (!one) entries.push({ version: 1, value: secret, path: "secret", index: null });
  }
  const seen = new Set<number>();
  for (const e of entries) {
    if (seen.has(e.version)) throw new ConfigError(`secrets has version ${e.version} twice`);
    seen.add(e.version);
  }
  if (new Set(entries.map((e) => e.value)).size !== entries.length)
    throw new ConfigError(
      "secrets has one value under two versions; each version needs its own value",
    );
  for (const e of entries)
    if (e.value.length < SECRET_MIN_LENGTH)
      throw new ConfigError(
        `${e.path === "secret" ? "secret" : `${e.path}.value`} must be at least ${SECRET_MIN_LENGTH} characters`,
      );
  for (const [i, e] of entries.entries()) {
    const bits = Math.floor(entropyBits(e.value));
    // The message names the key and the estimate, never the value.
    if (i === 0 && bits < ENTROPY_REFUSE_BITS)
      throw new ConfigError(
        `${e.path} has an estimated ${bits} bits of entropy; at least ${ENTROPY_REFUSE_BITS} are required. Make a new one with 32 random bytes, for example: openssl rand -base64 32`,
      );
    if (bits < ENTROPY_WARN_BITS)
      writeConstructionLine(
        { name: "secret.low_entropy", bits, ...(e.index === null ? {} : { secretIndex: e.index }) },
        new Set(entries.flatMap((x) => secretParts(x.value))),
      );
  }
  return createKeyring(entries.map(({ version, value }) => ({ version, value })));
}

const NO_LIMITS: ResolvedLimits = {
  perUser: null,
  membersPerOrganization: null,
  pendingInvitationsPerOrganization: null,
  teamsPerOrganization: null,
  membersPerTeam: null,
};

const SESSION_KEYS: Readonly<Record<keyof NonNullable<AuthConfig["session"]>, true>> = {
  ttlDays: true,
  slidingRefreshDays: true,
  absoluteDays: true,
  freshMinutes: true,
  deferRefresh: true,
};

/**
 * `session`. ttlDays and slidingRefreshDays keep the defaults of version 1.
 * absoluteDays is off by default (plan 12b). freshMinutes is 1440 by default
 * (plan 12a). deferRefresh is off by default (plan 12a, see `AuthConfig.session.deferRefresh`).
 */
function resolveSessionConfig(input: AuthConfig["session"]): ResolvedConfig["session"] {
  const o = input ?? {};
  for (const [key, value] of Object.entries(o))
    if (value !== undefined && !Object.hasOwn(SESSION_KEYS, key))
      throw new ConfigError(
        `session.${key} is not an option; core has ttlDays, slidingRefreshDays, absoluteDays, freshMinutes, and deferRefresh`,
      );
  const { absoluteDays } = o;
  if (
    absoluteDays !== undefined &&
    (typeof absoluteDays !== "number" ||
      !Number.isSafeInteger(absoluteDays) ||
      absoluteDays < 1 ||
      absoluteDays > 365)
  )
    throw new ConfigError("session.absoluteDays must be an integer from 1 to 365");
  if (o.deferRefresh !== undefined && typeof o.deferRefresh !== "boolean")
    throw new ConfigError("session.deferRefresh must be a boolean");
  return {
    ttlDays: o.ttlDays ?? 30,
    slidingRefreshDays: o.slidingRefreshDays ?? 7,
    absoluteDays: absoluteDays ?? null,
    freshMinutes: integerIn("session.freshMinutes", o.freshMinutes ?? 1440, 1, 1440),
    deferRefresh: o.deferRefresh ?? false,
  };
}

/** `organizations.dynamicRoles` (plan 12k). Absent: off. */
function resolveDynamicRoles(
  input: DynamicRolesConfig | undefined,
): { maxPerOrganization: number } | null {
  if (input === undefined) return null;
  if (!isPlainObject(input)) throw new ConfigError("organizations.dynamicRoles must be an object");
  for (const key of Object.keys(input))
    if (key !== "maxPerOrganization")
      throw new ConfigError(
        `organizations.dynamicRoles.${key} is not an option; core has maxPerOrganization`,
      );
  // Only `undefined` means the default: a `null` from a JS caller is refused.
  const given: unknown = (input as DynamicRolesConfig).maxPerOrganization;
  const max = given === undefined ? 50 : given;
  const path = "organizations.dynamicRoles.maxPerOrganization";
  if (typeof max !== "number") throw new ConfigError(`${path} must be an integer from 1 to 1000`);
  return { maxPerOrganization: integerIn(path, max, 1, 1000) };
}

const TEAMS_KEYS: Readonly<Record<keyof TeamsConfig, true>> = {
  defaultTeam: true,
  keepLastTeam: true,
};

/** `organizations.teams` (plan 12k). Absent: off. */
function resolveTeams(
  input: TeamsConfig | undefined,
): { defaultTeam: boolean; keepLastTeam: boolean } | null {
  if (input === undefined) return null;
  if (!isPlainObject(input)) throw new ConfigError("organizations.teams must be an object");
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!Object.hasOwn(TEAMS_KEYS, key))
      throw new ConfigError(
        `organizations.teams.${key} is not an option; core has defaultTeam and keepLastTeam`,
      );
    if (value !== undefined && typeof value !== "boolean")
      throw new ConfigError(`organizations.teams.${key} must be a boolean`);
  }
  const t = input as TeamsConfig;
  return { defaultTeam: t.defaultTeam ?? false, keepLastTeam: t.keepLastTeam ?? false };
}

function resolveLimits(input: OrganizationLimits | undefined): ResolvedLimits {
  const out: ResolvedLimits = { ...NO_LIMITS };
  if (input === undefined) return out;
  if (!isPlainObject(input)) throw new ConfigError("organizations.limits must be an object");
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(NO_LIMITS, key))
      throw new ConfigError(
        `organizations.limits.${key} is not a limit; core has perUser, membersPerOrganization, pendingInvitationsPerOrganization, teamsPerOrganization, and membersPerTeam`,
      );
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
      throw new ConfigError(`organizations.limits.${key} must be a positive integer`);
    out[key as keyof ResolvedLimits] = value;
  }
  return out;
}

const EMAIL_OTP_KEYS: Readonly<Record<keyof EmailOtpConfig, true>> = {
  ttlMinutes: true,
  length: true,
  maxAttempts: true,
  mail: true,
  resetMail: true,
};

/** `emailOtp` (plan 9e). Absent: on, with the defaults. `false`: off. */
function resolveEmailOtp(input: EmailOtpConfig | false | undefined): ResolvedEmailOtp | null {
  if (input === false) return null;
  // Only `undefined` means the defaults: `null` from a JS caller or a JSON
  // config must not turn the feature on, so it falls to the guard below.
  const o: EmailOtpConfig = input === undefined ? {} : input;
  // `as unknown`: the guard must not narrow `o`, or its fields lose their types.
  if (!isPlainObject(o as unknown)) throw new ConfigError("emailOtp must be an object or false");
  for (const [key, value] of Object.entries(o))
    if (value !== undefined && !Object.hasOwn(EMAIL_OTP_KEYS, key))
      throw new ConfigError(
        `emailOtp.${key} is not an option; core has ttlMinutes, length, maxAttempts, mail, and resetMail`,
      );
  const ttlMinutes = o.ttlMinutes ?? 10;
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 60)
    throw new ConfigError("emailOtp.ttlMinutes must be an integer from 1 to 60");
  const length = o.length ?? 6;
  if (length !== 6 && length !== 8) throw new ConfigError("emailOtp.length must be 6 or 8");
  const maxAttempts = o.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 3 || maxAttempts > 10)
    throw new ConfigError("emailOtp.maxAttempts must be an integer from 3 to 10");
  for (const key of ["mail", "resetMail"] as const)
    if (o[key] !== undefined && typeof o[key] !== "function")
      throw new ConfigError(`emailOtp.${key} must be a function`);
  return {
    ttlMinutes,
    length,
    maxAttempts,
    mail: o.mail ?? defaultEmailOtpMail,
    resetMail: o.resetMail ?? defaultResetOtpMail,
  };
}

/** The keys of `account`. A Record, so a key added to `AccountConfig` and not listed here fails the compile. */
const ACCOUNT_KEYS: Readonly<Record<keyof AccountConfig, true>> = {
  mail: true,
  notices: true,
  confirmPage: true,
  delete: true,
  deleteConfirm: true,
};

/** `account` (plan 12a). Absent: the defaults. A key that core does not know is refused by name. */
function resolveAccount(input: AccountConfig | undefined): ResolvedAccount {
  const o: AccountConfig = input === undefined ? {} : input;
  // `as unknown`: the guard must not narrow `o`, or its fields lose their types.
  if (!isPlainObject(o as unknown)) throw new ConfigError("account must be an object");
  for (const [key, value] of Object.entries(o))
    if (value !== undefined && !Object.hasOwn(ACCOUNT_KEYS, key))
      throw new ConfigError(
        `account.${key} is not an option; core has ${Object.keys(ACCOUNT_KEYS).join(", ")}`,
      );
  if (o.mail !== undefined && typeof o.mail !== "function")
    throw new ConfigError("account.mail must be a function");
  if (o.confirmPage !== undefined && typeof o.confirmPage !== "function")
    throw new ConfigError("account.confirmPage must be a function");
  if (o.delete !== undefined && typeof o.delete !== "boolean")
    throw new ConfigError("account.delete must be a boolean");
  return {
    mail: o.mail ?? defaultAccountMail,
    notices: resolveNotices(o.notices),
    confirmPage: o.confirmPage ?? defaultEmailChangePage,
    delete: o.delete ?? true,
    deleteConfirm: resolveDeleteConfirm(o.deleteConfirm),
  };
}

/** The keys of `account.deleteConfirm`. A Record, so a new key of `AccountDeleteConfirmConfig` fails the compile here. */
const DELETE_CONFIRM_KEYS: Readonly<Record<keyof AccountDeleteConfirmConfig, true>> = {
  ttlMinutes: true,
};

/** `account.deleteConfirm`. Absent or `false`: off. */
function resolveDeleteConfirm(
  input: AccountDeleteConfirmConfig | false | undefined,
): ResolvedAccount["deleteConfirm"] {
  if (input === undefined || input === false) return null;
  // `as unknown`: the guard must not narrow `input`, or its fields lose their types.
  if (!isPlainObject(input as unknown))
    throw new ConfigError("account.deleteConfirm must be an object or false");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && !Object.hasOwn(DELETE_CONFIRM_KEYS, key))
      throw new ConfigError(
        `account.deleteConfirm.${key} is not an option; core has ${Object.keys(DELETE_CONFIRM_KEYS).join(", ")}`,
      );
  const t = DELETE_CONFIRM_TTL_MINUTES;
  return {
    ttlMinutes: integerIn(
      "account.deleteConfirm.ttlMinutes",
      input.ttlMinutes ?? t.default,
      t.min,
      t.max,
    ),
  };
}

/** The keys of `account.notices`. A Record, so a key added to `AccountNoticesConfig` and not listed here fails the compile. */
const NOTICE_KEYS: Readonly<Record<keyof AccountNoticesConfig, true>> = { mail: true };

/** `account.notices`. Absent: on with the default text. `false`: off. */
function resolveNotices(
  input: AccountNoticesConfig | false | undefined,
): ResolvedAccount["notices"] {
  if (input === false) return null;
  const o: AccountNoticesConfig = input === undefined ? {} : input;
  // `as unknown`: the guard must not narrow `o`, or its fields lose their types.
  if (!isPlainObject(o as unknown))
    throw new ConfigError("account.notices must be an object or false");
  for (const [key, value] of Object.entries(o))
    if (value !== undefined && !Object.hasOwn(NOTICE_KEYS, key))
      throw new ConfigError(
        `account.notices.${key} is not an option; core has ${Object.keys(NOTICE_KEYS).join(", ")}`,
      );
  if (o.mail !== undefined && typeof o.mail !== "function")
    throw new ConfigError("account.notices.mail must be a function");
  return { mail: o.mail ?? defaultNoticeMail };
}

const TOTP_KEYS: Readonly<Record<keyof TotpConfig, true>> = {
  issuer: true,
  backupCodes: true,
  backupCodeLength: true,
  trustDays: true,
  trustCookieName: true,
  challengePage: true,
  gate: true,
  emailMail: true,
};

const TOTP_GATE_KEYS: Readonly<Record<keyof TotpGateConfig, true>> = {
  magicLink: true,
  emailOtp: true,
  social: true,
};

/** `totp.gate` (plan 12c): each method on unless the app sets it false. */
function resolveGate(input: unknown): ResolvedTotp["gate"] {
  const gate = { magicLink: true, emailOtp: true, social: true };
  if (input === undefined) return gate;
  if (!isPlainObject(input)) throw new ConfigError("totp.gate must be an object");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && !Object.hasOwn(TOTP_GATE_KEYS, key))
      throw new ConfigError(
        `totp.gate.${key} is not an option; core has magicLink, emailOtp, and social. The handoff has no key: it continues a browser session that passed the gate`,
      );
  for (const key of ["magicLink", "emailOtp", "social"] as const) {
    const value = (input as TotpGateConfig)[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new ConfigError(`totp.gate.${key} must be true or false`);
    gate[key] = value;
  }
  return gate;
}
const COOKIE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** `totp` (plan 9f). Absent: on with the defaults when `password` is set. `false`: off. */
function resolveTotp(
  input: TotpConfig | false | undefined,
  hasPassword: boolean,
  defaultIssuer: string,
  cookieName: string,
): ResolvedTotp | null {
  if (input === false) return null;
  if (input !== undefined && !isPlainObject(input))
    throw new ConfigError("totp must be an object or false");
  if (!hasPassword) {
    if (input !== undefined)
      throw new ConfigError(
        "totp needs a password config: the enable of each method proves the password",
      );
    return null;
  }
  const o: TotpConfig = input ?? {};
  for (const [key, value] of Object.entries(o))
    if (value !== undefined && !Object.hasOwn(TOTP_KEYS, key))
      throw new ConfigError(
        `totp.${key} is not an option; core has issuer, backupCodes, backupCodeLength, trustDays, trustCookieName, challengePage, gate, and emailMail`,
      );
  const { issuer } = o;
  if (
    issuer !== undefined &&
    (typeof issuer !== "string" ||
      issuer.length < 1 ||
      issuer.length > 80 ||
      hasControlChar(issuer) ||
      issuer.includes(":"))
  )
    throw new ConfigError(
      "totp.issuer must be 1 to 80 characters with no control character and no colon",
    );
  // The default is appName, else the host of baseURL with no port. An IPv6
  // host ([::1]) or an appName with a colon would split the key URI's label
  // at the wrong place (plan 9h; until then the README only told the app to
  // set issuer). A config refusal is the machine check.
  if (issuer === undefined && defaultIssuer.includes(":"))
    throw new ConfigError(
      `totp.issuer is required: the default issuer ${defaultIssuer} holds a colon, which the key URI reads as the split between the issuer and the account; set totp.issuer to a name with no colon, or set totp to false`,
    );
  const backupCodes = o.backupCodes ?? 10;
  if (!Number.isSafeInteger(backupCodes) || backupCodes < 5 || backupCodes > 20)
    throw new ConfigError("totp.backupCodes must be an integer from 5 to 20");
  // 23 characters is the shortest code of 112 bits (ASVS 5.0 6.5.2, owner decision 3 of
  // 2026-10-14). 32 bounds the row and the typing.
  const backupCodeLength = o.backupCodeLength ?? 23;
  if (!Number.isSafeInteger(backupCodeLength) || backupCodeLength < 23 || backupCodeLength > 32)
    throw new ConfigError(
      "totp.backupCodeLength must be an integer from 23 to 32: a backup code holds 112 bits or more (ASVS 5.0 6.5.2)",
    );
  const trustDays = o.trustDays ?? 30;
  if (!Number.isSafeInteger(trustDays) || trustDays < 1 || trustDays > 365)
    throw new ConfigError("totp.trustDays must be an integer from 1 to 365");
  const trustCookieName = o.trustCookieName ?? "tempo_totp_trust";
  if (
    typeof trustCookieName !== "string" ||
    !COOKIE_NAME_RE.test(trustCookieName) ||
    trustCookieName === cookieName ||
    trustCookieName === LEGACY_SESSION_COOKIE
  )
    throw new ConfigError(
      "totp.trustCookieName must be 1 to 64 letters, digits, dots, underscores, or dashes, and not the session cookie's name or tempo_session",
    );
  if (o.challengePage !== undefined && typeof o.challengePage !== "function")
    throw new ConfigError("totp.challengePage must be a function");
  if (o.emailMail !== undefined && typeof o.emailMail !== "function")
    throw new ConfigError("totp.emailMail must be a function");
  return {
    // The default has no port (review M-2): the Key URI Format reads a colon,
    // also as %3A, as the split between the issuer and the account.
    issuer: issuer ?? defaultIssuer,
    backupCodes,
    backupCodeLength,
    trustDays,
    trustCookieName,
    challengePage: o.challengePage ?? defaultTotpPage,
    gate: resolveGate(o.gate),
    emailMail: o.emailMail ?? defaultSecondFactorMail,
  };
}

const JWT_MINT_KEYS: Readonly<Record<keyof JwtMintConfig, true>> = {
  alg: true,
  audience: true,
  ttlMinutes: true,
  claims: true,
  rotateEvery: true,
};

/** `jwtMint` (plan 9g). Absent: on, with the defaults. `false`: off. */
function resolveJwtMint(
  input: JwtMintConfig | false | undefined,
  baseURL: string,
): ResolvedJwtMint | null {
  if (input === false) return null;
  const o: JwtMintConfig = input === undefined ? {} : input;
  // `as unknown`: the guard must not narrow `o`, or its fields lose their types.
  if (!isPlainObject(o as unknown)) throw new ConfigError("jwtMint must be an object or false");
  for (const [key, value] of Object.entries(o))
    if (value !== undefined && !Object.hasOwn(JWT_MINT_KEYS, key))
      throw new ConfigError(
        `jwtMint.${key} is not an option; core has alg, audience, ttlMinutes, claims, and rotateEvery`,
      );
  const alg = o.alg ?? "EdDSA";
  if (!JWS_ALGS.includes(alg)) throw new ConfigError("jwtMint.alg must be EdDSA, ES256, or RS256");
  const audience: unknown =
    o.audience === undefined
      ? [baseURL]
      : typeof o.audience === "string"
        ? [o.audience]
        : o.audience;
  if (
    !Array.isArray(audience) ||
    audience.length < 1 ||
    audience.length > 10 ||
    audience.some(
      (a) => typeof a !== "string" || a.length < 1 || a.length > 2048 || hasControlChar(a),
    )
  )
    throw new ConfigError(
      "jwtMint.audience must be 1 to 10 strings of 1 to 2048 characters with no control character",
    );
  const ttlMinutes = o.ttlMinutes ?? 15;
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 60)
    throw new ConfigError("jwtMint.ttlMinutes must be an integer from 1 to 60");
  if (o.claims !== undefined && typeof o.claims !== "function")
    throw new ConfigError("jwtMint.claims must be a function");
  // Days (plan 11c). 365 bounds a typo in the unit, such as 3600 for one hour.
  const rotateEvery = o.rotateEvery ?? null;
  if (
    rotateEvery !== null &&
    (!Number.isSafeInteger(rotateEvery) || rotateEvery < 1 || rotateEvery > 365)
  )
    throw new ConfigError("jwtMint.rotateEvery must be a whole number of days from 1 to 365");
  return {
    alg,
    audience: [...(audience as string[])],
    ttlMinutes,
    claims: o.claims ?? null,
    rotateEvery,
  };
}

const SSO_KEYS: Readonly<Record<keyof SsoConfig, true>> = {
  oidc: true,
  saml: true,
  dns: true,
  fetch: true,
  limits: true,
};
const SSO_LIMIT_KEYS: Readonly<Record<keyof NonNullable<SsoConfig["limits"]>, true>> = {
  connectionsPerOrganization: true,
  domainsPerOrganization: true,
};
const SSO_SAML_KEYS: Readonly<Record<keyof Exclude<SsoConfig["saml"], true | undefined>, true>> = {
  clockSkewSeconds: true,
};
/** The largest clock skew of a SAML assertion, in seconds (plan 12d Task 8). */
const SAML_SKEW_MAX = 300;

/** One positive integer of `sso.limits`, or its default. */
function ssoLimit(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new ConfigError(`sso.limits.${key} must be a positive integer`);
  return value;
}

/**
 * `sso` (plan 12d). Off when absent or `false`. It needs `organizations`:
 * a domain and a connection belong to an organization. `dns` is required
 * and is never a default (ruling 15 of plan 12d): the app picks its
 * resolvers. Two resolvers: one resolver that is wrong or compromised must
 * not give a domain to an organization.
 */
function resolveSso(
  input: SsoConfig | false | undefined,
  organizations: boolean,
): ResolvedSso | null {
  if (input === undefined || input === false) return null;
  if (!isPlainObject(input as unknown)) throw new ConfigError("sso must be an object or false");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && !Object.hasOwn(SSO_KEYS, key))
      throw new ConfigError(
        `sso.${key} is not an option; core has oidc, saml, dns, fetch, and limits`,
      );
  if (!organizations) throw new ConfigError("sso needs organizations");
  if (input.oidc !== undefined && input.oidc !== true)
    throw new ConfigError("sso.oidc must be true or absent");
  let saml: ResolvedSso["saml"] = null;
  if (input.saml !== undefined) {
    const raw: unknown = input.saml;
    if (raw !== true && !isPlainObject(raw))
      throw new ConfigError("sso.saml must be true or an object");
    if (isPlainObject(raw))
      for (const [key, value] of Object.entries(raw))
        if (value !== undefined && !Object.hasOwn(SSO_SAML_KEYS, key))
          throw new ConfigError(`sso.saml.${key} is not an option; core has clockSkewSeconds`);
    const skew =
      raw === true ? undefined : (raw as { clockSkewSeconds?: unknown }).clockSkewSeconds;
    if (
      skew !== undefined &&
      (typeof skew !== "number" || !Number.isSafeInteger(skew) || skew < 0 || skew > SAML_SKEW_MAX)
    )
      throw new ConfigError(
        `sso.saml.clockSkewSeconds must be an integer from 0 to ${SAML_SKEW_MAX}`,
      );
    saml = { clockSkewSeconds: typeof skew === "number" ? skew : 120 };
  }
  const dns: unknown = input.dns;
  if (!Array.isArray(dns) || dns.length === 0)
    throw new ConfigError(
      "sso.dns must list one DNS resolver or more; core has no default resolver",
    );
  for (const port of dns as unknown[])
    if (
      typeof port !== "object" ||
      port === null ||
      typeof (port as { name?: unknown }).name !== "string" ||
      typeof (port as { txt?: unknown }).txt !== "function"
    )
      throw new ConfigError("sso.dns must hold objects with a name string and a txt function");
  if (input.fetch !== undefined && typeof input.fetch !== "function")
    throw new ConfigError("sso.fetch must be a function");
  const limits: unknown = input.limits;
  if (limits !== undefined) {
    if (!isPlainObject(limits)) throw new ConfigError("sso.limits must be an object");
    for (const [key, value] of Object.entries(limits))
      if (value !== undefined && !Object.hasOwn(SSO_LIMIT_KEYS, key))
        throw new ConfigError(
          `sso.limits.${key} is not an option; core has connectionsPerOrganization and domainsPerOrganization`,
        );
  }
  const l = (limits ?? {}) as Record<string, unknown>;
  return {
    oidc: input.oidc === true,
    saml,
    dns: Object.freeze([...(dns as DnsTxtPort[])]),
    // A caller's fetch must be callable without a receiver; no redirect is followed (plan 12b).
    fetch: providerFetch(input.fetch ?? globalThis.fetch.bind(globalThis)),
    limits: {
      connectionsPerOrganization: ssoLimit(
        l.connectionsPerOrganization,
        "connectionsPerOrganization",
        10,
      ),
      domainsPerOrganization: ssoLimit(l.domainsPerOrganization, "domainsPerOrganization", 20),
    },
  };
}

const OPERATOR_KEYS: Readonly<Record<keyof OperatorConfig, true>> = {
  secretHash: true,
  secrets: true,
  users: true,
  impersonation: true,
};
const OPERATOR_ENTRY_KEYS: Readonly<Record<keyof OperatorSecretEntry, true>> = {
  name: true,
  secretHash: true,
  scopes: true,
};
const OPERATOR_IMPERSONATION_KEYS: Readonly<
  Record<keyof NonNullable<OperatorConfig["impersonation"]>, true>
> = { ttlMinutes: true, notice: true };
const OPERATOR_SCOPES: ReadonlySet<string> = new Set<OperatorScope>([
  "keys",
  "secrets",
  "users",
  "sessions",
  "audit",
  "sso",
]);
const OPERATOR_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HASH_TEXT = "must be the SHA-256 of the secret as 64 lowercase hex characters";

/** One entry of `operator.secrets`, checked. The caller checks that names and hashes are unique. */
function resolveOperatorEntry(input: unknown): ResolvedOperatorSecret {
  if (!isPlainObject(input)) throw new ConfigError("operator.secrets[] must hold objects");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && !Object.hasOwn(OPERATOR_ENTRY_KEYS, key))
      throw new ConfigError(
        `operator.secrets[].${key} is not an option; core has name, secretHash, and scopes`,
      );
  const { name, secretHash, scopes } = input;
  if (typeof name !== "string" || !OPERATOR_NAME.test(name))
    throw new ConfigError("operator.secrets[].name must match ^[a-z0-9][a-z0-9_-]{0,31}$");
  if (typeof secretHash !== "string" || !SHA256_HEX.test(secretHash))
    throw new ConfigError(`operator.secrets[].secretHash ${HASH_TEXT}`);
  if (!Array.isArray(scopes) || scopes.length === 0)
    throw new ConfigError("operator.secrets[].scopes must list one scope or more");
  for (const scope of scopes as unknown[])
    if (typeof scope !== "string" || !OPERATOR_SCOPES.has(scope))
      throw new ConfigError(
        "operator.secrets[].scopes holds a scope that is not keys, secrets, users, sessions, audit, or sso",
      );
  return Object.freeze({
    name,
    secretHash,
    scopes: Object.freeze([...(scopes as OperatorScope[])]),
  });
}

/**
 * `operator` (plans 11c, 11c2, and 12f). Off when absent or `false`. It
 * needs no `jwtMint`: the secret routes and the info route serve without
 * minting, and `operatorRoutes` adds `keys/rotate` only with `jwtMint`.
 * `platformRole` is the resolved `organizations.platformRole`: the user
 * tools and the impersonation need an actor that can use them.
 */
function resolveOperator(
  input: OperatorConfig | false | undefined,
  platformRole: string | null,
): ResolvedOperator | null {
  if (input === undefined || input === false) return null;
  if (!isPlainObject(input as unknown))
    throw new ConfigError("operator must be an object or false");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && !Object.hasOwn(OPERATOR_KEYS, key))
      throw new ConfigError(
        `operator.${key} is not an option; core has secretHash, secrets, users, and impersonation`,
      );
  let secrets: ResolvedOperatorSecret[];
  if (input.secretHash !== undefined && input.secrets !== undefined)
    throw new ConfigError("operator.secretHash and operator.secrets are both set; set one");
  if (input.secrets !== undefined) {
    if (!Array.isArray(input.secrets) || input.secrets.length === 0)
      throw new ConfigError("operator.secrets must list one entry or more");
    secrets = input.secrets.map((entry) => resolveOperatorEntry(entry));
    const names = new Set(secrets.map((e) => e.name));
    if (names.size !== secrets.length)
      throw new ConfigError("operator.secrets[].name must be unique");
    const hashes = new Set(secrets.map((e) => e.secretHash));
    if (hashes.size !== secrets.length)
      throw new ConfigError("operator.secrets[].secretHash must be unique");
  } else if (input.secretHash === undefined && input.users === true) {
    // Spec 26 item 3 asks for an actor, not a secret. With no secret, only a
    // platform operator uses the tools; the no-actor rule below checks the role.
    secrets = [];
  } else {
    if (typeof input.secretHash !== "string" || !SHA256_HEX.test(input.secretHash))
      throw new ConfigError(`operator.secretHash ${HASH_TEXT}, or set operator.secrets`);
    // The 11c secret keeps the scopes of 11c and 11c2: an upgrade does not widen it.
    const scopes: readonly OperatorScope[] = Object.freeze(["keys", "secrets"]);
    secrets = [Object.freeze({ name: "default", secretHash: input.secretHash, scopes })];
  }
  if (input.users !== undefined && input.users !== true)
    throw new ConfigError("operator.users must be true or absent");
  const users = input.users === true;
  if (users && platformRole === null && !secrets.some((e) => e.scopes.includes("users")))
    throw new ConfigError(
      "operator.users needs a secret with the scope users or organizations.platformRole: else no actor can use the tools",
    );
  return {
    secrets: Object.freeze(secrets),
    users,
    impersonation: resolveImpersonation(input.impersonation, users, platformRole),
  };
}

/**
 * The longest life of an impersonation session (spec 26 item 3). No
 * impersonation session lives longer, so the start rows of this window name
 * every live one (plan 12f Task 11).
 */
export const IMPERSONATION_TTL_MAX_MINUTES = 240;

/** `operator.impersonation` (plan 12f). Null when absent. */
function resolveImpersonation(
  input: OperatorConfig["impersonation"],
  users: boolean,
  platformRole: string | null,
): ResolvedOperator["impersonation"] {
  if (input === undefined) return null;
  if (!isPlainObject(input as unknown))
    throw new ConfigError("operator.impersonation must be an object");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && !Object.hasOwn(OPERATOR_IMPERSONATION_KEYS, key))
      throw new ConfigError(
        `operator.impersonation.${key} is not an option; core has ttlMinutes and notice`,
      );
  if (!users) throw new ConfigError("operator.impersonation needs operator.users");
  // Only a platform operator starts an impersonation (owner decision 2).
  if (platformRole === null)
    throw new ConfigError("operator.impersonation needs organizations.platformRole");
  const ttlMinutes = input.ttlMinutes ?? 60;
  if (
    !Number.isSafeInteger(ttlMinutes) ||
    ttlMinutes < 5 ||
    ttlMinutes > IMPERSONATION_TTL_MAX_MINUTES
  )
    throw new ConfigError("operator.impersonation.ttlMinutes must be a whole number from 5 to 240");
  const notice = input.notice ?? true;
  if (typeof notice !== "boolean")
    throw new ConfigError("operator.impersonation.notice must be true or false");
  return { ttlMinutes, notice };
}

const OAUTH_KEYS: Readonly<Record<keyof OAuthConfig, true>> = {
  resources: true,
  defaultResource: true,
  scopes: true,
  registration: true,
  fetch: true,
  consentPage: true,
  accessTtlMinutes: true,
  refreshTtlDays: true,
  codeTtlMinutes: true,
  introspection: true,
  dpop: true,
  signInURL: true,
  refreshReuseSeconds: true,
  device: true,
  devicePage: true,
};

/** The longest client id: a `cl_` id or a metadata document URL (plan 11d). */
const CLIENT_ID_MAX = 2048;

/**
 * `oauth.introspection`: client id to 1 to 20 distinct entries of
 * `resources` (plan 12e). Core cannot read the clients at config time, so
 * an unknown id is no error: no client of that id authenticates.
 */
function resolveIntrospection(
  input: unknown,
  resources: readonly string[],
): ReadonlyMap<string, readonly string[]> | null {
  if (input === undefined) return null;
  if (!isPlainObject(input))
    throw new ConfigError("oauth.introspection must be an object of client ids to resource lists");
  const map = new Map<string, readonly string[]>();
  for (const [clientId, list] of Object.entries(input)) {
    if (clientId.length < 1 || clientId.length > CLIENT_ID_MAX || hasControlChar(clientId))
      throw new ConfigError(
        "oauth.introspection has a client id that is not 1 to 2048 characters with no control character",
      );
    if (
      !Array.isArray(list) ||
      list.length < 1 ||
      new Set(list).size !== list.length ||
      !list.every((r) => typeof r === "string" && resources.includes(r))
    )
      throw new ConfigError(
        `oauth.introspection.${clientId} must be a list of distinct entries of oauth.resources`,
      );
    map.set(clientId, [...(list as string[])]);
  }
  return map;
}

/**
 * `oauth.dpop` (plan 12e). The window rule is `DPOP_WINDOW_SECONDS`. A
 * replay row lives twice the window, so a longer window keeps more rows.
 */
function resolveDpop(input: unknown): ResolvedOAuth["dpop"] {
  const { min, max } = DPOP_WINDOW_SECONDS;
  const range = `oauth.dpop.windowSeconds must be an integer from ${min} to ${max}`;
  if (input === undefined)
    return { algs: FOREIGN_ALGS, windowSeconds: DPOP_WINDOW_SECONDS.default };
  if (!isPlainObject(input)) throw new ConfigError("oauth.dpop must be an object");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && key !== "algs" && key !== "windowSeconds")
      throw new ConfigError(`oauth.dpop.${key} is not an option; core has algs and windowSeconds`);
  const algs: unknown = input.algs ?? FOREIGN_ALGS;
  if (
    !Array.isArray(algs) ||
    algs.length < 1 ||
    new Set(algs).size !== algs.length ||
    !algs.every((a) => (FOREIGN_ALGS as readonly unknown[]).includes(a))
  )
    throw new ConfigError(
      "oauth.dpop.algs must be a list of distinct values of EdDSA, Ed25519, ES256, RS256, and PS256",
    );
  const seconds: unknown = input.windowSeconds ?? DPOP_WINDOW_SECONDS.default;
  if (typeof seconds !== "number") throw new ConfigError(range);
  return {
    algs: [...(algs as ForeignAlg[])],
    windowSeconds: integerIn("oauth.dpop.windowSeconds", seconds, min, max),
  };
}

/**
 * `oauth.signInURL` (plan 12e). Core adds `?request_id=oq_…` and nothing
 * else, so a query or a fragment of the config has no place. The origin
 * is one the app owns: the held request is the only state, so the
 * parameter carries no URL and opens no redirect (plan 9h).
 */
function resolveSignInURL(
  input: unknown,
  origins: { baseURL: string; appURL: string; trustedOrigins: readonly string[] },
): string | null {
  if (input === undefined) return null;
  const refuse = () =>
    new ConfigError(
      "oauth.signInURL must be an https URL on an origin of baseURL, appURL, or trustedOrigins, or a path on appURL; no query and no fragment",
    );
  if (typeof input !== "string" || hasControlChar(input) || input.includes("\\")) throw refuse();
  // A path joins appURL. `//host` is a URL with another host, not a path.
  const isPath = input.startsWith("/") && !input.startsWith("//");
  let url: URL;
  try {
    url = new URL(isPath ? `${origins.appURL}${input}` : input);
  } catch {
    throw refuse();
  }
  const owned = [origins.baseURL, origins.appURL, ...origins.trustedOrigins];
  if (
    (isPath ? url.origin !== origins.appURL : url.protocol !== "https:") ||
    !owned.includes(url.origin) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    input.includes("?") ||
    input.includes("#")
  )
    throw refuse();
  return url.toString();
}

/** `oauth.device` (plan 12e). Absent or `false`: off. */
function resolveDevice(input: unknown): ResolvedOAuth["device"] {
  if (input === undefined || input === false) return null;
  if (!isPlainObject(input)) throw new ConfigError("oauth.device must be an object or false");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && key !== "codeTtlMinutes" && key !== "interval")
      throw new ConfigError(
        `oauth.device.${key} is not an option; core has codeTtlMinutes and interval`,
      );
  const ttl: unknown = input.codeTtlMinutes ?? 10;
  const interval: unknown = input.interval ?? 5;
  if (typeof ttl !== "number")
    throw new ConfigError("oauth.device.codeTtlMinutes must be an integer from 1 to 30");
  if (typeof interval !== "number")
    throw new ConfigError("oauth.device.interval must be an integer from 5 to 60");
  return {
    codeTtlMinutes: integerIn("oauth.device.codeTtlMinutes", ttl, 1, 30),
    // RFC 8628 section 3.2: a client with no interval polls every 5 seconds, so no shorter value.
    interval: integerIn("oauth.device.interval", interval, 5, 60),
  };
}

function integerIn(path: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new ConfigError(`${path} must be an integer from ${min} to ${max}`);
  return value;
}

/** `oauth` (plan 9g). Absent or `false`: off. */
function resolveOAuth(
  input: OAuthConfig | false | undefined,
  jwtMint: ResolvedJwtMint | null,
  origins: { baseURL: string; appURL: string; trustedOrigins: readonly string[] },
): ResolvedOAuth | null {
  if (input === undefined || input === false) return null;
  if (!isPlainObject(input as unknown)) throw new ConfigError("oauth must be an object or false");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && !Object.hasOwn(OAUTH_KEYS, key))
      throw new ConfigError(
        `oauth.${key} is not an option; core has resources, defaultResource, scopes, registration, fetch, consentPage, accessTtlMinutes, refreshTtlDays, codeTtlMinutes, introspection, dpop, signInURL, refreshReuseSeconds, device, and devicePage`,
      );
  if (!jwtMint)
    throw new ConfigError("oauth needs jwtMint: an access token is a JWT that core signs");
  const resources: unknown = input.resources;
  if (
    !Array.isArray(resources) ||
    resources.length < 1 ||
    resources.length > 20 ||
    !resources.every(isResourceUrl) ||
    new Set(resources).size !== resources.length
  )
    throw new ConfigError(
      "oauth.resources must be 1 to 20 distinct absolute http or https URLs with no query, fragment, or credentials",
    );
  // One key signs the session JWTs and the access tokens with one issuer. A
  // server whose audience is in both lists would take an access token of any
  // client and scope as a session JWT and lose the scope limit (plan 9g
  // final fix wave, review I-2).
  const shared = jwtMint.audience.find((a) => (resources as string[]).includes(a));
  if (shared !== undefined)
    throw new ConfigError(
      `jwtMint.audience and oauth.resources both hold ${shared}: a server of that audience would take an OAuth access token as a session JWT; give the session JWT its own audience`,
    );
  // One audience per token: a default outside the list would mint a token no resource takes.
  const defaultResource: unknown = input.defaultResource;
  if (
    defaultResource !== undefined &&
    (typeof defaultResource !== "string" || !(resources as string[]).includes(defaultResource))
  )
    throw new ConfigError("oauth.defaultResource must be one entry of oauth.resources");
  const scopes = new Map(BUILT_IN_SCOPES);
  if (input.scopes !== undefined) {
    if (!isPlainObject(input.scopes as unknown))
      throw new ConfigError("oauth.scopes must be an object of names to texts");
    for (const [name, text] of Object.entries(input.scopes)) {
      if (!SCOPE_RE.test(name))
        throw new ConfigError(
          "oauth.scopes has a name that is not a scope token: 1 to 64 printable ASCII characters with no space, quote, or backslash",
        );
      if (BUILT_IN_SCOPES.has(name)) throw new ConfigError(`oauth.scopes.${name} is built in`);
      if (typeof text !== "string" || text.length < 1 || text.length > 200 || hasControlChar(text))
        throw new ConfigError(
          `oauth.scopes.${name} must be 1 to 200 characters with no control character`,
        );
      scopes.set(name, text);
    }
  }
  // Not `??`: `null` must reach the check and be refused, as `emailOtp: null` is.
  const registration: unknown = input.registration === undefined ? {} : input.registration;
  if (!isPlainObject(registration)) throw new ConfigError("oauth.registration must be an object");
  for (const [key, value] of Object.entries(registration)) {
    if (value === undefined) continue;
    if (key !== "dynamic" && key !== "cimd" && key !== "initialAccessTokenHash")
      throw new ConfigError(
        `oauth.registration.${key} is not an option; core has dynamic, cimd, and initialAccessTokenHash`,
      );
    if (key === "initialAccessTokenHash") {
      // Like operator.secretHash: core stores the hash and never the token.
      if (typeof value !== "string" || !SHA256_HEX.test(value))
        throw new ConfigError(
          "oauth.registration.initialAccessTokenHash must be the SHA-256 of the token as 64 lowercase hex characters",
        );
    } else if (typeof value !== "boolean")
      throw new ConfigError(`oauth.registration.${key} must be a boolean`);
  }
  // MCP 2026-07-28 calls dynamic registration deprecated (read 2026-10-14); an app turns it on (plan 12e).
  const dynamic = registration.dynamic === true;
  const cimd = registration.cimd !== false;
  const initialAccessTokenHash =
    typeof registration.initialAccessTokenHash === "string"
      ? registration.initialAccessTokenHash
      : null;
  // A token for a route that does not exist is a config error, not a silent 404.
  if (initialAccessTokenHash !== null && !dynamic)
    throw new ConfigError(
      "oauth.registration.initialAccessTokenHash needs oauth.registration.dynamic set to true: the register route that reads the token is off",
    );
  if (input.fetch !== undefined && typeof input.fetch !== "function")
    throw new ConfigError("oauth.fetch must be a function");
  if (cimd && input.fetch === undefined)
    throw new ConfigError(
      "oauth.fetch is required while registration.cimd is on: pass the app's guarded fetch for client metadata documents, or set registration.cimd to false",
    );
  if (input.consentPage !== undefined && typeof input.consentPage !== "function")
    throw new ConfigError("oauth.consentPage must be a function");
  if (input.devicePage !== undefined && typeof input.devicePage !== "function")
    throw new ConfigError("oauth.devicePage must be a function");
  return {
    resources: [...(resources as string[])],
    defaultResource: typeof defaultResource === "string" ? defaultResource : null,
    scopes,
    dynamic,
    cimd,
    initialAccessTokenHash,
    fetch: input.fetch ?? null,
    consentPage: input.consentPage ?? defaultConsentPage,
    accessTtlMinutes: integerIn(
      "oauth.accessTtlMinutes",
      input.accessTtlMinutes ?? jwtMint.ttlMinutes,
      1,
      60,
    ),
    refreshTtlDays: integerIn("oauth.refreshTtlDays", input.refreshTtlDays ?? 30, 1, 365),
    codeTtlMinutes: integerIn("oauth.codeTtlMinutes", input.codeTtlMinutes ?? 5, 1, 10),
    introspection: resolveIntrospection(input.introspection, resources as string[]),
    dpop: resolveDpop(input.dpop),
    signInURL: resolveSignInURL(input.signInURL, origins),
    refreshReuseSeconds: integerIn(
      "oauth.refreshReuseSeconds",
      input.refreshReuseSeconds ?? 0,
      0,
      REUSE_WINDOW_MAX_S,
    ),
    device: resolveDevice(input.device),
    devicePage: input.devicePage ?? defaultDevicePage,
    cimdCache: new Map(),
    jwksCache: new Map(),
  };
}

/** An object literal. A class instance keeps its methods on the prototype, where `Object.entries` does not see them. */
function isHookObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Each hook of one group, bound to the object it came on. A typo in a name fails the start: a hook that never runs is a silent gap. */
function hookGroup(
  path: string,
  group: unknown,
  points: Readonly<Record<string, true>>,
): Record<string, unknown> {
  if (group === undefined) return {};
  if (!isHookObject(group)) throw new ConfigError(`${path} must be a plain object`);
  const out: Record<string, unknown> = {};
  for (const [key, fn] of Object.entries(group)) {
    if (fn === undefined) continue;
    if (!Object.hasOwn(points, key)) throw new ConfigError(`${path}.${key} is not a hook point`);
    if (typeof fn !== "function") throw new ConfigError(`${path}.${key} must be a function`);
    out[key] = fn.bind(group);
  }
  return out;
}

/** The hook groups of core. The refusal message names them in this order. */
const HOOK_GROUPS: readonly string[] = ["organization", "session", "user", "identity", "operator"];

function resolveHooks(
  input: HooksConfig | undefined,
  organizationsOn: boolean,
  operatorUsersOn: boolean,
): ResolvedHooks {
  if (input === undefined)
    return { organization: {}, session: {}, user: {}, identity: {}, operator: {} };
  if (!isHookObject(input)) throw new ConfigError("hooks must be a plain object");
  for (const key of Object.keys(input))
    if (!HOOK_GROUPS.includes(key))
      throw new ConfigError(
        `hooks.${key} is not a hook group; core has organization, session, user, identity, and operator`,
      );
  // Each value passed the function check in hookGroup; the interfaces type the events.
  const organization = hookGroup(
    "hooks.organization",
    input.organization,
    ORGANIZATION_HOOK_POINTS,
  ) as unknown as OrganizationHooks;
  if (Object.keys(organization).length > 0 && !organizationsOn)
    throw new ConfigError("hooks.organization needs organizations: the hooks would never run");
  const session = hookGroup(
    "hooks.session",
    input.session,
    SESSION_HOOK_POINTS,
  ) as unknown as SessionHooks;
  const user = hookGroup("hooks.user", input.user, USER_HOOK_POINTS) as unknown as UserHooks;
  const identity = hookGroup(
    "hooks.identity",
    input.identity,
    IDENTITY_HOOK_POINTS,
  ) as unknown as IdentityHooks;
  const operator = hookGroup(
    "hooks.operator",
    input.operator,
    OPERATOR_HOOK_POINTS,
  ) as unknown as OperatorHooks;
  // Only an operator act runs these points, and the acts need operator.users.
  if (Object.keys(operator).length > 0 && !operatorUsersOn)
    throw new ConfigError("hooks.operator needs operator.users: the hooks would never run");
  return { organization, session, user, identity, operator };
}

const CAPTCHA_KEYS: Readonly<Record<keyof CaptchaConfig, true>> = {
  port: true,
  flows: true,
  onUnavailable: true,
};
const FIELD_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `captcha` (plan 12b). Absent: off. */
function resolveCaptcha(
  input: CaptchaConfig | undefined,
  defaultPageServed: boolean,
  passwordOn: boolean,
): ResolvedCaptcha | null {
  if (input === undefined) return null;
  if (!isPlainObject(input as unknown)) throw new ConfigError("captcha must be an object");
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && !Object.hasOwn(CAPTCHA_KEYS, key))
      throw new ConfigError(
        `captcha.${key} is not an option; core has port, flows, and onUnavailable`,
      );
  const port = input.port as unknown;
  if (
    typeof port !== "object" ||
    port === null ||
    typeof (port as CaptchaPort).verify !== "function"
  )
    throw new ConfigError("captcha.port must have a verify function");
  const page = (port as CaptchaPort).page;
  if (page !== undefined) {
    if (!isPlainObject(page as unknown))
      throw new ConfigError("captcha.port.page must be an object");
    if (!isHttpsUrl(page.scriptSrc))
      throw new ConfigError("captcha.port.page.scriptSrc must be an https URL");
    if (typeof page.widgetHtml !== "string" || page.widgetHtml.length > 4096)
      throw new ConfigError(
        "captcha.port.page.widgetHtml must be a string of at most 4096 characters",
      );
    if (typeof page.responseField !== "string" || !FIELD_RE.test(page.responseField))
      throw new ConfigError(
        "captcha.port.page.responseField must be 1 to 64 letters, digits, _, or -",
      );
    if (
      !Array.isArray(page.cspSources) ||
      !page.cspSources.every((s) => isHttpsUrl(s) && new URL(s).origin === s)
    )
      throw new ConfigError("captcha.port.page.cspSources must hold https origins with no path");
  }
  const flows: unknown = input.flows ?? [...DEFAULT_CAPTCHA_FLOWS];
  if (
    !Array.isArray(flows) ||
    flows.length < 1 ||
    new Set(flows).size !== flows.length ||
    !flows.every((f) => (CAPTCHA_FLOWS as readonly unknown[]).includes(f))
  )
    throw new ConfigError(
      `captcha.flows must be a list of 1 or more distinct flows: ${CAPTCHA_FLOWS.join(", ")}`,
    );
  // Core's page sends a token only from the widget that `page` describes.
  // With no page, every gated flow on that page answers captcha_required.
  // The page always has the magic link form, and the password form (sign-in,
  // sign-up, reset request) only with `password`. It has no email code form.
  const gated = new Set(flows as CaptchaFlow[]);
  const gatedOnPage =
    gated.has("magic-link-request") ||
    (passwordOn &&
      (gated.has("password-sign-in") ||
        gated.has("password-sign-up") ||
        gated.has("password-reset-request")));
  if (page === undefined && defaultPageServed && gatedOnPage)
    throw new ConfigError(
      "captcha.port.page is required while core serves its sign-in page (handoff or oauth) with a gated flow on it. Without the widget, the page sends no token, so each gated flow on it answers captcha_required. Give the port a page, or set handoff.signInPage",
    );
  const onUnavailable = input.onUnavailable ?? "allow";
  if (onUnavailable !== "allow" && onUnavailable !== "refuse")
    throw new ConfigError('captcha.onUnavailable must be "allow" or "refuse"');
  return {
    port: port as CaptchaPort,
    flows: new Set(flows as CaptchaFlow[]),
    onUnavailable,
    // A copy of the checked values: a later change to the port object does not reach the page.
    page:
      page === undefined
        ? null
        : Object.freeze({
            scriptSrc: page.scriptSrc,
            widgetHtml: page.widgetHtml,
            responseField: page.responseField,
            cspSources: Object.freeze([...page.cspSources]),
          }),
  };
}

/**
 * The configured providers: google, apple, then the list entries in order.
 * Refuses every entry that could break a flow rule (plan 9c).
 */
function socialProviders(social: AuthConfig["social"]): ConfiguredProvider[] {
  const providers: ConfiguredProvider[] = [];
  if (social?.google) {
    requireFields("social.google", social.google, ["clientId", "clientSecret"]);
    providers.push(googleProvider(social.google));
  }
  if (social?.apple) {
    requireFields("social.apple", social.apple, ["clientId", "teamId", "keyId", "privateKey"]);
    providers.push(appleProvider(social.apple));
  }
  if (social?.github) {
    requireFields("social.github", social.github, ["clientId", "clientSecret"]);
    providers.push(githubProvider(social.github));
  }
  if (social?.linkedin) {
    requireFields("social.linkedin", social.linkedin, ["clientId", "clientSecret"]);
    providers.push(linkedinProvider(social.linkedin));
  }
  const names = new Set<string>();
  const listName = (path: string, name: unknown) => {
    if (typeof name !== "string" || !PROVIDER_NAME_RE.test(name))
      throw new ConfigError(`${path}.name must match ${PROVIDER_NAME_RE.source}`);
    if (RESERVED_PROVIDER_NAMES.has(name))
      throw new ConfigError(
        `${path}.name ${name} is reserved: google, apple, github, and linkedin are presets, and email and credential are identity kinds`,
      );
    if (names.has(name)) throw new ConfigError(`${path}.name ${name} is given twice`);
    names.add(name);
  };
  const label = (path: string, value: unknown) => {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > LABEL_MAX ||
      hasControlChar(value)
    )
      throw new ConfigError(
        `${path}.label must be 1 to ${LABEL_MAX} characters with no control character`,
      );
  };
  const scope = (path: string, value: unknown) => {
    if (typeof value !== "string" || value.trim().length === 0 || hasControlChar(value))
      throw new ConfigError(`${path}.scope must be a non-empty string with no control character`);
  };
  const https = (path: string, value: unknown) => {
    if (!isHttpsUrl(value)) throw new ConfigError(`${path} must be an https URL`);
  };
  for (const [i, e] of listOf("social.oidc", social?.oidc).entries()) {
    const path = `social.oidc[${i}]`;
    listName(path, e.name);
    label(path, e.label);
    requireFields(path, e, ["clientId", "clientSecret"]);
    if (!isIssuer(e.issuer))
      throw new ConfigError(
        `${path}.issuer must be an https URL with no query, fragment, or credentials`,
      );
    if (e.scope !== undefined) {
      scope(path, e.scope);
      if (!e.scope.split(" ").includes("openid"))
        throw new ConfigError(`${path}.scope must hold openid, or the provider sends no ID token`);
    }
    if (e.endpoints !== undefined) {
      if (!isPlainObject(e.endpoints)) throw new ConfigError(`${path}.endpoints must be an object`);
      https(`${path}.endpoints.authorizeUrl`, e.endpoints.authorizeUrl);
      https(`${path}.endpoints.tokenUrl`, e.endpoints.tokenUrl);
      https(`${path}.endpoints.jwksUrl`, e.endpoints.jwksUrl);
    }
    providers.push(oidcProvider(e));
  }
  for (const [i, e] of listOf("social.oauth2", social?.oauth2).entries()) {
    const path = `social.oauth2[${i}]`;
    listName(path, e.name);
    label(path, e.label);
    requireFields(path, e, ["clientId", "clientSecret"]);
    scope(path, e.scope);
    https(`${path}.authorizeUrl`, e.authorizeUrl);
    https(`${path}.tokenUrl`, e.tokenUrl);
    if (typeof e.userinfo !== "function")
      throw new ConfigError(`${path}.userinfo must be a function`);
    // Object.entries of a string gives its characters as keys, so refuse it.
    if (e.authorizeParams !== undefined && !isPlainObject(e.authorizeParams))
      throw new ConfigError(`${path}.authorizeParams must be an object`);
    for (const [key, value] of Object.entries(e.authorizeParams ?? {})) {
      if (CORE_AUTHORIZE_PARAMS.has(key))
        throw new ConfigError(`${path}.authorizeParams.${key} is set by core`);
      if (typeof value !== "string" || hasControlChar(value))
        throw new ConfigError(
          `${path}.authorizeParams.${key} must be a string with no control character`,
        );
    }
    providers.push(oauth2Provider(e));
  }
  return providers;
}
