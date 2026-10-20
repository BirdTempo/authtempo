import { DELETE_CONFIRM_TTL_MINUTES, isAppScheme, normalizeSlug } from "@authtempo/core";
import {
  CORE_STATEMENTS,
  NAME_RE,
  type Statements,
  statementFault,
  union,
} from "@authtempo/core/access";
import { PASSWORD_MAX_LENGTH } from "../errors.js";
import {
  CORE_KEY,
  CORE_RESOURCES,
  corePermissionsOf,
  toCoreName,
  toCoreNames,
} from "../role-map.js";
import {
  type BetterAuthOptions,
  COMPAT_PLUGIN,
  type CompatPlugin,
  type OrganizationHookOptions,
} from "../types.js";
import { adminRolesOf, COMPAT_RANKS } from "./admin.js";

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

/**
 * The row hooks that map: `session.create` (plan 9d), and `user.create`,
 * `user.update`, `user.delete`, `account.create`, and `account.delete` (plan
 * 12a). src/server/hooks.ts maps each one onto a core hook.
 */
const ROW_HOOKS: Record<string, readonly string[]> = {
  session: ["create"],
  user: ["create", "update", "delete"],
  account: ["create", "delete"],
};

const databaseHooks: Rule = (v, p, out) =>
  eachKey(v, p, out, (model, ops, modelPath) => {
    const allowed = ROW_HOOKS[model];
    if (!allowed) {
      refuse(out, modelPath, noRowHook(model));
      return;
    }
    eachKey(ops, modelPath, out, (op, times, opPath) => {
      if (!allowed.includes(op)) {
        refuse(out, opPath, noRowHook(`${model}.${op}`));
        return;
      }
      eachKey(times, opPath, out, (time, hook, timePath) => {
        if (time === "before" || time === "after") fn(hook, timePath, out);
        else refuse(out, timePath, noRowHook(`${model}.${op}.${time}`));
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
  // Plan 12k Task 11: core's ten team hook points.
  beforeCreateTeam: fn,
  afterCreateTeam: fn,
  beforeUpdateTeam: fn,
  afterUpdateTeam: fn,
  beforeDeleteTeam: fn,
  afterDeleteTeam: fn,
  beforeAddTeamMember: fn,
  afterAddTeamMember: fn,
  beforeRemoveTeamMember: fn,
  afterRemoveTeamMember: fn,
};

const organizationHooks = object({
  ...MAPPED_ORGANIZATION_HOOKS,
  beforeCancelInvitation: refused("core runs no hook before a revoke; use afterCancelInvitation"),
  beforeRejectInvitation: refused("core runs no hook before a decline; use afterRejectInvitation"),
});

/** Each refused admin option names spec section 26, where core's operator tools are (plan 12f). */
const ADMIN_RULES: Record<string, Rule> = {
  adminRoles: (v, p, out) => {
    if (typeof v !== "string" && !(Array.isArray(v) && v.every((r) => typeof r === "string"))) {
      refuse(out, p, "expected a string or a list of strings");
      return;
    }
    const roles = adminRolesOf({ adminRoles: v as string | string[] });
    if (roles.length !== 1 || !Object.hasOwn(COMPAT_RANKS, roles[0] ?? ""))
      refuse(
        out,
        p,
        `core has one platform role: name exactly one rank of ${Object.keys(COMPAT_RANKS).join(", ")} (spec section 26 item 1)`,
      );
  },
  impersonationSessionDuration: seconds(
    60,
    300,
    14_400,
    "core takes a whole number of minutes from 5 to 240 (spec section 26 item 3)",
  ),
  // Better Auth's default "user" changes nothing: a user who is not an operator has no role.
  defaultRole: only(
    "user",
    "core keeps no role on a user; the platform role is a rank in the platform organization (spec section 26 item 1)",
  ),
  defaultBanReason: refused(
    "core takes the reason of each ban from the call: banReason, else the admin path (spec section 26 item 5)",
  ),
  defaultBanExpiresIn: refused(
    "core takes the end of each ban from the call: banExpiresIn, else no end (spec section 26 item 5)",
  ),
  bannedUserMessage: refused(
    "core answers a banned user with its own code and text, BANNED_USER here (spec section 26 item 6)",
  ),
  adminUserIds: refused(
    "core gives operator power by the platform role only, never by a list of user ids (spec section 26 item 1)",
  ),
  allowImpersonatingAdmins: only(
    false,
    "core never lets an operator impersonate a platform operator (spec section 26 item 9)",
  ),
  schema: refused(
    "core keeps the ban in its own columns taBannedAt, taBanReason, and taBanUntil (spec section 26 item 14)",
  ),
  ac: refused(
    "custom permission statements and roles for operators are row 12k, not core's operator tools (spec section 26 item 15)",
  ),
  roles: refused(
    "custom permission statements and roles for operators are row 12k, not core's operator tools (spec section 26 item 15)",
  ),
};
/** Spec 29 item 18: the section that each refusal of the access control map names. */
const ITEM_18 = "(spec 29 item 18)";
/** Spec 29 item 19: the section that each refusal of the teams map names. */
const ITEM_19 = "(spec 29 item 19)";

/** The two team limits: core takes a number, never a function (the 9d rule). */
const teamLimit: Rule = (v, p, out) => {
  if (typeof v === "function")
    refuse(out, p, `a function is refused; pass a positive integer ${ITEM_19}`);
  else if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
    refuse(out, p, `core takes a positive integer ${ITEM_19}`);
};

/**
 * `teams` of Better Auth 1.7.2 (types.d.mts:83 to :143, read 2026-10-21):
 * every key. Each one maps onto core's `organizations.teams` and the two
 * limits (map-options.ts), or is refused here.
 */
const teams = object({
  enabled: boolean,
  defaultTeam: object({
    enabled: boolean,
    customCreateDefaultTeam: refused(
      `core creates the default team itself, named as the organization ${ITEM_19}`,
    ),
  }),
  maximumTeams: teamLimit,
  maximumMembersPerTeam: teamLimit,
  allowRemovingAllTeams: boolean,
});

const plainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** An app that names core's `apiToken` itself would get core's token rights. */
const CORE_TOKEN_NAME = `${CORE_KEY} is core's name of Better Auth's apiKey; name the resource apiKey ${ITEM_18}`;

/**
 * `ac`: the object of `createAccessControl` from `better-auth/plugins/access`
 * (this package's `./plugins/access`). Its own resources become core's
 * `organizations.statements`, so each name follows core's name rule. A core
 * resource keeps core's actions: an action that core lacks is refused, not
 * dropped. `apiKey` is core's `apiToken`, so `apiToken` itself is refused.
 */
const accessControl: Rule = (v, p, out) => {
  const a = v as { statements?: unknown; newRole?: unknown } | null;
  if (typeof a?.newRole !== "function" || !plainObject(a.statements)) {
    refuse(
      out,
      p,
      `expected createAccessControl(statements) of better-auth/plugins/access ${ITEM_18}`,
    );
    return;
  }
  for (const [given, actions] of Object.entries(a.statements)) {
    const at = `${p}.statements.${given}`;
    if (given === CORE_KEY) {
      refuse(out, at, CORE_TOKEN_NAME);
      continue;
    }
    const resource = toCoreName(given);
    if (CORE_RESOURCES.includes(resource)) {
      const core: readonly string[] = CORE_STATEMENTS[resource as keyof typeof CORE_STATEMENTS];
      if (!Array.isArray(actions) || actions.some((x) => !core.includes(x)))
        refuse(out, at, `core's ${resource} takes only the actions ${core.join(", ")} ${ITEM_18}`);
      continue;
    }
    if (!NAME_RE.test(resource))
      refuse(out, at, `core takes a resource name of ^[a-z][a-zA-Z0-9-]{0,31}$ ${ITEM_18}`);
    else if (
      !Array.isArray(actions) ||
      actions.length === 0 ||
      actions.some((x, i) => typeof x !== "string" || !NAME_RE.test(x) || actions.indexOf(x) !== i)
    )
      refuse(
        out,
        at,
        `core takes a list of one or more distinct action names of ^[a-z][a-zA-Z0-9-]{0,31}$ ${ITEM_18}`,
      );
  }
};

/** `eachKey` whose refusal of a value that is no object names spec 29 item 18. */
function eachAccessKey(
  v: unknown,
  p: string,
  out: OptionCheck,
  visit: (key: string, value: unknown, path: string) => void,
): void {
  if (plainObject(v)) eachKey(v, p, out, visit);
  else refuse(out, p, `expected an object ${ITEM_18}`);
}

/** `roles`: the roles of `ac.newRole`. checkOptions checks each one against `ac` and the ranks. */
const roleTable: Rule = (v, p, out) =>
  eachAccessKey(v, p, out, (_name, r, path) => {
    const x = r as { statements?: unknown; authorize?: unknown } | null;
    if (typeof x?.authorize !== "function" || !plainObject(x.statements))
      refuse(out, path, `expected a role of ac.newRole(statements) ${ITEM_18}`);
    else if (Object.hasOwn(x.statements, CORE_KEY))
      refuse(out, `${path}.statements.${CORE_KEY}`, CORE_TOKEN_NAME);
  });

/** `dynamicAccessControl`: core's dynamic roles. Each refusal names spec 29 item 18. */
const dynamicAccess: Rule = (v, p, out) => {
  if (!plainObject(v)) {
    refuse(out, p, `expected { enabled, maximumRolesPerOrganization? } ${ITEM_18}`);
    return;
  }
  object(
    {
      enabled: (x, q, o) => {
        if (typeof x !== "boolean") refuse(o, q, `expected a boolean ${ITEM_18}`);
      },
      // The 9d rule for a limit: core takes a number, never a function.
      maximumRolesPerOrganization: (x, q, o) => {
        if (typeof x === "function")
          refuse(o, q, `a function is refused; pass a positive integer from 1 to 1000 ${ITEM_18}`);
        else if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 1 || x > 1000)
          refuse(o, q, `core takes an integer from 1 to 1000 ${ITEM_18}`);
      },
    },
    `${NO_SUCH_OPTION} ${ITEM_18}`,
  )(v, p, out);
};

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
      // Plan 12k Task 10: core's statements, roles, and dynamic roles. The
      // ranks come from authtempo.roleRanks, because Better Auth's roles have none.
      ac: accessControl,
      roles: roleTable,
      // Plan 12k Task 11: core's teams and the two team limits.
      teams,
      dynamicAccessControl: dynamicAccess,
    },
    "core's organizations refuse schema, disableOrganizationDeletion, and this option",
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
    // Plan 12b: the one sign-up rule of core; checkOptions refuses a mix of methods.
    disableSignUp: boolean,
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
    // Plan 12b: the one sign-up rule of core; checkOptions refuses a mix of methods.
    disableSignUp: boolean,
    generateOTP: refused("core makes the code itself, from crypto.getRandomValues"),
    overrideDefaultEmailVerification: only(
      false,
      "core's verify mail is a link; a code for it is a later input (see the plan index)",
    ),
    sendVerificationOnSignUp: only(false, "core mails a verify link at sign-up, not a code"),
    resendStrategy: only("rotate", "core sends a new code at every request"),
    // Plan 12a: the two change paths of Better Auth 1.7.2 map onto core's change by code.
    changeEmail: object({
      enabled: boolean,
      verifyCurrentEmail: only(
        false,
        "core proves the new address; a code to the old address first is a later input (see the plan index)",
      ),
    }),
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
  admin: object(ADMIN_RULES, "not mapped onto core's operator tools (spec section 26 item 14)"),
};

const FOREIGN_PLUGINS: Record<string, string> = {
  jwt: JWT_NOT_MAPPED,
  mcp: PROVIDER_NOT_MAPPED,
  cimd: PROVIDER_NOT_MAPPED,
  "oidc-provider": PROVIDER_NOT_MAPPED,
  "oauth-provider": PROVIDER_NOT_MAPPED,
  "api-key": "not mapped; see the plan index",
  anonymous: "authtempo has no anonymous sign-in",
  username: "authtempo has no username sign-in",
  // Better Auth 1.7.2 ids (dist/plugins/captcha and dist/plugins/haveibeenpwned, read 2026-10-15).
  // Core has both checks (plan 12b); the shim does not pass them, so name the core option.
  captcha:
    "not mapped; use core's captcha option (@authtempo/core) with @authtempo/captcha-turnstile",
  "have-i-been-pwned":
    "not mapped; use core's password.breachCheck option (@authtempo/core) with @authtempo/breach-check",
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

/**
 * Better Auth 1.7.2's per-provider sign-up keys (@better-auth/core
 * dist/oauth2/oauth-provider.d.mts lines 238 and 242, read 2026-10-15).
 * disableSignUp votes in core's one sign-up rule (signUpVotes, plan 12b).
 * Core has no sign-up that the caller asks for, so disableImplicitSignUp is
 * refused.
 */
const PROVIDER_SIGN_UP: Record<string, Rule> = {
  disableSignUp: boolean,
  disableImplicitSignUp: refused("core's signUp rule covers every method; see disableSignUp"),
};
/** google, github, and linkedin: core's presets take the id and the secret only. */
const idAndSecretShape = object({ clientId: string, clientSecret: string, ...PROVIDER_SIGN_UP });
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
  ...PROVIDER_SIGN_UP,
  clientSecret: refused(
    "core signs the Apple client secret itself from teamId, keyId, and privateKey",
  ),
});

const TOP: Record<string, Rule> = {
  appName: string,
  baseURL: string,
  basePath: string,
  secret: string,
  // Plan 12b: Better Auth's versioned secrets. Core reads a row of before
  // version 9 of the schema as version 1, so version 0 has no meaning there.
  // Core checks every other rule of an entry (spec 22), and betterAuth turns
  // its ConfigError into the same error.
  secrets: (v, p, out) => {
    if (!Array.isArray(v)) {
      refuse(out, p, "expected a list of { version, value }");
      return;
    }
    v.forEach((e, i) => {
      const entry = e as { version?: unknown; value?: unknown } | null;
      if (entry?.version === 0)
        refuse(
          out,
          `${p}[${i}].version`,
          "core reads a row from before schema version 9 as version 1; renumber from 1",
        );
    });
  },
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
    // checkOptions refuses false without requireEmailVerification: true (plan 12b).
    autoSignIn: boolean,
    // Plan 12b: the one sign-up rule of core; checkOptions refuses a mix of methods.
    disableSignUp: boolean,
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
    // Plan 12a: core's user.beforeVerify and user.afterVerify, and the change
    // of address. VERIFY_CALLBACK_PLACES in hooks.ts lists Better Auth's lines.
    beforeEmailVerification: fn,
    afterEmailVerification: fn,
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
    // Better Auth counts seconds (context/create-context.mjs:148, default
    // 86400, read 2026-10-17). Core counts whole minutes from 1 to 1440, and
    // the map rounds up (plan 12a).
    freshAge: seconds(
      1,
      1,
      86_400,
      "core takes 1 to 86400 seconds, rounded up to whole minutes; 0 turns the check off and is refused: the fresh rule is a promise of core",
    ),
    // Better Auth 1.7.2 (dist/api/routes/session.mjs:35 to :37 and :178 to
    // :190, read 2026-10-17): a GET writes nothing and a POST refreshes.
    // Core's session.deferRefresh has the same rule (plan 12a).
    deferSessionRefresh: boolean,
  }),
  // Plan 12a. Better Auth 1.7.2's user options (dist/api/routes/update-user.mjs, read 2026-10-17).
  user: object({
    changeEmail: object({
      enabled: boolean,
      sendChangeEmailConfirmation: refused(
        "core proves the new address and mails nothing to the old one first; a confirm by the old address is a later input (see the plan index)",
      ),
      updateEmailWithoutVerification: only(
        false,
        "core moves an address only after a proof of the new address",
      ),
    }),
    deleteUser: object({
      enabled: boolean,
      beforeDelete: fn,
      afterDelete: fn,
      // Core's account.deleteConfirm (plan 12a Task 20). Better Auth 1.7.2
      // mails the link and deletes at GET /delete-user/callback
      // (dist/api/routes/update-user.mjs:317 to :329 and :352 to :405, read
      // 2026-10-17). Core serves a page there, and the page posts the token.
      sendDeleteAccountVerification: fn,
      // Core counts whole minutes in its own bounds; the shim reads them from core.
      deleteTokenExpiresIn: seconds(
        60,
        DELETE_CONFIRM_TTL_MINUTES.min * 60,
        DELETE_CONFIRM_TTL_MINUTES.max * 60,
        `core takes a whole number of minutes from ${DELETE_CONFIRM_TTL_MINUTES.min * 60} to ${DELETE_CONFIRM_TTL_MINUTES.max * 60} seconds`,
      ),
    }),
  }),
  // Plan 12a. Better Auth 1.7.2 links on the provider's verified flag or a
  // trusted provider, and an equal address unless allowDifferentEmails
  // (dist/api/routes/callback.mjs:173 and :177, read 2026-10-17). Core links
  // a verified equal address only.
  account: object({
    accountLinking: object({
      enabled: only(true, "core links a verified equal address at sign-in"),
      allowDifferentEmails: only(
        false,
        "core links a provider only with the account's own verified address; a different address answers email_mismatch",
      ),
      trustedProviders: refused(
        "a trusted provider lets an unverified provider address take an account; core links on a verified address only",
      ),
      allowUnlinkingAll: only(false, "core keeps at least one way in (the last-credential guard)"),
      updateUserInfoOnLink: refused("core fills a missing name and image at sign-in only"),
      disableImplicitLinking: refused("core links a verified equal address at sign-in"),
    }),
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
    // Plan 12f: the slug of the platform organization; checkOptions ties it to plugins[admin].
    platformOrganization: (v, p, out) => {
      if (typeof v !== "string" || normalizeSlug(v) === null) refuse(out, p, "expected a slug");
    },
    // Plan 12k Task 10: the rank of each Better Auth role; checkOptions holds it to the roles.
    roleRanks: (v, p, out) =>
      eachAccessKey(v, p, out, (_name, rank, path) => {
        if (typeof rank !== "number" || !Number.isSafeInteger(rank) || rank < 1)
          refuse(out, path, `expected a positive integer ${ITEM_18}`);
      }),
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

/**
 * The disableSignUp of each configured method that creates a user (plan 12b),
 * by its option path. `checkOptions` refuses a mixed list, and `mapOptions`
 * maps a list of only true to core's `signUp: false`: one list for both.
 */
export function signUpVotes(options: BetterAuthOptions): { path: string; closed: boolean }[] {
  const votes: { path: string; closed: boolean }[] = [];
  if (options.emailAndPassword?.enabled === true)
    votes.push({
      path: "emailAndPassword",
      closed: options.emailAndPassword.disableSignUp === true,
    });
  const magic = pluginOf(options, "magic-link");
  if (magic)
    votes.push({ path: "plugins[magic-link]", closed: magic.options.disableSignUp === true });
  const otp = pluginOf(options, "email-otp");
  if (otp) votes.push({ path: "plugins[email-otp]", closed: otp.options.disableSignUp === true });
  const social = options.socialProviders;
  if (typeof social === "object" && social !== null)
    for (const [name, p] of Object.entries(social))
      if (p !== undefined)
        votes.push({
          path: `socialProviders.${name}`,
          closed: (p as { disableSignUp?: unknown } | null)?.disableSignUp === true,
        });
  return votes;
}

/** True when every method that creates a user sets disableSignUp: core's signUp false. */
export function signUpClosed(options: BetterAuthOptions): boolean {
  const votes = signUpVotes(options);
  return votes.length > 0 && votes.every((v) => v.closed);
}

/** The app schemes of trustedOrigins, which core's handoff redirects to. Core's isAppScheme is the one copy of the rule. */
export function appSchemes(options: BetterAuthOptions): string[] {
  const list = Array.isArray(options.trustedOrigins) ? options.trustedOrigins : [];
  return list.filter((o) => typeof o === "string" && isAppScheme(o));
}

/** Better Auth's three default role names, which the shim maps when `roles` is absent. */
export const DEFAULT_ROLE_RANKS: Readonly<Record<string, number>> = {
  member: 1,
  admin: 2,
  owner: 3,
};

/**
 * The checks of the access control map that read two options (spec 29 items
 * 2 and 18). Each role of `roles` has a rank in `authtempo.roleRanks`, and
 * each rank names a role. The table names owner, core's creator role. Each
 * role's statements are known to `ac`. With no `roles`, a rank table is
 * refused. A check that the walk refused already does not run again.
 */
function roleChecks(options: BetterAuthOptions, out: OptionCheck): void {
  const org = pluginOf(options, "organization")?.options;
  const ranks = options.authtempo?.roleRanks;
  if (!org) {
    if (ranks !== undefined)
      refuse(out, "authtempo.roleRanks", `needs plugins[organization] ${ITEM_18}`);
    return;
  }
  const given = plainObject(org.roles) ? org.roles : undefined;
  if (!given) {
    // The default roles have fixed ranks, so a rank table here would change nothing in silence.
    // A roles value that is no object has its refusal from the walk already.
    if (ranks !== undefined && org.roles === undefined)
      refuse(
        out,
        "authtempo.roleRanks",
        `needs plugins[organization].roles; the default roles rank member 1, admin 2, owner 3 ${ITEM_18}`,
      );
    return;
  }
  if (plainObject(ranks))
    for (const name of Object.keys(ranks))
      if (!Object.hasOwn(given, name))
        refuse(
          out,
          `authtempo.roleRanks.${name}`,
          `ranks no role of plugins[organization].roles ${ITEM_18}`,
        );
  if (!Object.hasOwn(given, "owner"))
    refuse(
      out,
      "plugins[organization].roles",
      `core needs the role owner, the creator role (spec 29 items 2 and 18)`,
    );
  const ac = org.ac as { statements?: unknown } | undefined;
  const app = plainObject(ac?.statements)
    ? (toCoreNames(ac.statements) as Record<string, string[]>)
    : {};
  // Core's resources with core's actions, and the app's own from ac.
  const known: Statements = union(
    Object.fromEntries(Object.entries(app).filter(([r]) => !CORE_RESOURCES.includes(r))),
    CORE_STATEMENTS,
  );
  for (const [name, r] of Object.entries(given)) {
    const path = `plugins[organization].roles.${name}`;
    if (!plainObject(ranks) || !Object.hasOwn(ranks, name))
      refuse(out, path, `authtempo.roleRanks must rank ${name} ${ITEM_18}`);
    const statements = (r as { statements?: unknown } | null)?.statements;
    if (!plainObject(statements)) continue;
    const fault = statementFault(corePermissionsOf(statements), known);
    if (fault !== null) refuse(out, path, `${fault} ${ITEM_18}`);
  }
}

/** The allow list (spec 16.1). Pure: no I/O, no throw. */
export function checkOptions(options: BetterAuthOptions): OptionCheck {
  const out: OptionCheck = { refusals: [], notes: [] };
  object(TOP)(options, "", out);
  for (const key of ["baseURL", "database"] as const) {
    if (options[key] === undefined) refuse(out, key, "required");
  }
  // Better Auth takes secret, secrets, or both, and so does core (plan 12b).
  if (options.secret === undefined && options.secrets === undefined)
    refuse(out, "secret", "required");
  // Plan 12b: with secret and secrets, version 1 is the value of secret.
  // Core holds the same rule (config.ts resolveSecrets); this copy names the
  // entry's path, where core's error names no entry.
  if (typeof options.secret === "string" && Array.isArray(options.secrets))
    options.secrets.forEach((e, i) => {
      if (e?.version === 1 && e.value !== options.secret)
        refuse(out, `secrets[${i}].value`, "version 1 must be the value of secret");
    });
  // Better Auth 1.7.2's autoSignIn: false answers { token: null, user } and
  // still lets an unverified user sign in. With requireEmailVerification it
  // acts as that key alone (dist/api/routes/sign-up.mjs lines 163 and 164,
  // read 2026-10-15), which the map keeps as core's requireVerified. Core
  // opens no session at sign-up only while requireVerified is on (plan 12b).
  const ep = options.emailAndPassword;
  if (ep?.autoSignIn === false && ep.requireEmailVerification !== true)
    refuse(
      out,
      "emailAndPassword.autoSignIn",
      "core opens a session at sign-up unless requireEmailVerification is true; with it, an unverified sign-in is refused, as Better Auth does",
    );
  // Plan 12b: core's signUp covers every method that creates a user. Each
  // configured method and social provider votes with its disableSignUp.
  const votes = signUpVotes(options);
  const closed = votes.filter((v) => v.closed).map((v) => v.path);
  const open = votes.filter((v) => !v.closed).map((v) => v.path);
  if (closed.length > 0 && open.length > 0)
    refuse(
      out,
      "disableSignUp",
      `core's signUp rule covers every method; set disableSignUp on every method or on none (true: ${closed.join(", ")}; not true: ${open.join(", ")})`,
    );
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
  roleChecks(options, out);
  if (org && typeof org.sendInvitationEmail !== "function") {
    refuse(
      out,
      "plugins[organization].sendInvitationEmail",
      "required: core mails every invitation",
    );
  }
  // Ruling 41 of plan 12k: Better Auth runs beforeCreateTeam and
  // afterCreateTeam for the default team of an organization create
  // (routes/crud-org.mjs:106 to :139, read 2026-10-21). Core creates that
  // team inside the create and fires no team hook for it.
  if (org?.teams?.enabled === true && org.teams.defaultTeam?.enabled !== false)
    for (const name of ["beforeCreateTeam", "afterCreateTeam"] as const)
      if (org.organizationHooks?.[name] !== undefined)
        refuse(
          out,
          `plugins[organization].organizationHooks.${name}`,
          `core fires no team hook for the default team of an organization create ${ITEM_19}; set teams.defaultTeam { enabled: false } and create the team in afterCreateOrganization`,
        );
  const magic = pluginOf(options, "magic-link")?.options;
  if (magic && typeof magic.sendMagicLink !== "function")
    refuse(out, "plugins[magic-link].sendMagicLink", "required");
  const otp = pluginOf(options, "email-otp")?.options;
  if (otp && typeof otp.sendVerificationOTP !== "function")
    refuse(out, "plugins[email-otp].sendVerificationOTP", "required");
  // Plan 12a: the change link goes through sendVerificationEmail, as in Better Auth.
  if (
    options.user?.changeEmail?.enabled === true &&
    typeof options.emailVerification?.sendVerificationEmail !== "function"
  )
    refuse(
      out,
      "emailVerification.sendVerificationEmail",
      "required by user.changeEmail: the link to the new address goes through it",
    );
  if (options.account?.accountLinking !== undefined || options.databaseHooks?.account !== undefined)
    note(
      out,
      "account",
      "a credential account is core's password row, not an identity, so no account hook fires for it; the user delete fires no account hook either",
    );
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
  // Plan 12f (ruling 39): Better Auth's admins are the members of one
  // organization with the rank of adminRoles, core's platform operators.
  const platformOrganization = options.authtempo?.platformOrganization;
  if (pluginOf(options, "admin")) {
    if (!org)
      refuse(
        out,
        "plugins[admin]",
        "needs plugins[organization]: the platform role is a rank in the platform organization (spec section 26 item 1)",
      );
    if (platformOrganization === undefined)
      refuse(
        out,
        "plugins[admin]",
        "needs authtempo.platformOrganization, the slug of the platform organization (spec section 26 item 1)",
      );
  } else if (platformOrganization !== undefined)
    refuse(out, "authtempo.platformOrganization", "only with plugins[admin]");
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
