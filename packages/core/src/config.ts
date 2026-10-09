import { PASSWORD_MAX_LENGTH } from "./engine/password-policy.js";
import { normalizeSlug, ROLE_RE } from "./engine/ranks.js";
import { type ConfirmPageInput, defaultConfirmPage } from "./http/confirm-page.js";
import {
  defaultHandoffConfirmPage,
  type HandoffConfirmPageInput,
} from "./http/handoff-confirm-page.js";
import { defaultResetPage, type ResetPageInput } from "./http/password-pages.js";
import { defaultSignInPage, type SignInPageInput } from "./http/sign-in-page.js";
import { createMemoryLimiter } from "./limiter/memory.js";
import type { LimiterPort } from "./limiter/port.js";
import { type Clock, systemClock } from "./primitives/clock.js";
import { hasControlChar } from "./primitives/text.js";
import { createJoseJwtSeam, type JwtSeam } from "./seams/jwt.js";
import { createPbkdf2PasswordHash, type PasswordHashSeam } from "./seams/password-hash.js";
import { createSimpleWebAuthnSeam, type WebAuthnSeam } from "./seams/webauthn.js";
import { type AppleConfig, appleProvider } from "./social/apple.js";
import { type GoogleConfig, googleProvider } from "./social/google.js";
import type { Provider } from "./social/provider.js";
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
    /** The fetch for the token exchange and the JWKS. Default: the global fetch. Tests inject one. */
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
}

export interface OrganizationsConfig {
  ranks?: Record<string, number>;
  reservedSlugs?: string[];
  platformOrganization?: string;
  platformRole?: string;
  invitationTtlDays?: number;
  /** The link in the invitation mail. Default `${appURL}/?invitation=<token>`. */
  invitationLinkBuilder?: (token: string, organization: { slug: string; name: string }) => string;
}

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
  social: { providers: Provider[]; fetch: typeof fetch };
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
  } | null;
  password: {
    hash: PasswordHashSeam;
    minLength: number;
    breachCheck: ((plain: string) => Promise<boolean>) | null;
    resetTtlMinutes: number;
    resetPage: (input: ResetPageInput) => string;
  } | null;
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
const DEFAULT_RESERVED_SLUGS = [
  "admin",
  "api",
  "auth",
  "internal",
  "operator",
  "ops",
  "platform",
  "system",
  "www",
];

const APP_NAME_MAX = 80;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\/$/;

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
      if (!SCHEME_RE.test(s))
        throw new ConfigError(`handoff.schemes entry must be like app://, got ${s}`);
      if (s === "https://" || s === "http://")
        throw new ConfigError(`handoff.schemes must not hold ${s}`);
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
    };
  }
  const basePath = input.basePath ?? "/auth";
  if (!basePath.startsWith("/") || basePath.endsWith("/")) {
    throw new ConfigError("basePath must start with / and not end with /");
  }
  const clock = input.clock ?? systemClock;
  const providers: Provider[] = [];
  if (input.social?.google) {
    requireFields("social.google", input.social.google, ["clientId", "clientSecret"]);
    providers.push(googleProvider(input.social.google));
  }
  if (input.social?.apple) {
    requireFields("social.apple", input.social.apple, [
      "clientId",
      "teamId",
      "keyId",
      "privateKey",
    ]);
    providers.push(appleProvider(input.social.apple));
  }
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
    password = {
      hash: p.hash ?? createPbkdf2PasswordHash(),
      minLength,
      breachCheck: p.breachCheck ?? null,
      resetTtlMinutes,
      resetPage: p.resetPage ?? defaultResetPage,
    };
  }
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
    cookieName: input.cookieName ?? "tempo_session",
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
  };
}

function requireFields<T extends object>(path: string, obj: T, keys: (keyof T & string)[]): void {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v !== "string" || v.length === 0)
      throw new ConfigError(`${path}.${key} must be a non-empty string`);
  }
}
