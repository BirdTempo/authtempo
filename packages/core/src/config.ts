import {
  defaultEmailOtpMail,
  defaultResetOtpMail,
  type EmailOtpMailInput,
} from "./engine/email-otp-mail.js";
import {
  type HooksConfig,
  ORGANIZATION_HOOK_POINTS,
  type OrganizationHooks,
  type ResolvedHooks,
  SESSION_HOOK_POINTS,
  type SessionHooks,
} from "./engine/hooks.js";
import { PASSWORD_MAX_LENGTH } from "./engine/password-policy.js";
import { normalizeSlug, ROLE_RE } from "./engine/ranks.js";
import { type ConfirmPageInput, defaultConfirmPage } from "./http/confirm-page.js";
import {
  defaultHandoffConfirmPage,
  type HandoffConfirmPageInput,
} from "./http/handoff-confirm-page.js";
import { defaultResetPage, type ResetPageInput } from "./http/password-pages.js";
import { defaultSignInPage, type SignInPageInput } from "./http/sign-in-page.js";
import { defaultTotpPage, type TotpChallengePageInput } from "./http/totp-page.js";
import { createMemoryLimiter } from "./limiter/memory.js";
import type { LimiterPort } from "./limiter/port.js";
import { type Clock, systemClock } from "./primitives/clock.js";
import type { JwsAlg } from "./primitives/jwk.js";
import { hasControlChar } from "./primitives/text.js";
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

export interface AuthConfig {
  /** Path prefix for the auth routes. Default "/auth". */
  basePath?: string;
  /** Origin of the server that mounts `handle`, no path, no trailing slash. */
  baseURL: string;
  /** At least 32 characters. */
  secret: string;
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
  cookieName?: string;
  session?: { ttlDays?: number; slidingRefreshDays?: number };
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
    /** The fetch for every provider call. Default: the global fetch. Tests inject one. */
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
   * The app's code at named points of the organization and session flows
   * (plan 9d, spec 8.9). A before hook runs inside the flow's transaction and
   * refuses with `throw hookRefusal(message)`; an after hook runs after the
   * commit. Pass plain objects of functions. Organization hooks need
   * `organizations`.
   */
  hooks?: HooksConfig;
}

export interface PasswordConfig {
  /** The hash seam. Default: PBKDF2-SHA256 (see `createPbkdf2PasswordHash`). */
  hash?: PasswordHashSeam;
  /** 8 to 128. Default 8. */
  minLength?: number;
  /** True when the password is in a known breach. Default: no check. */
  breachCheck?: (plain: string) => Promise<boolean>;
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
  /** The characters of a backup code, 8 to 12. Default 8. */
  backupCodeLength?: number;
  /** The life of a trusted device, 1 to 365 days. Default 30. */
  trustDays?: number;
  /** The trust cookie: 1 to 64 letters, digits, `.`, `_`, or `-`, not `cookieName`. Default `tempo_totp_trust`. */
  trustCookieName?: string;
  /** The HTML of the challenge page. Default `defaultTotpPage`. */
  challengePage?: (input: TotpChallengePageInput) => string;
}

export interface ResolvedTotp {
  issuer: string;
  backupCodes: number;
  backupCodeLength: number;
  trustDays: number;
  trustCookieName: string;
  challengePage: (input: TotpChallengePageInput) => string;
}

export interface JwtMintConfig {
  /** `EdDSA` (Ed25519, default) or `ES256` (ECDSA P-256). A change retires the signing key at the next signature. */
  alg?: JwsAlg;
  /** The `aud` of a session JWT: 1 to 10 strings, each 1 to 2048 characters. Default `[baseURL]`. */
  audience?: string | string[];
  /** The life of a session JWT, 1 to 60. Default 15. A sign-out does not end a token. */
  ttlMinutes?: number;
  /**
   * The app's own claims. A reserved name (`iss`, `sub`, `aud`, `iat`,
   * `exp`, `nbf`, `jti`, `sid`, `email`, `email_verified`, `name`, `org`)
   * never comes from here. A throw answers `hook_failed`.
   */
  claims?: (
    user: UserRow,
    session: SessionRow,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
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
  ranks?: Record<string, number>;
  reservedSlugs?: string[];
  platformOrganization?: string;
  platformRole?: string;
  invitationTtlDays?: number;
  /** The link in the invitation mail. Default `${appURL}/?invitation=<token>`. */
  invitationLinkBuilder?: (token: string, organization: { slug: string; name: string }) => string;
  limits?: OrganizationLimits;
}

/** Each a positive integer. Absent: no limit (plan 9d). */
export interface OrganizationLimits {
  /** The member rows one user may hold, at any rank. Create answers `organization_limit` at it. */
  perUser?: number;
  /** The member rows one organization may hold. Add and accept answer `member_limit` at it. */
  membersPerOrganization?: number;
  /** The pending, unexpired invitations of one organization. Invite answers `invitation_limit` at it. */
  pendingInvitationsPerOrganization?: number;
}

type ResolvedLimits = { [K in keyof OrganizationLimits]-?: number | null };

export interface ResolvedConfig {
  basePath: string;
  baseURL: string;
  appName: string;
  secret: string;
  trustedOrigins: ReadonlySet<string>;
  appURL: string;
  cookie: { sameSite: "Lax" | "None" };
  storage: StorageAdapter;
  mail: MailPort;
  limiter: LimiterPort;
  clientIp: (request: Request) => string | null;
  clock: Clock;
  cookieName: string;
  session: { ttlDays: number; slidingRefreshDays: number };
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
    ranks: Readonly<Record<string, number>>;
    reservedSlugs: ReadonlySet<string>;
    platformOrganization: string | null;
    platformRole: string | null;
    invitationTtlDays: number;
    invitationLinkBuilder: (token: string, organization: { slug: string; name: string }) => string;
    limits: ResolvedLimits;
  } | null;
  password: {
    hash: PasswordHashSeam;
    minLength: number;
    breachCheck: ((plain: string) => Promise<boolean>) | null;
    resetTtlMinutes: number;
    resetPage: (input: ResetPageInput) => string;
    legacyVerify: Required<LegacyVerifyConfig> | null;
  } | null;
  emailOtp: ResolvedEmailOtp | null;
  totp: ResolvedTotp | null;
  jwtMint: ResolvedJwtMint | null;
  hooks: ResolvedHooks;
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
  if (input.secret.length < 32) throw new ConfigError("secret must be at least 32 characters");
  let origin: URL;
  try {
    origin = new URL(input.baseURL);
  } catch {
    throw new ConfigError("baseURL must be an absolute URL");
  }
  if (origin.pathname !== "/" || input.baseURL.endsWith("/") || origin.search || origin.hash) {
    throw new ConfigError("baseURL must be an origin with no path and no trailing slash");
  }
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
    const ranks = o.ranks ?? DEFAULT_RANKS;
    for (const [role, rank] of Object.entries(ranks)) {
      if (!ROLE_RE.test(role) || role.includes(","))
        throw new ConfigError(`organizations.ranks has a bad role name: ${role}`);
      if (!Number.isSafeInteger(rank) || rank < 1)
        throw new ConfigError(`organizations.ranks.${role} must be a positive integer`);
    }
    // The create path makes the creator owner, and the last-owner rule reads that rank.
    if (!Object.hasOwn(ranks, "owner"))
      throw new ConfigError("organizations.ranks must name owner");
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
        throw new ConfigError("organizations.platformRole must be in ranks");
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
      reservedSlugs: reserved,
      platformOrganization,
      platformRole,
      invitationTtlDays: ttl,
      invitationLinkBuilder:
        o.invitationLinkBuilder ??
        ((token) => `${appURL}/?invitation=${encodeURIComponent(token)}`),
      limits: resolveLimits(o.limits),
    };
  }
  const basePath = input.basePath ?? "/auth";
  if (!basePath.startsWith("/") || basePath.endsWith("/")) {
    throw new ConfigError("basePath must start with / and not end with /");
  }
  const clock = input.clock ?? systemClock;
  const providers = socialProviders(input.social);
  // A caller's fetch must be callable without a receiver. The engine calls it as a plain function.
  const fetchFn = input.social?.fetch ?? globalThis.fetch.bind(globalThis);
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
    password = {
      hash: p.hash ?? createPbkdf2PasswordHash(),
      minLength,
      breachCheck: p.breachCheck ?? null,
      resetTtlMinutes,
      resetPage: p.resetPage ?? defaultResetPage,
      legacyVerify,
    };
  }
  // One source for the session cookie name: the trust cookie check of `totp` reads it too.
  const cookieName = input.cookieName ?? "tempo_session";
  return {
    basePath,
    baseURL: input.baseURL,
    appName,
    secret: input.secret,
    trustedOrigins: new Set(input.trustedOrigins),
    appURL,
    cookie: { sameSite },
    storage: input.storage,
    mail: input.mail,
    limiter: input.limiter ?? createMemoryLimiter(clock),
    clientIp: input.clientIp ?? workersClientIp,
    clock,
    cookieName,
    session: {
      ttlDays: input.session?.ttlDays ?? 30,
      slidingRefreshDays: input.session?.slidingRefreshDays ?? 7,
    },
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
    password,
    emailOtp: resolveEmailOtp(input.emailOtp),
    totp: resolveTotp(input.totp, password !== null, input.appName ?? origin.hostname, cookieName),
    jwtMint: resolveJwtMint(input.jwtMint, input.baseURL),
    hooks: resolveHooks(input.hooks, organizations !== null),
  };
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

const NO_LIMITS: ResolvedLimits = {
  perUser: null,
  membersPerOrganization: null,
  pendingInvitationsPerOrganization: null,
};

function resolveLimits(input: OrganizationLimits | undefined): ResolvedLimits {
  const out: ResolvedLimits = { ...NO_LIMITS };
  if (input === undefined) return out;
  if (!isPlainObject(input)) throw new ConfigError("organizations.limits must be an object");
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(NO_LIMITS, key))
      throw new ConfigError(
        `organizations.limits.${key} is not a limit; core has perUser, membersPerOrganization, and pendingInvitationsPerOrganization`,
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

const TOTP_KEYS: Readonly<Record<keyof TotpConfig, true>> = {
  issuer: true,
  backupCodes: true,
  backupCodeLength: true,
  trustDays: true,
  trustCookieName: true,
  challengePage: true,
};
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
        "totp needs a password config: the second factor gates the password sign-in only",
      );
    return null;
  }
  const o: TotpConfig = input ?? {};
  for (const [key, value] of Object.entries(o))
    if (value !== undefined && !Object.hasOwn(TOTP_KEYS, key))
      throw new ConfigError(
        `totp.${key} is not an option; core has issuer, backupCodes, backupCodeLength, trustDays, trustCookieName, and challengePage`,
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
  const backupCodes = o.backupCodes ?? 10;
  if (!Number.isSafeInteger(backupCodes) || backupCodes < 5 || backupCodes > 20)
    throw new ConfigError("totp.backupCodes must be an integer from 5 to 20");
  const backupCodeLength = o.backupCodeLength ?? 8;
  if (!Number.isSafeInteger(backupCodeLength) || backupCodeLength < 8 || backupCodeLength > 12)
    throw new ConfigError("totp.backupCodeLength must be an integer from 8 to 12");
  const trustDays = o.trustDays ?? 30;
  if (!Number.isSafeInteger(trustDays) || trustDays < 1 || trustDays > 365)
    throw new ConfigError("totp.trustDays must be an integer from 1 to 365");
  const trustCookieName = o.trustCookieName ?? "tempo_totp_trust";
  if (
    typeof trustCookieName !== "string" ||
    !COOKIE_NAME_RE.test(trustCookieName) ||
    trustCookieName === cookieName
  )
    throw new ConfigError(
      "totp.trustCookieName must be 1 to 64 letters, digits, dots, underscores, or dashes, and not the session cookie's name",
    );
  if (o.challengePage !== undefined && typeof o.challengePage !== "function")
    throw new ConfigError("totp.challengePage must be a function");
  return {
    // The default has no port (review M-2): the Key URI Format reads a colon,
    // also as %3A, as the split between the issuer and the account.
    issuer: issuer ?? defaultIssuer,
    backupCodes,
    backupCodeLength,
    trustDays,
    trustCookieName,
    challengePage: o.challengePage ?? defaultTotpPage,
  };
}

const JWT_MINT_KEYS: Readonly<Record<keyof JwtMintConfig, true>> = {
  alg: true,
  audience: true,
  ttlMinutes: true,
  claims: true,
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
        `jwtMint.${key} is not an option; core has alg, audience, ttlMinutes, and claims`,
      );
  const alg = o.alg ?? "EdDSA";
  if (alg !== "EdDSA" && alg !== "ES256")
    throw new ConfigError("jwtMint.alg must be EdDSA or ES256");
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
  return { alg, audience: [...(audience as string[])], ttlMinutes, claims: o.claims ?? null };
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

function resolveHooks(input: HooksConfig | undefined, organizationsOn: boolean): ResolvedHooks {
  if (input === undefined) return { organization: {}, session: {} };
  if (!isHookObject(input)) throw new ConfigError("hooks must be a plain object");
  for (const key of Object.keys(input))
    if (key !== "organization" && key !== "session")
      throw new ConfigError(`hooks.${key} is not a hook group; core has organization and session`);
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
  return { organization, session };
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
