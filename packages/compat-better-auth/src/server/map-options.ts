import {
  type AuthConfig,
  defaultSignInPage,
  type LimiterPort,
  type SignInPageInput,
} from "@tempo-auth/core";
import { betterAuthPasswordHash } from "../hash.js";
import {
  type BetterAuthOptions,
  COMPAT_PLUGIN,
  type CompatDatabase,
  type CompatPlugin,
} from "../types.js";
import { appSchemes, pluginOf } from "./check-options.js";
import { compatMail, INVITATION_LINK_PREFIX } from "./mail.js";
import { COOKIE_NAME } from "./shapes.js";

/** Better Auth 1.7's defaults (read in its source on 2026-10-10). They apply before the mapping. */
export const BETTER_AUTH_DEFAULTS = {
  sessionExpiresIn: 604_800,
  sessionUpdateAge: 86_400,
  resetPasswordTokenExpiresIn: 3_600,
  minPasswordLength: 8,
  magicLinkExpiresIn: 300,
  emailVerificationExpiresIn: 3_600,
  invitationExpiresIn: 172_800,
  basePath: "/api/auth",
} as const;

const DAY = 86_400;

export interface Mapped {
  config: AuthConfig;
  origin: string;
  basePath: string;
  /** The ids of the compat plugins in use. */
  plugins: Set<string>;
  clientIp: (request: Request) => string | null;
  /** Where core lands a sign-in: `tempoAuth.appURL`, else the origin of baseURL. */
  appOrigin: string;
  /** `emailAndPassword.minPasswordLength` or Better Auth's default, for the length codes. */
  minPasswordLength: number;
}

/**
 * Core keys a per-IP limit as `<flow>:ip:<ip>`, and as `<flow>:ip:unknown`
 * when the request has no client IP (every `limiter.allow` in core's
 * engine/*.ts, read 2026-10-10). With `disableIpTracking`, a server call
 * with no headers, or off Workers with no `ipAddressHeaders`, a request has
 * none, so that one bucket holds every such caller and one person could
 * lock every sign-in. The wrapper skips that key only for the flows that
 * also have a per-email limit: `password` (sign-in, `password:email:`),
 * `magic-link` (`magic-link:email:`), and `password-reset` (the reset
 * request, `password-reset:email:`). Every other flow (sign-up, the reset
 * POST, invitation accept, handoff, passkey, social start) has only the
 * per-IP limit, so it keeps core's shared unknown bucket: without it such a
 * flow has no limit at all (review I-2).
 */
const NO_IP_KEY = /^(password|magic-link|password-reset):ip:unknown$/;

export function skipUnknownIp(limiter: LimiterPort): LimiterPort {
  const sweep = limiter.sweep?.bind(limiter);
  return {
    allow: (key, window) =>
      NO_IP_KEY.test(key) ? Promise.resolve(true) : limiter.allow(key, window),
    ...(sweep ? { sweep } : {}),
  };
}

const IPV4_PART = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${IPV4_PART}(\\.${IPV4_PART}){3}$`);

/**
 * True for an IPv4 or IPv6 literal. A listed header may carry any text the
 * caller sends; the value becomes part of a limiter key, so `unknown` would
 * match the skip key above and a long string would grow the key set
 * (review M-6). The URL parser checks the IPv6 form.
 */
export function isIpLiteral(value: string): boolean {
  if (IPV4.test(value)) return true;
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

/** The default reads `cf-connecting-ip`, as core does. Better Auth's own default (`x-forwarded-for`) is not copied: any caller sets it. */
function clientIpOf(options: BetterAuthOptions): ((request: Request) => string | null) | null {
  const ip = options.advanced?.ipAddress;
  if (ip?.disableIpTracking === true) return () => null;
  const headers = ip?.ipAddressHeaders;
  if (!headers || headers.length === 0) return null;
  return (request) => {
    for (const h of headers) {
      const first = request.headers.get(h)?.split(",")[0]?.trim();
      // A value that is not an IP literal answers null, not the next header.
      if (first) return isIpLiteral(first) ? first : null;
    }
    return null;
  };
}

function pluginConfig(options: BetterAuthOptions): Partial<AuthConfig> {
  const out: Partial<AuthConfig> = {};
  const org = pluginOf(options, "organization");
  if (org) {
    out.organizations = {
      invitationTtlDays:
        (org.options.invitationExpiresIn ?? BETTER_AUTH_DEFAULTS.invitationExpiresIn) / DAY,
      // Never mailed by core: the mail port hands the token to sendInvitationEmail (mail.ts).
      invitationLinkBuilder: (token) => `${INVITATION_LINK_PREFIX}${token}`,
    };
  }
  const pk = pluginOf(options, "passkey");
  if (pk) {
    const origin = pk.options.origin;
    out.passkey = {
      rpID: pk.options.rpID ?? "",
      rpName: pk.options.rpName ?? "",
      origins: Array.isArray(origin) ? [...origin] : typeof origin === "string" ? [origin] : [],
    };
  }
  if (pluginOf(options, "expo")) {
    out.handoff = {
      schemes: appSchemes(options),
      // Core serves the magic link always. Without the plugin this handler
      // answers 404 on those paths, so the system-browser page must not offer it.
      ...(pluginOf(options, "magic-link")
        ? {}
        : {
            signInPage: (input: SignInPageInput) =>
              defaultSignInPage({ ...input, methods: { ...input.methods, magicLink: false } }),
          }),
    };
  }
  return out;
}

/** Runs after checkOptions found no refusal, so every value here has its checked type. */
export function mapOptions(options: BetterAuthOptions): Mapped {
  const url = new URL(options.baseURL ?? "");
  const path = url.pathname.replace(/\/+$/, "");
  const basePath = options.basePath ?? (path || BETTER_AUTH_DEFAULTS.basePath);
  const origin = url.origin;
  const database = options.database as CompatDatabase;
  const plugins = new Set(
    (options.plugins ?? [])
      .filter((p) => (p as CompatPlugin).kind === COMPAT_PLUGIN)
      .map((p) => p.id),
  );
  const magic = pluginOf(options, "magic-link");
  const org = pluginOf(options, "organization");
  const ttlSeconds = magic
    ? (magic.options.expiresIn ?? BETTER_AUTH_DEFAULTS.magicLinkExpiresIn)
    : (options.emailVerification?.expiresIn ?? BETTER_AUTH_DEFAULTS.emailVerificationExpiresIn);
  const sameSite = options.advanced?.defaultCookieAttributes?.sameSite?.toLowerCase();
  const clientIp = clientIpOf(options);
  const google = options.socialProviders?.google;
  const apple = options.socialProviders?.apple;
  const ep = options.emailAndPassword;
  const config: AuthConfig = {
    baseURL: origin,
    basePath,
    secret: options.secret ?? "",
    trustedOrigins: Array.isArray(options.trustedOrigins) ? [...options.trustedOrigins] : [],
    ...(options.appName !== undefined ? { appName: options.appName } : {}),
    ...(options.tempoAuth?.appURL !== undefined ? { appURL: options.tempoAuth.appURL } : {}),
    // One name in this package (shapes.ts), passed to core, so core and the shim read one cookie.
    cookieName: COOKIE_NAME,
    storage: database.storage,
    limiter: skipUnknownIp(database.limiter),
    mail: compatMail({
      origin,
      basePath,
      storage: database.storage,
      sendResetPassword: ep?.sendResetPassword,
      sendVerificationEmail: options.emailVerification?.sendVerificationEmail,
      sendMagicLink: magic?.options.sendMagicLink,
      sendInvitationEmail: org?.options.sendInvitationEmail,
    }),
    ...(clientIp ? { clientIp } : {}),
    ...(sameSite
      ? { cookie: { sameSite: sameSite === "none" ? ("None" as const) : ("Lax" as const) } }
      : {}),
    session: {
      ttlDays: (options.session?.expiresIn ?? BETTER_AUTH_DEFAULTS.sessionExpiresIn) / DAY,
      slidingRefreshDays:
        (options.session?.updateAge ?? BETTER_AUTH_DEFAULTS.sessionUpdateAge) / DAY,
    },
    magicLink: { ttlMinutes: ttlSeconds / 60 },
    ...(google || apple
      ? {
          social: {
            ...(google
              ? { google: { clientId: google.clientId, clientSecret: google.clientSecret } }
              : {}),
            ...(apple
              ? {
                  apple: {
                    clientId: apple.clientId,
                    teamId: apple.teamId ?? "",
                    keyId: apple.keyId ?? "",
                    privateKey: apple.privateKey ?? "",
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(ep?.enabled === true
      ? {
          password: {
            hash: options.tempoAuth?.passwordHash ?? betterAuthPasswordHash(),
            minLength: ep.minPasswordLength ?? BETTER_AUTH_DEFAULTS.minPasswordLength,
            resetTtlMinutes:
              (ep.resetPasswordTokenExpiresIn ?? BETTER_AUTH_DEFAULTS.resetPasswordTokenExpiresIn) /
              60,
          },
        }
      : {}),
    ...pluginConfig(options),
  };
  return {
    config,
    origin,
    basePath,
    plugins,
    clientIp: clientIp ?? ((r) => r.headers.get("cf-connecting-ip") || null),
    appOrigin: options.tempoAuth?.appURL ?? origin,
    minPasswordLength: ep?.minPasswordLength ?? BETTER_AUTH_DEFAULTS.minPasswordLength,
  };
}
