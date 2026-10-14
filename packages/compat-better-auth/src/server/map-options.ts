import {
  type AuthConfig,
  defaultSignInPage,
  type LimiterPort,
  type SignInPageInput,
} from "@authtempo/core";
import { betterAuthPasswordHash } from "../hash.js";
import {
  type BetterAuthOptions,
  COMPAT_PLUGIN,
  type CompatDatabase,
  type CompatPlugin,
} from "../types.js";
import { appSchemes, pluginOf, signUpClosed } from "./check-options.js";
import { compatHooks } from "./hooks.js";
import { compatMail, INVITATION_LINK_PREFIX, otpMail } from "./mail.js";
import { COOKIE_NAME } from "./shapes.js";
import { TRUST_DEVICE_COOKIE } from "./two-factor.js";

/** Better Auth 1.7's defaults (read in its source on 2026-10-10). They apply before the mapping. */
export const BETTER_AUTH_DEFAULTS = {
  sessionExpiresIn: 604_800,
  sessionUpdateAge: 86_400,
  resetPasswordTokenExpiresIn: 3_600,
  minPasswordLength: 8,
  magicLinkExpiresIn: 300,
  emailVerificationExpiresIn: 3_600,
  invitationExpiresIn: 172_800,
  // crud-members.mjs:62 and crud-invites.mjs:171 (read 2026-10-13): Better Auth applies both
  // when the option is absent. Core keeps them as organizations.limits (plan 9d).
  membershipLimit: 100,
  invitationLimit: 100,
  // dist/plugins/email-otp/index.mjs:14 and routes.mjs atomicVerifyOTP
  // (`opts?.allowedAttempts || 3`), read 2026-10-13 (plan 9e).
  emailOtpExpiresIn: 300,
  emailOtpAllowedAttempts: 3,
  // dist/plugins/two-factor/backup-codes/index.mjs (generateBackupCodesFn: amount 10,
  // length 10) and index.mjs (trustDeviceMaxAge 30 days), read 2026-10-13 (plan 9f).
  // Better Auth's length of 10 is not mapped since plan 12c: core's codes hold 112 bits.
  twoFactorBackupCodes: 10,
  trustDeviceMaxAge: 2_592_000,
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
  /** Where core lands a sign-in: `authtempo.appURL`, else the origin of baseURL. */
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
 * `magic-link` (`magic-link:email:`), `password-reset` (the reset
 * request, `password-reset:email:`), and `password-resend` (the verify mail
 * resend, `password-resend:email:`, plan 8b), and the email codes (`otp` and
 * `otp-verify`, with `otp:email:` and `otp-verify:email:`, plan 9e). Every other flow (sign-up, the reset
 * POST, invitation accept, handoff, passkey, social start) has only the
 * per-IP limit, so it keeps core's shared unknown bucket: without it such a
 * flow has no limit at all (review I-2). The sign-up also has a per-email
 * limit since plan 12b (`password-sign-up:email:`), but it keeps the IP
 * bucket: one script can sign up many addresses, one per address.
 *
 * One exception has no per-email limit: `totp-verify` (plan 9f). Its binding
 * limits are per user: `totp-code:user` (10 code checks per 15 minutes) and
 * `totp-code:user-day` (30 per 24 hours), on every code check. Each
 * challenge also takes 5 codes and needs a password sign-in, which keeps its
 * per-email limit.
 */
const NO_IP_KEY =
  /^(password|magic-link|password-reset|password-resend|otp|otp-verify|totp-verify):ip:unknown$/;

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

/** Spread last into the config, so the type keeps it to the three plugin sections. */
type PluginConfig = Pick<AuthConfig, "organizations" | "passkey" | "handoff">;

function pluginConfig(options: BetterAuthOptions): PluginConfig {
  const out: PluginConfig = {};
  const org = pluginOf(options, "organization");
  if (org) {
    const o = org.options;
    out.organizations = {
      invitationTtlDays: (o.invitationExpiresIn ?? BETTER_AUTH_DEFAULTS.invitationExpiresIn) / DAY,
      // Never mailed by core: the mail port hands the token to sendInvitationEmail (mail.ts).
      invitationLinkBuilder: (token) => `${INVITATION_LINK_PREFIX}${token}`,
      // A function organizationLimit is a hook (src/server/hooks.ts), not a number.
      limits: {
        ...(typeof o.organizationLimit === "number" ? { perUser: o.organizationLimit } : {}),
        membersPerOrganization: o.membershipLimit ?? BETTER_AUTH_DEFAULTS.membershipLimit,
        pendingInvitationsPerOrganization:
          o.invitationLimit ?? BETTER_AUTH_DEFAULTS.invitationLimit,
      },
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
  const otp = pluginOf(options, "email-otp");
  const tf = pluginOf(options, "two-factor");
  const ttlSeconds = magic
    ? (magic.options.expiresIn ?? BETTER_AUTH_DEFAULTS.magicLinkExpiresIn)
    : (options.emailVerification?.expiresIn ?? BETTER_AUTH_DEFAULTS.emailVerificationExpiresIn);
  const sameSite = options.advanced?.defaultCookieAttributes?.sameSite?.toLowerCase();
  const clientIp = clientIpOf(options);
  const google = options.socialProviders?.google;
  const apple = options.socialProviders?.apple;
  const github = options.socialProviders?.github;
  const linkedin = options.socialProviders?.linkedin;
  const ep = options.emailAndPassword;
  const config: AuthConfig = {
    baseURL: origin,
    basePath,
    // Plan 12b: secrets map one entry for one entry. With neither key, core's
    // own refusal of an empty secret names the problem.
    ...(options.secret !== undefined || options.secrets === undefined
      ? { secret: options.secret ?? "" }
      : {}),
    // A copy, not a rebuild: core checks each entry and names a bad one.
    ...(options.secrets !== undefined ? { secrets: [...options.secrets] } : {}),
    // Plan 12b: disableSignUp on every method that creates a user is core's
    // signUp false. checkOptions refuses a mix, so no other list reaches here.
    ...(signUpClosed(options) ? { signUp: false as const } : {}),
    trustedOrigins: Array.isArray(options.trustedOrigins) ? [...options.trustedOrigins] : [],
    ...(options.appName !== undefined ? { appName: options.appName } : {}),
    ...(options.authtempo?.appURL !== undefined ? { appURL: options.authtempo.appURL } : {}),
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
      sendVerificationOTP: otp?.options.sendVerificationOTP,
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
    // Core turns email codes on by default; Better Auth serves them only with
    // its email-otp plugin (plan 9e).
    emailOtp: otp
      ? {
          // Better Auth counts seconds and core whole minutes, rounded up, so
          // a code never lives shorter than the app asked: 90 s is 2 minutes.
          ttlMinutes: Math.ceil(
            (otp.options.expiresIn ?? BETTER_AUTH_DEFAULTS.emailOtpExpiresIn) / 60,
          ),
          length: otp.options.otpLength === 8 ? 8 : 6,
          maxAttempts: otp.options.allowedAttempts ?? BETTER_AUTH_DEFAULTS.emailOtpAllowedAttempts,
          mail: ({ email, code }) => otpMail(email, "sign-in", code),
          resetMail: ({ email, code }) => otpMail(email, "forget-password", code),
        }
      : false,
    // Core mints JWTs and serves /jwks and /token by default (plan 9g).
    // Better Auth serves them only with its jwt plugin, which this package
    // refuses, so they stay off here; `oauth` stays absent, so the provider
    // is off too. The tables exist (migration 0004) and stay empty.
    jwtMint: false,
    // Core turns the second factor on with `password`; Better Auth serves it
    // only with its two-factor plugin (plan 9f). The trust cookie keeps
    // Better Auth's name, so core reads and writes the one cookie.
    totp: tf
      ? {
          ...(tf.options.issuer !== undefined ? { issuer: tf.options.issuer } : {}),
          backupCodes:
            tf.options.backupCodeOptions?.amount ?? BETTER_AUTH_DEFAULTS.twoFactorBackupCodes,
          // Absent: core's 23 characters (113.9 bits, ASVS 5.0 6.5.2, plan 12c).
          // check-options refuses every value outside 23 to 32, so a set value is in range.
          ...(tf.options.backupCodeOptions?.length !== undefined
            ? { backupCodeLength: tf.options.backupCodeOptions.length }
            : {}),
          trustDays: (tf.options.trustDeviceMaxAge ?? BETTER_AUTH_DEFAULTS.trustDeviceMaxAge) / DAY,
          trustCookieName: TRUST_DEVICE_COOKIE,
          // Better Auth 1.7.2's two-factor plugin gates /sign-in/email,
          // /sign-in/username, and /sign-in/phone-number only
          // (dist/plugins/two-factor/index.mjs line 245, read 2026-10-14). Its
          // magic link, email code, and social sign-in open a session with no
          // second factor, so the shim keeps core's gate off on those three
          // (owner decision 2 of 2026-10-14). The reset gate has no key.
          gate: { magicLink: false, emailOtp: false, social: false },
        }
      : false,
    ...(google || apple || github || linkedin
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
            ...(github
              ? { github: { clientId: github.clientId, clientSecret: github.clientSecret } }
              : {}),
            ...(linkedin
              ? { linkedin: { clientId: linkedin.clientId, clientSecret: linkedin.clientSecret } }
              : {}),
          },
        }
      : {}),
    ...(ep?.enabled === true
      ? {
          password: {
            hash: options.authtempo?.passwordHash ?? betterAuthPasswordHash(),
            minLength: ep.minPasswordLength ?? BETTER_AUTH_DEFAULTS.minPasswordLength,
            resetTtlMinutes:
              (ep.resetPasswordTokenExpiresIn ?? BETTER_AUTH_DEFAULTS.resetPasswordTokenExpiresIn) /
              60,
            // Plan 12b Task 15: Better Auth's requireEmailVerification is core's
            // requireVerified. A sign-up answers no session, and an unverified
            // sign-in answers EMAIL_NOT_VERIFIED.
            ...(ep.requireEmailVerification === true ? { requireVerified: true } : {}),
            // Better Auth's own answer: a session at sign-up, and its error for
            // a taken address. The shim's signUp.email answers { token, user },
            // which the uniform answer cannot fill (plan 12b).
            uniformSignUp: false,
          },
        }
      : {}),
    ...pluginConfig(options),
    hooks: compatHooks(options),
  };
  return {
    config,
    origin,
    basePath,
    plugins,
    clientIp: clientIp ?? ((r) => r.headers.get("cf-connecting-ip") || null),
    appOrigin: options.authtempo?.appURL ?? origin,
    minPasswordLength: ep?.minPasswordLength ?? BETTER_AUTH_DEFAULTS.minPasswordLength,
  };
}
