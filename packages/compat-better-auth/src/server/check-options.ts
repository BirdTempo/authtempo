import { isAppScheme } from "@authtempo/core";
import { PASSWORD_MAX_LENGTH } from "../errors.js";
import {
  type BetterAuthOptions,
  COMPAT_PLUGIN,
  type CompatPlugin,
  type OrganizationHookOptions,
} from "../types.js";

export interface OptionCheck {
  /** `<path>: <reason>`, sorted. Any entry stops the construction. */
  refusals: string[];
  /** `<path>: <reason>` for accepted options that change nothing authtempo promises. */
  notes: string[];
}

type Rule = (value: unknown, path: string, out: OptionCheck) => void;

/** Plan 9c maps google, apple, github, and linkedin. Core takes any other provider as a list entry. */
const OTHER_PROVIDER = "not mapped; add it through core's social.oidc or social.oauth2";
const NO_REQUEST_HOOKS =
  "core has no request hooks: wrap auth.handler and read auth.tempo.session(request); see the README recipe";
const noRowHook = (name: string) => `core has no row hook on ${name}; see the plan index`;
/**
 * Plan 9g (owner decision 4b and the controller ruling of 2026-10-13): core
 * mints JWTs and is an OAuth 2.1 and OIDC provider on its own routes, and
 * this package maps none of the Better Auth plugins. An MCP access token is
 * a JWT, so a mapping of one without the other would be half a promise.
 */
const JWT_NOT_MAPPED =
  "core mints JWTs on its own routes (`/jwks`, `/token`, `api.jwt`); the Better Auth plugin is not mapped, and a token it issued stops verifying at the cutover; see the plan index";
const PROVIDER_NOT_MAPPED =
  "core has an OAuth 2.1 and OIDC provider on its own routes (`/oauth/*`, the well-known handler); the Better Auth plugin is not mapped; see the plan index";
const NO_SUCH_OPTION = "authtempo has no such option";

const refuse = (out: OptionCheck, path: string, why: string) =>
  out.refusals.push(`${path}: ${why}`);
const note = (out: OptionCheck, path: string, why: string) => out.notes.push(`${path}: ${why}`);

function object(rules: Record<string, Rule>, otherwise = NO_SUCH_OPTION): Rule {
  return (value, path, out) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      refuse(out, path, "expected an object");
      return;
    }
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const p = path ? `${path}.${key}` : key;
      const rule = rules[key];
      if (rule) rule(v, p, out);
      else refuse(out, p, otherwise);
    }
  };
}

const string: Rule = (v, p, out) => {
  if (typeof v !== "string") refuse(out, p, "expected a string");
};
const boolean: Rule = (v, p, out) => {
  if (typeof v !== "boolean") refuse(out, p, "expected a boolean");
};
const fn: Rule = (v, p, out) => {
  if (typeof v !== "function") refuse(out, p, "expected a function");
};
const stringList: Rule = (v, p, out) => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    refuse(out, p, "expected a list of strings");
};
const only =
  (accepted: unknown, why: string): Rule =>
  (v, p, out) => {
    if (v !== accepted) refuse(out, p, why);
  };
const refused =
  (why: string): Rule =>
  (_v, p, out) =>
    refuse(out, p, why);
const noted =
  (why: string): Rule =>
  (_v, p, out) =>
    note(out, p, why);
const seconds =
  (unit: number, min: number, max: number, why: string): Rule =>
  (v, p, out) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v % unit !== 0 || v < min || v > max)
      refuse(out, p, why);
  };

const positiveInteger: Rule = (v, p, out) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
    refuse(out, p, "expected a positive integer");
};
/** membershipLimit and invitationLimit: core takes a number; Better Auth's function form is refused. */
const limitNumber: Rule = (v, p, out) => {
  if (typeof v === "function") refuse(out, p, "a function is refused; pass a positive integer");
  else positiveInteger(v, p, out);
};

/** Visits each key of an object, or refuses a value that is not one. */
function eachKey(
  v: unknown,
  p: string,
  out: OptionCheck,
  visit: (key: string, value: unknown, path: string) => void,
): void {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    refuse(out, p, "expected an object");
    return;
  }
  for (const [key, value] of Object.entries(v))
    if (value !== undefined) visit(key, value, `${p}.${key}`);
}

/** `databaseHooks`: only session.create.before and session.create.after map (plan 9d). */
const databaseHooks: Rule = (v, p, out) =>
  eachKey(v, p, out, (model, ops, modelPath) => {
    if (model !== "session") {
      refuse(out, modelPath, noRowHook(model));
      return;
    }
    eachKey(ops, modelPath, out, (op, times, opPath) => {
      if (op !== "create") {
        refuse(out, opPath, noRowHook(`session.${op}`));
        return;
      }
      eachKey(times, opPath, out, (time, hook, timePath) => {
        if (time === "before" || time === "after") fn(hook, timePath, out);
        else refuse(out, timePath, noRowHook(`session.create.${time}`));
      });
    });
  });

const DAY = 86_400;
const MINUTES = seconds(60, 60, 86_400, "core takes whole minutes from 1 to 1440");

/**
 * Better Auth 1.7.2's organization hook names that core maps (plan 9d;
 * dist/plugins/organization/types.d.mts:296-690, read 2026-10-13). A
 * Record, so a name added to OrganizationHookOptions and not listed here
 * fails the compile.
 */
const MAPPED_ORGANIZATION_HOOKS: Record<keyof OrganizationHookOptions, Rule> = {
  beforeCreateOrganization: fn,
  afterCreateOrganization: fn,
  beforeUpdateOrganization: fn,
  afterUpdateOrganization: fn,
  beforeDeleteOrganization: fn,
  afterDeleteOrganization: fn,
  beforeAddMember: fn,
  afterAddMember: fn,
  beforeRemoveMember: fn,
  afterRemoveMember: fn,
  beforeUpdateMemberRole: fn,
  afterUpdateMemberRole: fn,
  beforeCreateInvitation: fn,
  afterCreateInvitation: fn,
  beforeAcceptInvitation: fn,
  afterAcceptInvitation: fn,
  afterRejectInvitation: fn,
  afterCancelInvitation: fn,
};

/** Better Auth 1.7.2's team hooks, refused by name: core has no teams. */
const TEAM_HOOKS = [
  "beforeCreateTeam",
  "afterCreateTeam",
  "beforeUpdateTeam",
  "afterUpdateTeam",
  "beforeDeleteTeam",
  "afterDeleteTeam",
  "beforeAddTeamMember",
  "afterAddTeamMember",
  "beforeRemoveTeamMember",
  "afterRemoveTeamMember",
];

const organizationHooks = object({
  ...MAPPED_ORGANIZATION_HOOKS,
  ...Object.fromEntries(TEAM_HOOKS.map((name) => [name, refused("core has no teams")])),
  beforeCancelInvitation: refused("core runs no hook before a revoke; use afterCancelInvitation"),
  beforeRejectInvitation: refused("core runs no hook before a decline; use afterRejectInvitation"),
});

const PLUGIN_RULES: Record<string, Rule> = {
  organization: object(
    {
      allowUserToCreateOrganization: only(
        true,
        "core lets every verified user create an organization",
      ),
      // A number maps onto organizations.limits.perUser; a function runs before
      // beforeCreateOrganization (src/server/hooks.ts, plan 9d).
      organizationLimit: (v, p, out) => {
        if (typeof v !== "function") positiveInteger(v, p, out);
      },
      membershipLimit: limitNumber,
      invitationLimit: limitNumber,
      creatorRole: only("owner", "core makes the creator owner"),
      invitationExpiresIn: seconds(DAY, DAY, 365 * DAY, "core takes whole days"),
      requireEmailVerificationOnInvitation: only(
        true,
        "core always needs a verified address equal to the invitation's",
      ),
      cancelPendingInvitationsOnReInvite: only(
        true,
        "core replaces a pending invitation on a second invite",
      ),
      sendInvitationEmail: fn,
      organizationHooks,
    },
    "core's organizations have fixed ranks; custom roles, access control, teams, and this option are refused",
  ),
  passkey: object({
    rpID: string,
    rpName: string,
    origin: (v, p, out) => {
      if (typeof v !== "string") stringList(v, p, out);
    },
  }),
  "magic-link": object({
    sendMagicLink: fn,
    expiresIn: seconds(60, 60, 86_400, "core takes whole minutes"),
    disableSignUp: only(false, "core creates the user at the first magic link"),
    storeToken: (v, p, out) => {
      if (v === "plain") note(out, p, "accepted: core stores only the hash of the token");
      else if (v !== "hashed") refuse(out, p, "expected hashed or plain");
    },
  }),
  // Better Auth 1.7.2's EmailOTPOptions (dist/plugins/email-otp/types.d.mts, read 2026-10-13).
  "email-otp": object({
    sendVerificationOTP: fn,
    otpLength: (v, p, out) => {
      if (v !== 6 && v !== 8) refuse(out, p, "core generates 6 or 8 digits");
    },
    expiresIn: (v, p, out) => {
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 60 || v > 3600)
        refuse(out, p, "core takes 60 to 3600 seconds, rounded up to whole minutes");
    },
    allowedAttempts: (v, p, out) => {
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 3 || v > 10)
        refuse(out, p, "core takes 3 to 10");
    },
    storeOTP: only("hashed", "core stores a keyed hash; pass hashed or leave it out"),
    disableSignUp: only(false, "core creates the user at the first code"),
    generateOTP: refused("core makes the code itself, from crypto.getRandomValues"),
    overrideDefaultEmailVerification: only(
      false,
      "core's verify mail is a link; a code for it is a later input (see the plan index)",
    ),
    sendVerificationOnSignUp: only(false, "core mails a verify link at sign-up, not a code"),
    resendStrategy: only("rotate", "core sends a new code at every request"),
    changeEmail: refused("core has no change of address by code; see the plan index"),
    rateLimit: refused("core's owned limiter has fixed limits per flow"),
  }),
  "two-factor": object({
    issuer: (v, p, out) => {
      if (typeof v !== "string" || v.length < 1 || v.length > 80 || v.includes(":"))
        refuse(out, p, "core takes 1 to 80 characters with no colon");
    },
    totpOptions: object({
      digits: only(6, "core makes 6-digit codes"),
      period: only(30, "core fixes the step at 30 seconds"),
      backupCodes: refused("core always offers the backup codes"),
      allowPasswordless: only(false, "core asks for the password at every change of the factor"),
      disable: only(false, "core serves the TOTP code whenever the plugin is on"),
    }),
    // Core has an email second factor since plan 12c, but it mails through
    // `totp.emailMail`, and Better Auth's `otpOptions.sendOTP` would be a
    // second sender. The shim maps none, so the email method is core's own.
    otpOptions: refused(
      "core's email second factor sends through totp.emailMail; the shim maps no Better Auth sender, so send-otp stays NOT_SUPPORTED; see the plan index",
    ),
    backupCodeOptions: object({
      amount: (v, p, out) => {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 5 || v > 20)
          refuse(out, p, "core takes an integer from 5 to 20");
      },
      length: (v, p, out) => {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 23 || v > 32)
          refuse(
            out,
            p,
            "core takes an integer from 23 to 32: a backup code holds 112 bits or more (ASVS 5.0 6.5.2)",
          );
      },
      customBackupCodesGenerate: refused("core makes its own backup codes"),
      storeBackupCodes: refused("core stores a keyed hash of each code; leave it out"),
      allowPasswordless: only(false, "core asks for the password at every change of the factor"),
    }),
    skipVerificationOnEnable: only(false, "core turns the factor on only after a right code"),
    allowPasswordless: only(false, "core asks for the password at every change of the factor"),
    twoFactorTable: refused("core keeps the factor in its own ta_second_factor and ta_totp tables"),
    schema: refused("core keeps the factor in its own ta_second_factor and ta_totp tables"),
    twoFactorCookieMaxAge: refused("core's challenge lives 5 minutes; the cookie lives 600 s"),
    trustDeviceMaxAge: seconds(DAY, DAY, 365 * DAY, "core takes whole days from 1 to 365"),
    // Better Auth 1.7.2 turns the lockout on by default (verify-two-factor.mjs, read 2026-10-13).
    accountLockout: (v, p, out) => {
      const o = v as Record<string, unknown> | null;
      if (
        typeof o !== "object" ||
        o === null ||
        o.enabled !== false ||
        Object.keys(o).some((k) => k !== "enabled" && o[k] !== undefined)
      )
        refuse(
          out,
          p,
          "core has no account lockout; pass { enabled: false }. Core caps the code checks per user at 10 per 15 minutes and 30 per 24 hours, and 5 codes per challenge",
        );
    },
  }),
  bearer: object({
    requireSignature: only(false, "core's bearer token is opaque and needs no signature"),
  }),
  expo: object({}, "core's handoff serves the Expo client; this option is refused"),
};

const FOREIGN_PLUGINS: Record<string, string> = {
  admin: "authtempo has no admin plugin",
  jwt: JWT_NOT_MAPPED,
  mcp: PROVIDER_NOT_MAPPED,
  cimd: PROVIDER_NOT_MAPPED,
  "oidc-provider": PROVIDER_NOT_MAPPED,
  "oauth-provider": PROVIDER_NOT_MAPPED,
  "api-key": "not mapped; see the plan index",
  anonymous: "authtempo has no anonymous sign-in",
  username: "authtempo has no username sign-in",
};

const plugins: Rule = (v, p, out) => {
  if (!Array.isArray(v)) {
    refuse(out, p, "expected a list");
    return;
  }
  // pluginOf and the mapping read only the first entry of an id, so a second one would be dropped in silence.
  const seen = new Set<string>();
  for (const plugin of v as { kind?: unknown; id?: unknown; options?: unknown }[]) {
    const id = typeof plugin?.id === "string" ? plugin.id : "unknown";
    const path = `plugins[${id}]`;
    if (seen.has(id)) {
      refuse(out, path, "given twice; pass one");
      continue;
    }
    seen.add(id);
    const rule = PLUGIN_RULES[id];
    if (plugin?.kind === COMPAT_PLUGIN && rule) rule(plugin.options ?? {}, path, out);
    else refuse(out, path, FOREIGN_PLUGINS[id] ?? "authtempo has no such plugin");
  }
};

/** google, github, and linkedin: core's presets take the id and the secret only. */
const idAndSecretShape = object({ clientId: string, clientSecret: string });
/** Core refuses a missing or empty id or secret at createAuth; refuse it here with the option's path. */
const idAndSecret: Rule = (v, p, out) => {
  idAndSecretShape(v, p, out);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return;
  const o = v as Record<string, unknown>;
  for (const key of ["clientId", "clientSecret"]) {
    // Trim for this check only: a whitespace-only value is as empty as "".
    const value = o[key];
    if (value === undefined || (typeof value === "string" && value.trim() === ""))
      refuse(out, `${p}.${key}`, "required");
  }
};
const apple = object({
  clientId: string,
  teamId: string,
  keyId: string,
  privateKey: string,
  clientSecret: refused(
    "core signs the Apple client secret itself from teamId, keyId, and privateKey",
  ),
});

const TOP: Record<string, Rule> = {
  appName: string,
  baseURL: string,
  basePath: string,
  secret: string,
  trustedOrigins: (v, p, out) => {
    if (typeof v === "function") {
      refuse(out, p, "a function is refused; pass a list of exact origins");
      return;
    }
    stringList(v, p, out);
    if (!Array.isArray(v)) return;
    // Core matches the Origin header by exact set membership, and throws on a
    // wildcard after this check (core config.ts). An entry with a path or a
    // trailing slash never matches, so every browser POST from it answers 403.
    v.forEach((x, i) => {
      if (typeof x !== "string" || isAppScheme(x)) return;
      let origin = "";
      try {
        origin = new URL(x).origin;
      } catch {}
      // The URL parser accepts `*` in a host, so a wildcard needs its own test.
      if (origin !== x || x.includes("*"))
        refuse(
          out,
          `${p}[${i}]`,
          "expected an exact origin (scheme://host[:port], no path or trailing slash) or an app scheme (myapp://); Better Auth's wildcard form (https://*.example.com) is refused",
        );
    });
  },
  database: (v, p, out) => {
    // drizzleAdapter's own refusals join this one list (plan 9b), each already a `<path>: <reason>`.
    for (const r of (v as { refusals?: readonly string[] } | null)?.refusals ?? [])
      out.refusals.push(r);
    if ((v as { kind?: unknown } | null)?.kind !== "authtempo-compat-database") {
      refuse(
        out,
        p,
        "pass drizzleAdapter(db, { provider, schema }) or betterAuthSchemaStorage(...) from this package",
      );
    }
  },
  emailAndPassword: object({
    enabled: boolean,
    minPasswordLength: (v, p, out) => {
      // 8 is core's lowest minLength (config.ts); the maximum is the one constant in errors.ts.
      if (typeof v !== "number" || !Number.isInteger(v) || v < 8 || v > PASSWORD_MAX_LENGTH)
        refuse(out, p, `core accepts 8 to ${PASSWORD_MAX_LENGTH}`);
    },
    maxPasswordLength: only(
      PASSWORD_MAX_LENGTH,
      `core fixes the maximum at ${PASSWORD_MAX_LENGTH}`,
    ),
    // Plan 12b Task 15: maps to core's password.requireVerified.
    requireEmailVerification: boolean,
    autoSignIn: only(true, "core signs the person in at sign-up"),
    disableSignUp: only(false, "core serves sign-up whenever passwords are on"),
    revokeSessionsOnPasswordReset: only(true, "core ends every session on a reset"),
    resetPasswordTokenExpiresIn: MINUTES,
    sendResetPassword: fn,
  }),
  emailVerification: object({
    sendVerificationEmail: fn,
    sendOnSignUp: only(true, "core mails the verify link at every sign-up"),
    // Better Auth mails a new link at an unverified sign-in only with this
    // key true (dist/api/routes/sign-in.mjs line 342, read 2026-10-14).
    // Core always mails one, so absent and true are accepted.
    sendOnSignIn: only(
      true,
      "core sends a new verify link at each unverified sign-in, at most 3 per 15 minutes",
    ),
    autoSignInAfterVerification: only(true, "core signs the person in at the verify link"),
    expiresIn: MINUTES,
  }),
  socialProviders: (v, p, out) => {
    if (typeof v !== "object" || v === null) {
      refuse(out, p, "expected an object");
      return;
    }
    for (const [name, config] of Object.entries(v)) {
      if (config === undefined) continue;
      if (name === "google" || name === "github" || name === "linkedin")
        idAndSecret(config, `${p}.${name}`, out);
      else if (name === "apple") {
        apple(config, `${p}.apple`, out);
        // A null or non-object entry is refused above: read its keys only on an object.
        if (typeof config !== "object" || config === null) continue;
        const a = config as Record<string, unknown>;
        if (!a.teamId || !a.keyId || !a.privateKey)
          refuse(out, `${p}.apple`, "needs teamId, keyId, and privateKey");
      } else refuse(out, `${p}.${name}`, OTHER_PROVIDER);
    }
  },
  session: object({
    expiresIn: seconds(DAY, DAY, 3650 * DAY, "core takes whole days"),
    updateAge: seconds(DAY, DAY, 3650 * DAY, "core takes whole days"),
    cookieCache: noted("accepted and has no effect: every request reads the session row"),
    storeSessionInDatabase: only(true, "core keeps every session in the session table"),
  }),
  advanced: object({
    ipAddress: object({
      ipAddressHeaders: stringList,
      disableIpTracking: (v, p, out) => {
        if (v === true)
          note(
            out,
            p,
            "accepted: password sign-in, the magic link, the email codes, and the reset request skip their per-IP limits and keep their per-email limits; every other flow counts all requests in one shared per-IP bucket. The cost: one caller can try one password on many addresses, bounded only by each address's limit, and can guess 10 email codes on each of many addresses per 15 minutes (at most 100 a day per address), about 1 takeover per 100,000 addresses per window, and each address gets the code mails",
          );
        else if (v !== false) refuse(out, p, "expected a boolean");
      },
    }),
    defaultCookieAttributes: object({
      sameSite: (v, p, out) => {
        if (typeof v !== "string" || !["lax", "none"].includes(v.toLowerCase()))
          refuse(out, p, "core sends Lax or None");
      },
    }),
    database: object({ generateId: noted("accepted and has no effect: core makes its own ids") }),
  }),
  rateLimit: object(
    {
      enabled: (v, p, out) => {
        if (v === false)
          note(out, p, "core's owned limiter still runs: its limits per flow are fixed");
        else if (v !== true) refuse(out, p, "expected a boolean");
      },
    },
    "core's owned limiter has fixed limits per flow; custom windows, rules, and storage are refused",
  ),
  plugins,
  telemetry: object({ enabled: only(false, "authtempo sends no telemetry") }),
  authtempo: object({
    passwordHash: (v, p, out) => {
      const s = v as { hash?: unknown; verify?: unknown; dummy?: unknown } | null;
      if (
        typeof s?.hash !== "function" ||
        typeof s.verify !== "function" ||
        typeof s.dummy !== "function"
      )
        refuse(out, p, "expected a PasswordHashSeam");
    },
    // Core checks that appURL is an exact origin in trustedOrigins (core config.ts).
    appURL: string,
  }),
  databaseHooks,
  hooks: refused(NO_REQUEST_HOOKS),
  secondaryStorage: refused(
    "core keeps sessions in the session table; secondary storage is refused",
  ),
};

/** The one plugin lookup. `checkOptions` and `mapOptions` both use it. */
export function pluginOf<I extends CompatPlugin["id"]>(
  options: BetterAuthOptions,
  id: I,
): Extract<CompatPlugin, { id: I }> | null {
  for (const p of options.plugins ?? []) {
    // A null entry is refused by the plugins rule; the lookup must not throw on it.
    if (typeof p !== "object" || p === null) continue;
    if ((p as CompatPlugin).kind === COMPAT_PLUGIN && p.id === id)
      return p as Extract<CompatPlugin, { id: I }>;
  }
  return null;
}

/** The app schemes of trustedOrigins, which core's handoff redirects to. Core's isAppScheme is the one copy of the rule. */
export function appSchemes(options: BetterAuthOptions): string[] {
  const list = Array.isArray(options.trustedOrigins) ? options.trustedOrigins : [];
  return list.filter((o) => typeof o === "string" && isAppScheme(o));
}

/** The allow list (spec 16.1). Pure: no I/O, no throw. */
export function checkOptions(options: BetterAuthOptions): OptionCheck {
  const out: OptionCheck = { refusals: [], notes: [] };
  object(TOP)(options, "", out);
  for (const key of ["baseURL", "secret", "database"] as const) {
    if (options[key] === undefined) refuse(out, key, "required");
  }
  if (typeof options.baseURL === "string") {
    let path = "";
    try {
      path = new URL(options.baseURL).pathname.replace(/\/+$/, "");
    } catch {
      refuse(out, "baseURL", "expected an absolute URL");
    }
    if (path && options.basePath !== undefined && options.basePath !== path) {
      refuse(out, "baseURL", `its path ${path} differs from basePath ${options.basePath}`);
    }
  }
  if (options.emailAndPassword?.enabled === true) {
    if (typeof options.emailVerification?.sendVerificationEmail !== "function") {
      refuse(
        out,
        "emailVerification.sendVerificationEmail",
        "required: core mails a verify link at every sign-up",
      );
    }
    if (typeof options.emailAndPassword.sendResetPassword !== "function") {
      refuse(
        out,
        "emailAndPassword.sendResetPassword",
        "required: core serves the reset routes whenever passwords are on",
      );
    }
  }
  const org = pluginOf(options, "organization")?.options;
  if (org && typeof org.sendInvitationEmail !== "function") {
    refuse(
      out,
      "plugins[organization].sendInvitationEmail",
      "required: core mails every invitation",
    );
  }
  const magic = pluginOf(options, "magic-link")?.options;
  if (magic && typeof magic.sendMagicLink !== "function")
    refuse(out, "plugins[magic-link].sendMagicLink", "required");
  const otp = pluginOf(options, "email-otp")?.options;
  if (otp && typeof otp.sendVerificationOTP !== "function")
    refuse(out, "plugins[email-otp].sendVerificationOTP", "required");
  const verifyTtl = options.emailVerification?.expiresIn;
  if (magic && verifyTtl !== undefined && verifyTtl !== (magic.expiresIn ?? 300)) {
    refuse(
      out,
      "emailVerification.expiresIn",
      "core gives the verify link the magic link's lifetime",
    );
  }
  // Better Auth's verify link lives 3600 s by default. Core gives it the magic
  // link's lifetime, so say so when the app set no verify lifetime (review M-1).
  if (magic && verifyTtl === undefined && options.emailAndPassword?.enabled === true) {
    note(
      out,
      "emailVerification.expiresIn",
      `not set: the verify link lives ${magic.expiresIn ?? 300} s, the magic link's lifetime, not Better Auth's verify default of 3600 s`,
    );
  }
  const pk = pluginOf(options, "passkey")?.options;
  if (pk) {
    for (const key of ["rpID", "rpName", "origin"] as const) {
      if (pk[key] === undefined || pk[key] === null)
        refuse(out, `plugins[passkey].${key}`, "required");
    }
  }
  const tf = pluginOf(options, "two-factor")?.options;
  if (tf && options.emailAndPassword?.enabled !== true)
    refuse(
      out,
      "plugins[two-factor]",
      "needs emailAndPassword.enabled: core's second factor gates the password sign-in only",
    );
  if (tf && tf.accountLockout === undefined)
    note(
      out,
      "plugins[two-factor].accountLockout",
      "not set: Better Auth locks an account for 900 s after 10 wrong codes; core has no account lockout and caps the code checks per user at 10 per 15 minutes and 30 per 24 hours, and 5 codes per challenge",
    );
  if (pluginOf(options, "expo") && appSchemes(options).length === 0) {
    refuse(out, "plugins[expo]", "needs the app scheme, for example myapp://, in trustedOrigins");
  }
  // The methods core's system-browser page lists (map-options.ts pluginConfig, core sign-in-page.ts).
  const pageHasMethod =
    pluginOf(options, "magic-link") !== null ||
    options.emailAndPassword?.enabled === true ||
    options.socialProviders?.google !== undefined ||
    options.socialProviders?.apple !== undefined ||
    options.socialProviders?.github !== undefined ||
    options.socialProviders?.linkedin !== undefined ||
    pluginOf(options, "passkey") !== null;
  if (pluginOf(options, "expo") && !pageHasMethod) {
    refuse(
      out,
      "plugins[expo]",
      "the system-browser page has no sign-in method; add magicLink, emailAndPassword, a social provider, or passkey",
    );
  }
  out.refusals.sort();
  out.notes.sort();
  return out;
}
