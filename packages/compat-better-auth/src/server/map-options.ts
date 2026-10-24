import {
  type AuthConfig,
  defaultSignInPage,
  isIpLiteral,
  type LimiterPort,
  normalizeSlug,
  SCIM_SCOPES,
  type SignInPageInput,
} from "@authtempo/core";
import { type DomainRecordOf, withDomainRecord } from "@authtempo/core/compat";
import { tiktokEntry, wechatEntry } from "@authtempo/core/social-entries";
import { defaultRoles } from "../access.js";
import { betterAuthPasswordHash } from "../hash.js";
import { CORE_RESOURCES, corePermissionsOf, toCoreNames } from "../role-map.js";
import {
  type ApiKeyOptions,
  type BetterAuthOptions,
  COMPAT_PLUGIN,
  type CompatDatabase,
  type CompatPlugin,
  type OrganizationOptions,
  type ScimScope,
  type User,
} from "../types.js";
import { IMPERSONATION_SECONDS, platformRoleOf } from "./admin.js";
import {
  appSchemes,
  DEFAULT_ROLE_RANKS,
  dynamicOrigins,
  pluginOf,
  signUpClosed,
} from "./check-options.js";
import { BETTER_AUTH_CLOCK_SKEW_MS, DEFAULT_TOKEN_PREFIX } from "./check-sso.js";
import { compatHooks } from "./hooks.js";
import { compatAccountMail, compatMail, INVITATION_LINK_PREFIX, otpMail } from "./mail.js";
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
  // context/create-context.mjs:148: 3600 * 24 (read 2026-10-17, plan 12a).
  freshAge: 86_400,
  // dist/api/routes/update-user.mjs:322: `deleteTokenExpiresIn || 3600 * 24` (read 2026-10-17, plan 12a Task 20).
  deleteTokenExpiresIn: 86_400,
  basePath: "/api/auth",
} as const;

const DAY = 86_400;

export interface Mapped {
  config: AuthConfig;
  /** The origin of inner requests: the primary, or the request's entry after `mappedFor`. */
  origin: string;
  /** Every origin of a `baseURL` list, the primary first. Empty for a string (plan 12i Task 18). */
  origins: readonly string[];
  basePath: string;
  /** The ids of the compat plugins in use. */
  plugins: Set<string>;
  clientIp: (request: Request) => string | null;
  /** Where core lands a sign-in: `authtempo.appURL`, else the origin of baseURL. */
  appOrigin: string;
  /** True with no `authtempo.appURL`: core's default appURL follows the request's entry. */
  appOriginFollows: boolean;
  /** `emailAndPassword.minPasswordLength` or Better Auth's default, for the length codes. */
  minPasswordLength: number;
  /** The account operations that the options turn on (plan 12a). */
  account: { changeEmail: boolean; deleteUser: boolean; emailOtpChange: boolean };
  /**
   * `emailVerification.beforeEmailVerification`, which the change of
   * address by code calls before core's route (VERIFY_CALLBACK_PLACES in
   * hooks.ts), or null.
   */
  changeVerifyBefore: ((user: User) => unknown) | null;
  /** The platform role of the `admin` plugin (plan 12f), or null without it. */
  platformRole: string | null;
  /** The api-key plugin's options, or null without the plugin (plan 12k Task 12). */
  apiKey: ApiKeyOptions | null;
  /** The sso plugin's mapping, or null without the plugin (plan 12d Task 14). */
  sso: MappedSso | null;
  /** The credentials of the scim plugin, by the hash of each token, or null without the plugin. */
  scim: { credentials: MappedScimCredential[] } | null;
}

/** What the shim's SSO paths read of the sso plugin (plan 12d Task 14). */
export interface MappedSso {
  /** `organizationProvisioning.defaultRole`: the role of a new member of each connection. */
  defaultRole: "member" | "admin";
  /** False with `disableImplicitSignUp`: no just-in-time create on each connection. */
  jit: boolean;
  /** The prefix of Better Auth's record of a domain proof. */
  tokenPrefix: string;
}

/** One SCIM credential: the SHA-256 of its token in hex, never the token. */
export interface MappedScimCredential {
  /** `<connection id>:<credential id>`: the key of its limit and the actor of its audit rows. */
  id: string;
  tokenHash: string;
  organizationId: string;
  scopes: ScimScope[];
  expiresAt: Date | null;
}

/** Each scim credential, with the organization of its connection: provisioningDomainId, else the id. */
function scimCredentials(options: BetterAuthOptions): Mapped["scim"] {
  const o = pluginOf(options, "scim")?.options;
  if (!o) return null;
  return {
    credentials: o.connections.flatMap((c) =>
      c.credentials.map((k) => ({
        id: `${c.id}:${k.id}`,
        // checkOptions refused a null hash, so each one here is set.
        tokenHash: k.tokenHash ?? "",
        organizationId: c.provisioningDomainId ?? c.id,
        scopes: [...(k.scopes ?? SCIM_SCOPES)],
        expiresAt: k.expiresAt ?? null,
      })),
    ),
  };
}

/**
 * The sso plugin as core's `sso` (plan 12d Task 14). OIDC and SAML are on.
 * Better Auth's clock skew of 5 minutes applies first (rule 16.1), in whole
 * seconds. `providersLimit` is core's connections per organization, 10 as
 * in Better Auth.
 */
function ssoConfig(options: BetterAuthOptions): Pick<AuthConfig, "sso" | "scim"> {
  const o = pluginOf(options, "sso")?.options;
  const out: Pick<AuthConfig, "sso" | "scim"> = {};
  if (o)
    out.sso = {
      oidc: true,
      saml: {
        clockSkewSeconds: (o.saml?.clockSkew ?? BETTER_AUTH_CLOCK_SKEW_MS) / 1000,
      },
      dns: [...(options.authtempo?.ssoDns ?? [])],
      limits: {
        connectionsPerOrganization: typeof o.providersLimit === "number" ? o.providersLimit : 10,
      },
    };
  if (pluginOf(options, "scim")) out.scim = {};
  return out;
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
    // The wrap keeps the scope (plan 12i Task 4): without it a shared limiter
    // reads as isolate, and createAuth refuses `phone`.
    ...(limiter.scope ? { scope: limiter.scope } : {}),
  };
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

/**
 * Better Auth 1.7.5's key window when `rateLimit` names none: 10 calls a day
 * (@better-auth/api-key dist/index.mjs:2333 to :2337, read 2026-10-21).
 */
export const API_KEY_DEFAULT_WINDOW = { seconds: 86_400, max: 10 } as const;

/**
 * The api-key plugin as core's `tokens` (plan 12k Task 12). `rateLimit` is
 * the window of a new key: check-options keeps `timeWindow` in whole
 * seconds. The moved prefixes are `defaultPrefix` and
 * `authtempo.movedKeyPrefixes`, each once. A bearer with one goes to the
 * hash lookup of the moved keys (ruling 4 of plan 12k).
 */
function apiKeyTokens(options: BetterAuthOptions): Pick<AuthConfig, "tokens"> {
  const keys = pluginOf(options, "api-key")?.options;
  if (!keys) return {};
  const rate = keys.rateLimit;
  const defaultRateLimit =
    rate?.enabled === false
      ? null
      : {
          seconds: (rate?.timeWindow ?? API_KEY_DEFAULT_WINDOW.seconds * 1000) / 1000,
          max: rate?.maxRequests ?? API_KEY_DEFAULT_WINDOW.max,
        };
  return { tokens: { defaultRateLimit, movedPrefixes: movedKeyPrefixesOf(options) } };
}

/**
 * The moved prefixes of an app: `defaultPrefix` and each entry of
 * `authtempo.movedKeyPrefixes`, each once. It is core's `tokens.movedPrefixes`
 * and the input of `moveBetterAuthApiKeys`, so both read one list.
 */
export function movedKeyPrefixesOf(options: BetterAuthOptions): string[] {
  const keys = pluginOf(options, "api-key")?.options;
  const prefixes = [
    ...(keys?.defaultPrefix !== undefined ? [keys.defaultPrefix] : []),
    ...(options.authtempo?.movedKeyPrefixes ?? []),
  ];
  return [...new Set(prefixes)];
}

type OrganizationsConfig = Extract<AuthConfig["organizations"], object>;

/**
 * `ac`, `roles`, and `dynamicAccessControl` on core's organizations (plan 12k
 * Task 10, spec 29 item 18). `ac.statements` without the six core resources
 * is the app's own statements; `apiKey` is core's `apiToken`. Each role gets
 * its statements as core's permissions with Better Auth's list reads, and its
 * rank from `authtempo.roleRanks`. With no `roles`, Better Auth's three
 * default roles map, ranked member 1, admin 2, owner 3. checkOptions has
 * refused every role with no rank, so each rank here is set.
 */
function accessConfig(
  options: BetterAuthOptions,
): Pick<OrganizationsConfig, "statements" | "roles" | "dynamicRoles"> {
  const o = pluginOf(options, "organization")?.options ?? {};
  const own = toCoreNames(o.ac?.statements ?? {}) as Record<string, readonly string[]>;
  const statements = Object.fromEntries(
    Object.entries(own)
      .filter(([resource]) => !CORE_RESOURCES.includes(resource))
      .map(([resource, actions]) => [resource, [...actions]]),
  );
  const ranks = o.roles ? (options.authtempo?.roleRanks ?? {}) : DEFAULT_ROLE_RANKS;
  const table = o.roles ?? defaultRoles;
  const roles = Object.fromEntries(
    Object.entries(table).map(([name, r]) => [
      name,
      { rank: ranks[name] ?? 0, permissions: corePermissionsOf(r.statements) },
    ]),
  );
  const dynamic = o.dynamicAccessControl;
  return {
    statements,
    roles,
    ...(dynamic?.enabled === true
      ? {
          dynamicRoles:
            dynamic.maximumRolesPerOrganization !== undefined
              ? { maxPerOrganization: dynamic.maximumRolesPerOrganization }
              : {},
        }
      : {}),
  };
}

/**
 * `teams` on core's `organizations.teams` (plan 12k Task 11, spec 29 item
 * 19). Better Auth 1.7.2's defaults apply first (rule 16.1). A create makes
 * a default team unless `defaultTeam.enabled` is false (routes/crud-org.mjs:106).
 * The last team stays unless `allowRemovingAllTeams` is true
 * (routes/crud-team.mjs:179). checkOptions refused the function limits.
 */
function teamsConfig(o: OrganizationOptions): Pick<OrganizationsConfig, "teams"> {
  if (o.teams?.enabled !== true) return {};
  return {
    teams: {
      defaultTeam: o.teams.defaultTeam?.enabled !== false,
      keepLastTeam: o.teams.allowRemovingAllTeams !== true,
    },
  };
}

/** `maximumTeams` and `maximumMembersPerTeam` on core's two team limits. Absent: no limit, as in Better Auth. */
function teamLimits(
  o: OrganizationOptions,
): Pick<NonNullable<OrganizationsConfig["limits"]>, "teamsPerOrganization" | "membersPerTeam"> {
  const t = o.teams;
  if (t?.enabled !== true) return {};
  return {
    ...(t.maximumTeams !== undefined ? { teamsPerOrganization: t.maximumTeams } : {}),
    ...(t.maximumMembersPerTeam !== undefined ? { membersPerTeam: t.maximumMembersPerTeam } : {}),
  };
}

/** Spread last into the config, so the type keeps it to the plugin sections. */
type PluginConfig = Pick<AuthConfig, "organizations" | "passkey" | "handoff" | "operator">;

function pluginConfig(options: BetterAuthOptions): PluginConfig {
  const out: PluginConfig = {};
  const org = pluginOf(options, "organization");
  const admin = pluginOf(options, "admin");
  // checkOptions refuses the admin plugin without organization() and the slug.
  // The config holds the slug that core resolves (normalizeSlug), so the
  // shim's role read and core's read find one organization (ruling 60 M1).
  const raw = options.authtempo?.platformOrganization;
  const platformOrganization = raw === undefined ? undefined : (normalizeSlug(raw) ?? raw);
  if (org) {
    const o = org.options;
    out.organizations = {
      // Plan 12f: Better Auth's admins are the platform operators (spec section 26 item 1).
      ...(admin && platformOrganization !== undefined
        ? { platformOrganization, platformRole: platformRoleOf(admin.options) }
        : {}),
      invitationTtlDays: (o.invitationExpiresIn ?? BETTER_AUTH_DEFAULTS.invitationExpiresIn) / DAY,
      // Never mailed by core: the mail port hands the token to sendInvitationEmail (mail.ts).
      invitationLinkBuilder: (token) => `${INVITATION_LINK_PREFIX}${token}`,
      // A function organizationLimit is a hook (src/server/hooks.ts), not a number.
      limits: {
        ...(typeof o.organizationLimit === "number" ? { perUser: o.organizationLimit } : {}),
        membersPerOrganization: o.membershipLimit ?? BETTER_AUTH_DEFAULTS.membershipLimit,
        pendingInvitationsPerOrganization:
          o.invitationLimit ?? BETTER_AUTH_DEFAULTS.invitationLimit,
        ...teamLimits(o),
      },
      ...accessConfig(options),
      ...teamsConfig(o),
    };
  }
  if (admin) {
    // Better Auth's admin plugin always serves the impersonation; core's
    // notice mail at each start stays on (owner decision 3 of plan 12f).
    const seconds = admin.options.impersonationSessionDuration ?? IMPERSONATION_SECONDS;
    out.operator = { users: true, impersonation: { ttlMinutes: seconds / 60 } };
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

/**
 * A providerId: letters, digits, `_`, and `-`, so it sits in one DNS label
 * of the record and in one path segment. Better Auth refuses a record
 * identifier over 63 characters (DNS_LABEL_MAX_LENGTH, dist/index.mjs:2584).
 */
export const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Better Auth's record of a domain proof (@better-auth/sso 1.7.2
 * dist/index.mjs:2522 and :2593 to :2604, read 2026-10-22). Its name is
 * `_<prefix>-<providerId>.<domain>`. Its value is `<identifier>=<token>` or
 * the token alone. The token is core's current challenge of the row. The
 * providerId is the label of the domain's connection (ruling 61 P5). A
 * domain with no connection has no Better Auth record. A label outside
 * `PROVIDER_ID_RE` has none either: a dot in it would put the record in the
 * zone of a subdomain, whose owner could then prove the parent domain.
 */
export function betterAuthRecord(tokenPrefix: string): DomainRecordOf {
  return (row, label) => {
    if (label === null || !PROVIDER_ID_RE.test(label)) return null;
    const identifier = verificationIdentifier(tokenPrefix, label);
    return {
      name: `${identifier}.${row.domain}`,
      values: [`${identifier}=${row.challenge}`, row.challenge],
    };
  };
}

/** `_<prefix>-<providerId>`, Better Auth's identifier of a domain proof (dist/index.mjs:2522). */
export function verificationIdentifier(tokenPrefix: string, providerId: string): string {
  return `_${tokenPrefix}-${providerId}`;
}

/** The sso plugin's mapping, or null without the plugin. `copyBetterAuthSso` reads it too. */
export function ssoOf(options: BetterAuthOptions): MappedSso | null {
  const o = pluginOf(options, "sso")?.options;
  if (!o) return null;
  return {
    defaultRole: o.organizationProvisioning?.defaultRole ?? "member",
    jit: o.disableImplicitSignUp !== true,
    tokenPrefix: o.domainVerification?.tokenPrefix ?? DEFAULT_TOKEN_PREFIX,
  };
}

/**
 * The origins of a dynamic base URL, `fallback` first when it is one of
 * them (plan 12i Task 18): core's first entry is its primary. Empty for a
 * string. checkOptions refused every other form.
 */
function baseOrigins(baseURL: BetterAuthOptions["baseURL"]): string[] {
  if (typeof baseURL !== "object") return [];
  const origins = dynamicOrigins({ ...baseURL }) ?? [];
  const first = baseURL.fallback;
  return first === undefined ? origins : [first, ...origins.filter((o) => o !== first)];
}

/**
 * The mapping of one request (plan 12i Task 18). On a `baseURL` list, the
 * shim builds each inner request, each SSO URL, and the default landing
 * origin on the request's entry, as core does. Else core's Origin rule
 * refuses a page of B, and a callback goes to A without B's binding cookie.
 * The gate answered 421 to a host outside the list before this call.
 */
export function mappedFor(mapped: Mapped, request: Request): Mapped {
  const origin = new URL(request.url).origin;
  if (origin === mapped.origin || !mapped.origins.includes(origin)) return mapped;
  return { ...mapped, origin, appOrigin: mapped.appOriginFollows ? origin : mapped.appOrigin };
}

/** Runs after checkOptions found no refusal, so every value here has its checked type. */
export function mapOptions(options: BetterAuthOptions): Mapped {
  const origins = baseOrigins(options.baseURL);
  const url = new URL(typeof options.baseURL === "string" ? options.baseURL : (origins[0] ?? ""));
  const path = url.pathname.replace(/\/+$/, "");
  const basePath = options.basePath ?? (path || BETTER_AUTH_DEFAULTS.basePath);
  // The primary: core builds from it outside a request (plan 12i Task 18).
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
  const admin = pluginOf(options, "admin");
  const ttlSeconds = magic
    ? (magic.options.expiresIn ?? BETTER_AUTH_DEFAULTS.magicLinkExpiresIn)
    : (options.emailVerification?.expiresIn ?? BETTER_AUTH_DEFAULTS.emailVerificationExpiresIn);
  const sameSite = options.advanced?.defaultCookieAttributes?.sameSite?.toLowerCase();
  const clientIp = clientIpOf(options);
  const google = options.socialProviders?.google;
  const apple = options.socialProviders?.apple;
  const github = options.socialProviders?.github;
  const linkedin = options.socialProviders?.linkedin;
  const tiktok = options.socialProviders?.tiktok;
  const wechat = options.socialProviders?.wechat;
  const ep = options.emailAndPassword;
  const deleteUser = options.user?.deleteUser;
  const config: AuthConfig = {
    baseURL: typeof options.baseURL === "string" ? origin : origins,
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
      // A mail link names the entry of its request (plan 12i Task 18).
      origins: origins.length > 0 ? origins : [origin],
      basePath,
      storage: database.storage,
      sendResetPassword: ep?.sendResetPassword,
      sendVerificationEmail: options.emailVerification?.sendVerificationEmail,
      sendMagicLink: magic?.options.sendMagicLink,
      sendVerificationOTP: otp?.options.sendVerificationOTP,
      sendInvitationEmail: org?.options.sendInvitationEmail,
      sendDeleteAccountVerification: deleteUser?.sendDeleteAccountVerification,
    }),
    ...(clientIp ? { clientIp } : {}),
    ...(sameSite
      ? { cookie: { sameSite: sameSite === "none" ? ("None" as const) : ("Lax" as const) } }
      : {}),
    session: {
      ttlDays: (options.session?.expiresIn ?? BETTER_AUTH_DEFAULTS.sessionExpiresIn) / DAY,
      slidingRefreshDays:
        (options.session?.updateAge ?? BETTER_AUTH_DEFAULTS.sessionUpdateAge) / DAY,
      // Better Auth's freshAge in seconds, rounded up to whole minutes (plan
      // 12a): a window never shorter than the app asked. check-options keeps
      // it from 1 to 86400 seconds, so 1 to 1440 minutes.
      freshMinutes: Math.ceil((options.session?.freshAge ?? BETTER_AUTH_DEFAULTS.freshAge) / 60),
      // Better Auth's deferSessionRefresh is core's deferRefresh (plan 12a). Both are off by default.
      ...(options.session?.deferSessionRefresh !== undefined
        ? { deferRefresh: options.session.deferSessionRefresh }
        : {}),
    },
    account: {
      // Better Auth's deleteUser is off by default; core's is on. The shim keeps Better Auth's default.
      delete: deleteUser?.enabled === true,
      // The mail callback turns on core's mailed confirm, with Better Auth's
      // default life of the link (plan 12a Task 20).
      ...(deleteUser?.sendDeleteAccountVerification
        ? {
            deleteConfirm: {
              ttlMinutes:
                (deleteUser.deleteTokenExpiresIn ?? BETTER_AUTH_DEFAULTS.deleteTokenExpiresIn) / 60,
            },
          }
        : {}),
      // Better Auth sends no credential-change notice and has no callback for one.
      // The shim's mail port routes a mail by its link and throws on a notice,
      // which has none. So each notice would fail and log a line. An app
      // turns core's notices on when it moves to core's own config.
      notices: false,
      // The proof mails, each routed to a Better Auth callback (mail.ts).
      mail: compatAccountMail,
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
    ...(google || apple || github || linkedin || tiktok || wechat
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
            // Plan 12i Task 22: core's list entries with Better Auth's provider
            // ids and subjects (open_id; unionid, else openid), so a Better
            // Auth-era account row links on the first sign-in.
            ...(tiktok || wechat
              ? {
                  oauth2: [
                    ...(tiktok
                      ? [
                          tiktokEntry({
                            clientKey: tiktok.clientKey,
                            clientSecret: tiktok.clientSecret,
                          }),
                        ]
                      : []),
                    ...(wechat
                      ? [wechatEntry({ appId: wechat.clientId, appSecret: wechat.clientSecret })]
                      : []),
                  ],
                }
              : {}),
            // No social.stateData (plan 12i ruling 5): no shim hook can read
            // the payload, so the shim refuses additionalData (STATE_DATA_REFUSAL).
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
    ...apiKeyTokens(options),
    ...ssoConfig(options),
    hooks: compatHooks(options),
  };
  const sso = ssoOf(options);
  return {
    // The Better Auth record of a domain proof reaches the verify and the recheck (ruling 61 F4).
    config: sso ? withDomainRecord(config, betterAuthRecord(sso.tokenPrefix)) : config,
    origin,
    origins,
    basePath,
    plugins,
    clientIp: clientIp ?? ((r) => r.headers.get("cf-connecting-ip") || null),
    appOrigin: options.authtempo?.appURL ?? origin,
    appOriginFollows: options.authtempo?.appURL === undefined,
    minPasswordLength: ep?.minPasswordLength ?? BETTER_AUTH_DEFAULTS.minPasswordLength,
    account: {
      changeEmail: options.user?.changeEmail?.enabled === true,
      deleteUser: options.user?.deleteUser?.enabled === true,
      emailOtpChange: otp?.options.changeEmail?.enabled === true,
    },
    changeVerifyBefore: options.emailVerification?.beforeEmailVerification ?? null,
    platformRole: admin ? platformRoleOf(admin.options) : null,
    apiKey: pluginOf(options, "api-key")?.options ?? null,
    sso,
    scim: scimCredentials(options),
  };
}
