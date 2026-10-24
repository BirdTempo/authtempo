/**
 * The event table of core (plan 12h, spec 31 item 6). It holds each event
 * name, its level, and its fields with a field kind. A fault event also
 * holds its default line. The validator, the default output, the adapters,
 * the events page, and the test recorder read it. No second list of events
 * exists.
 */
import { CAPTCHA_FLOWS } from "../captcha.js";
import {
  type HookName,
  IDENTITY_HOOK_POINTS,
  OPERATOR_HOOK_POINTS,
  ORGANIZATION_HOOK_POINTS,
  PATCH_SHAPE_REFUSALS,
  SCIM_HOOK_POINTS,
  SESSION_END_REASONS,
  SESSION_HOOK_POINTS,
  SESSION_PATCH_REFUSALS,
  SESSION_VIA,
  type SessionVia,
  SSO_HOOK_POINTS,
  USER_CREATE_VIA,
  USER_HOOK_POINTS,
  USER_PATCH_REFUSALS,
  USER_VERIFY_VIA,
} from "../engine/hooks.js";
import { ALL_GRANT_TYPES } from "../engine/oauth-grant-types.js";
import {
  CIMD_MAX_BYTES,
  CIMD_RULES,
  CIMD_TYPES,
  FETCH_REFUSALS,
  JWKS_MAX_BYTES,
  JWKS_TYPES,
  KEY_SET_RULES,
  METADATA_MEMBERS,
  notOfTypes,
  overCap,
} from "../engine/oauth-refusals.js";
import { OPERATOR_ACTIONS } from "../engine/operator/actions.js";
import type { OperatorActor } from "../engine/operator/guards.js";
import { SSO_FAILED_STEPS, SSO_GUARD_STEPS, SSO_MFA_CLAIMS } from "../engine/sso/steps.js";
import { SWEEP_KEYS } from "../engine/sweep-keys.js";
import { ERRORS, OAUTH_ERRORS } from "../errors.js";
import { ROUTES, type RouteKey } from "../http/route-list.js";
import type { UnauthorizedReason } from "../http/routes/operator.js";
import { LIMIT_FAMILIES } from "../limiter/limit.js";
import { ENTROPY_WARN_BITS } from "../primitives/keyring.js";
import { appErrorName, FIELD_KINDS, type FieldKind, REJECT } from "../redact.js";
import { AUDIT_ACTOR_KINDS, type SecondFactorMethod } from "../schema.js";
import type { AuthEvent } from "./port.js";

export interface FieldSpec {
  readonly kind: FieldKind;
  /** The closed list of an `enum` field. */
  readonly values?: readonly string[];
  readonly optional?: true;
}

/** The log line of a fault event: the output method (error or warn), the text, and the arguments of today. */
export interface FaultLine {
  readonly method: "error" | "warn";
  /** The text, the first argument. A `<field>` part takes the value of that field. */
  readonly text: string;
  /** Every argument of the line, the text first. */
  args(e: AuthEvent): readonly unknown[];
  /** A line of `createAuth` itself: the default output writes it with or without a sink. */
  readonly construction?: true;
}

export interface EventSpec {
  readonly level: "info" | "warn" | "error";
  readonly fields: Readonly<Record<string, FieldSpec>>;
  readonly line?: FaultLine;
}

/** The value of a field in a line. A field that the validator rejected prints `?`. */
function shown(e: AuthEvent, field: string): unknown {
  const value = e[field];
  return value === undefined ? "?" : value;
}

/** The text with each `<field>` part replaced by the value of that field. */
function filled(text: string, e: AuthEvent): string {
  return text.replace(/<(\w+)>/g, (_, field: string) => String(shown(e, field)));
}

/**
 * One fault event: the level follows the method of its line (ruling 1 point
 * 5 of plan 12h). With no `args`, the line is the text and then each field
 * in the order of `fields`.
 */
function fault<
  const M extends "error" | "warn",
  const F extends Readonly<Record<string, FieldSpec>>,
>(
  method: M,
  text: string,
  fields: F,
  more: { args?: (e: AuthEvent) => readonly unknown[]; construction?: true } = {},
): { level: M; fields: F; line: FaultLine } {
  const names = Object.keys(fields);
  const args = more.args ?? ((e: AuthEvent) => [text, ...names.map((n) => shown(e, n))]);
  return {
    level: method,
    fields,
    line: { method, text, args, ...(more.construction ? { construction: true } : {}) },
  };
}

const ROW_ID = { kind: "id" } as const;
const ERROR_NAME = { kind: "errorName" } as const;
const ERROR_CLASS = { kind: "errorClass" } as const;
const PROVIDER = { kind: "name" } as const;
const STATUS = { kind: "status" } as const;
const CLIENT_REF = { kind: "clientRef" } as const;
const COUNT = { kind: "count" } as const;

const enumOf = (values: readonly string[]) => ({ kind: "enum", values }) as const;

/** Every hook name, read from the seven hook point constants (the last two of plan 12d). */
const HOOK_NAMES: readonly string[] = [
  ...Object.keys(ORGANIZATION_HOOK_POINTS).map((p) => `organization.${p}`),
  ...Object.keys(SESSION_HOOK_POINTS).map((p) => `session.${p}`),
  ...Object.keys(USER_HOOK_POINTS).map((p) => `user.${p}`),
  ...Object.keys(IDENTITY_HOOK_POINTS).map((p) => `identity.${p}`),
  ...Object.keys(OPERATOR_HOOK_POINTS).map((p) => `operator.${p}`),
  ...Object.keys(SSO_HOOK_POINTS).map((p) => `sso.${p}`),
  ...Object.keys(SCIM_HOOK_POINTS).map((p) => `scim.${p}`),
];

/** The key of each entry of ROUTES, `<method> <path>`. */
const ROUTE_KEYS: readonly string[] = ROUTES.map((r) => `${r.method} ${r.path}`);
const ROUTE_KEY_SET: ReadonlySet<string> = new Set(ROUTE_KEYS);
const ROUTE_PATHS: ReadonlySet<string> = new Set(ROUTES.map((r) => r.path));

/** A Record, so a reason added to the union and not listed here fails the compile. */
const UNAUTHORIZED_REASONS: Readonly<Record<UnauthorizedReason, true>> = {
  secret_mismatch: true,
  secret_and_session: true,
  secret_not_accepted: true,
  no_session: true,
};
const ACTOR_KINDS: Readonly<Record<OperatorActor["kind"], true>> = {
  secret: true,
  user: true,
  app: true,
};

/** The outcome of an answer, from its status and its `Location` (plan 12h Task 4). */
export const OUTCOMES = [
  "ok",
  "redirect",
  "client_error",
  "denied",
  "limited",
  "server_error",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * A route that can open a session. An answer with the outcome client_error,
 * denied, or limited is a sign-in failure (ASVS 5.0.0 16.3.1). The second
 * factor routes, the impersonation route, and `GET /oauth/sign-in` are not
 * rows. A row names one `SessionVia`, and those routes cannot name one
 * (ruling 1 point 15 of plan 12h). The engine reports a failed second factor itself.
 */
export const SIGN_IN_ROUTES: { readonly [K in RouteKey]?: SessionVia } = {
  "POST /password/sign-in": "password",
  "GET /magic-link/verify": "magic_link",
  "POST /magic-link/verify": "magic_link",
  "POST /otp/verify": "email_otp",
  // The phone code of plan 12i Task 5.
  "POST /phone/verify": "phone",
  // The anonymous sign-in of plan 12i Task 6.
  "POST /anonymous/sign-in": "anonymous",
  "POST /passkey/authenticate/verify": "passkey",
  "POST /handoff/redeem": "handoff",
  "GET /social/:provider/callback": "social",
  "POST /social/apple/callback": "social",
  // The OIDC callback and the SAML ACS of plan 12d.
  "GET /sso/:connectionId/callback": "sso",
  "POST /sso/:connectionId/acs": "sso",
};

/** The template of a route key, or `unmatched`, as the line of an unhandled error prints it. */
function routeTemplate(e: AuthEvent): unknown {
  const route = e.route;
  if (typeof route !== "string") return "?";
  return route === "unmatched" ? route : route.slice(route.indexOf(" ") + 1);
}

/** The reasons of a refused metadata document. `status` prints with its number. */
const CIMD_WHYS: readonly string[] = [
  ...FETCH_REFUSALS,
  "status",
  notOfTypes(CIMD_TYPES),
  overCap(CIMD_MAX_BYTES),
  ...CIMD_RULES,
  ...METADATA_MEMBERS,
];
const KEY_SET_WHYS: readonly string[] = [
  ...FETCH_REFUSALS,
  "status",
  notOfTypes(JWKS_TYPES),
  overCap(JWKS_MAX_BYTES),
  ...KEY_SET_RULES,
];

const statusWhy = (text: string) => (e: AuthEvent) => [
  text,
  e.why === "status" ? `status ${String(shown(e, "status"))}` : shown(e, "why"),
];

const SWEEP_STOP = { errorClass: ERROR_CLASS } as const;

// The flow events of tokens, OAuth, organizations, operators, and the sweep (plan 12h Task 6).

/** The outcome of an act. A refusal of an act with a route is in the `request` event (plan 12h Task 5). */
const ACT_OUTCOME = enumOf(["success", "failure"]);
const ACT_CODE = { kind: "code", optional: true } as const;
/** The two token forms: a user token (`tk_`) and an organization token (`to_`) (ruling 9 of plan 12h). */
const TOKEN_EVENT = {
  kind: enumOf(["tk", "to"]),
  tokenId: ROW_ID,
  organizationId: { kind: "id", optional: true },
  outcome: ACT_OUTCOME,
  code: ACT_CODE,
} as const;
const CLIENT_EVENT = { clientRef: CLIENT_REF, outcome: ACT_OUTCOME, code: ACT_CODE } as const;

/** An `after` point of organizations. */
export type OrganizationAfterPoint = Extract<
  keyof typeof ORGANIZATION_HOOK_POINTS,
  `after${string}`
>;
/** The `action` of `organization.change`: the point without `after`, in lower camel case. */
export type OrganizationChange<P extends OrganizationAfterPoint = OrganizationAfterPoint> =
  P extends `after${infer R}` ? Uncapitalize<R> : never;

/** The action of an `after` point: `afterAddMember` gives `addMember`. */
export function changeOf<P extends OrganizationAfterPoint>(point: P): OrganizationChange<P> {
  const rest = point.slice("after".length);
  return `${rest.charAt(0).toLowerCase()}${rest.slice(1)}` as OrganizationChange<P>;
}

/** The actions of `organization.change`, computed from the hook points, so a new point needs no edit here. */
const CHANGE_ACTIONS: readonly string[] = Object.keys(ORGANIZATION_HOOK_POINTS)
  .filter((p): p is OrganizationAfterPoint => p.startsWith("after"))
  .map(changeOf);

/** One count field for each key of `SweepResult`, read from `SWEEP_KEYS`. */
const SWEEP_COUNTS = Object.fromEntries(Object.keys(SWEEP_KEYS).map((k) => [k, COUNT])) as Record<
  keyof typeof SWEEP_KEYS,
  typeof COUNT
>;

// The flow events of sign-in, sign-up, sign-out, and the factors (plan 12h Task 5).

const OPTIONAL_ID = { kind: "id", optional: true } as const;

/** The methods of a second factor. A Record, so a new `SecondFactorMethod` fails the compile. */
const FACTOR_METHOD: Readonly<Record<SecondFactorMethod, true>> = {
  totp: true,
  passkey: true,
  email: true,
};
const FACTOR_METHODS: readonly string[] = Object.keys(FACTOR_METHOD);
/**
 * A challenge also passes with a backup code or a trusted device token.
 * The map of the proofs in totp.ts takes its values from this type.
 */
const CHALLENGE_METHOD = { ...FACTOR_METHOD, backup_code: true, trusted_device: true } as const;
export type ChallengeEventMethod = keyof typeof CHALLENGE_METHOD;
const CHALLENGE_METHODS: readonly string[] = Object.keys(CHALLENGE_METHOD);
/**
 * The first proof of a re-authentication, by the `SessionVia` name of its
 * flow. The method parameter of reauth.ts takes this type.
 */
const REAUTH_METHODS = [
  "password",
  "email_otp",
  "passkey",
] as const satisfies readonly SessionVia[];
export type ReauthEventMethod = (typeof REAUTH_METHODS)[number];

/**
 * The row of a flow event: the fields of the act, then `outcome`, an
 * optional `code`, and the optional `userId` (plan 12h Task 5).
 */
function act<const F extends Readonly<Record<string, FieldSpec>>>(
  fields: F,
  level: "info" | "warn" = "info",
) {
  return {
    level,
    fields: {
      ...fields,
      outcome: ACT_OUTCOME,
      code: ACT_CODE,
      userId: OPTIONAL_ID,
    },
  } as const;
}

/**
 * The events. The fault events (those with `line`) are one row for each
 * text of the log lines of core. The texts are the start list of plan 12h
 * Task 1, read again at the 12k merge (63 texts). Plan 12g adds the line
 * of the credential id bound (64). Tasks 4 to 8 add the other groups.
 */
export const EVENTS = {
  // One event for each answer of `handle` (plan 12h Task 4). The router
  // stamps the route key. The method is the real token of the request (ruling 12 of plan 12h).
  request: {
    level: "info",
    fields: {
      method: { kind: "method" },
      status: STATUS,
      outcome: enumOf(OUTCOMES),
      code: { kind: "code", optional: true },
      durationMs: { kind: "durationMs" },
    },
  },
  // A success comes from the commit of the session. A failure comes from the
  // router, for each route of SIGN_IN_ROUTES (spec 31 item 6).
  sign_in: {
    level: "info",
    fields: {
      method: enumOf(Object.keys(SESSION_VIA)),
      provider: { kind: "name", optional: true },
      outcome: enumOf(["success", "failure", "second_factor_required"]),
      code: { kind: "code", optional: true },
      // The engine rows only: the router knows no user (plan 12h Task 5).
      userId: OPTIONAL_ID,
      sessionId: OPTIONAL_ID,
    },
  },
  // The flow events of plan 12h Task 5. A success emits after the commit,
  // beside the after hook of the act. A refusal of an act with a route is in
  // the request event. The engine emits a refusal only for an act with no
  // route, and for the second factor challenge (ruling 1 point 15).
  sign_up: act({ method: enumOf(Object.keys(USER_CREATE_VIA)) }),
  sign_out: act({ sessionId: OPTIONAL_ID }),
  // One event for each act, with the count of the rows that the deletes
  // answered. The count needs no read of each row (deviation 9 of plan 12h).
  "session.end": {
    level: "info",
    fields: { reason: enumOf(Object.keys(SESSION_END_REASONS)), count: COUNT },
  },
  "second_factor.challenge": act({
    method: { kind: "enum", values: CHALLENGE_METHODS, optional: true },
  }),
  "second_factor.enable": act({ method: enumOf(FACTOR_METHODS) }),
  // A warn: an act that lowers the guard of an account. The in-process
  // disable turns every method off, so it names no method.
  "second_factor.disable": act(
    { method: { kind: "enum", values: FACTOR_METHODS, optional: true } },
    "warn",
  ),
  "backup_codes.regenerate": act({}),
  "passkey.register": act({}),
  "passkey.delete": act({}),
  // No user id: the request answers the same for an address with no account.
  "password.reset_request": {
    level: "info",
    fields: { outcome: ACT_OUTCOME, code: { kind: "code", optional: true } },
  },
  "password.reset": act({}),
  "password.change": act({}),
  "email.verify": act({ method: enumOf(Object.keys(USER_VERIFY_VIA)) }),
  reauth: act({ method: enumOf(REAUTH_METHODS) }),
  "observe.dropped": {
    level: "warn",
    fields: { buffer_full: COUNT, sink_timeout: COUNT, sink_threw: COUNT },
  },
  "observe.wait_until_threw": fault("error", "authtempo: waitUntil threw; the flush has no hook", {
    errorName: ERROR_NAME,
  }),
  // Ruling 29 of plan 12i: on Workers with no waitUntil, handle waits for the work after the answer.
  "observe.wait_until_missing": fault(
    "warn",
    "authtempo: no waitUntil on Workers; the answer waited for the work after it",
    {},
  ),
  "secret.low_entropy": fault(
    "warn",
    `authtempo: <path> has an estimated <bits> bits of entropy; ${ENTROPY_WARN_BITS} or more is recommended`,
    { secretIndex: { kind: "count", optional: true }, bits: COUNT },
    {
      construction: true,
      args: (e) => [
        `authtempo: ${e.secretIndex === undefined ? "secret" : `secrets[${String(e.secretIndex)}]`} has an estimated ${String(shown(e, "bits"))} bits of entropy; ${ENTROPY_WARN_BITS} or more is recommended`,
      ],
    },
  ),
  "secret.unknown_version": fault(
    "error",
    "authtempo: a stored value names secret version <version>, which is not configured",
    { version: COUNT, rowId: ROW_ID },
    {
      args: (e) => [
        filled(
          "authtempo: a stored value names secret version <version>, which is not configured",
          e,
        ),
        shown(e, "rowId"),
      ],
    },
  ),
  "error.internal": fault(
    "error",
    "authtempo: unhandled error",
    {
      // Each method token as today, HEAD too (ruling 12 of plan 12h): the router passes any method.
      method: { kind: "method" },
      route: { kind: "route" },
      errorName: ERROR_NAME,
    },
    {
      args: (e) => [
        "authtempo: unhandled error",
        shown(e, "method"),
        routeTemplate(e),
        shown(e, "errorName"),
      ],
    },
  ),
  "captcha.port_threw": fault("error", "authtempo: the captcha port threw", {
    flow: enumOf(CAPTCHA_FLOWS),
    errorName: ERROR_NAME,
  }),
  "captcha.no_answer": fault("error", "authtempo: the captcha did not answer", {
    flow: enumOf(CAPTCHA_FLOWS),
  }),
  // Plan 12i: never the number or the text, which holds the code.
  "sms.port_threw": fault("error", "authtempo: the SMS port threw", { errorName: ERROR_NAME }),
  // Ruling 23 of plan 12i: a send after the answer that the cap refused or the port did not make.
  "sms.not_sent": fault("error", "authtempo: an SMS after the answer was not sent", {
    reason: enumOf(["capped", "unavailable", "timeout"]),
  }),
  "hook.copy_failed": fault("error", "authtempo: hook event copy failed", {
    hook: enumOf(HOOK_NAMES),
    errorName: ERROR_NAME,
  }),
  "hook.before_failed": fault("error", "authtempo: before hook failed", {
    hook: enumOf(HOOK_NAMES),
    errorName: ERROR_NAME,
  }),
  "hook.after_failed": fault("error", "authtempo: after hook failed", {
    hook: enumOf(HOOK_NAMES),
    rowId: ROW_ID,
    errorName: ERROR_NAME,
  }),
  "user.patch_refused": fault("error", "authtempo: user patch refused", {
    what: enumOf([...PATCH_SHAPE_REFUSALS, ...USER_PATCH_REFUSALS]),
  }),
  "session.patch_refused": fault(
    "error",
    "authtempo: session patch refused",
    {
      what: enumOf([...PATCH_SHAPE_REFUSALS, ...SESSION_PATCH_REFUSALS, "field"]),
      field: { kind: "identifier", optional: true },
    },
    {
      args: (e) => [
        "authtempo: session patch refused",
        e.what === "field" ? `the field ${String(shown(e, "field"))}` : shown(e, "what"),
      ],
    },
  ),
  "user.hold_gave_up": fault("error", "authtempo: user hold gave up", { userId: ROW_ID }),
  "account.delete_gave_up": fault("error", "authtempo: account delete gave up", {
    userId: ROW_ID,
  }),
  "email_change.gave_up": fault("error", "authtempo: email change gave up", { userId: ROW_ID }),
  "credential.removal_gave_up": fault("error", "authtempo: credential removal gave up", {
    userId: ROW_ID,
  }),
  "profile.update_gave_up": fault("error", "authtempo: profile update gave up", {
    userId: ROW_ID,
  }),
  "username.set_gave_up": fault("error", "authtempo: username set gave up", { userId: ROW_ID }),
  "phone.set_gave_up": fault("error", "authtempo: phone set gave up", { userId: ROW_ID }),
  "notice.mail_failed": fault("error", "authtempo: notice mail failed", {
    event: { kind: "identifier" },
    errorName: ERROR_NAME,
  }),
  "email_code.count_gave_up": fault("error", "authtempo: email code count gave up", {
    rowId: ROW_ID,
  }),
  "second_factor.count_gave_up": fault(
    "error",
    "authtempo: second-factor challenge count gave up",
    { rowId: ROW_ID },
  ),
  "backup_code.spend_gave_up": fault("error", "authtempo: backup code spend gave up", {
    rowId: ROW_ID,
  }),
  "backup_code.replace_gave_up": fault("error", "authtempo: backup code replacement gave up", {
    rowId: ROW_ID,
  }),
  "totp.reseal_failed": fault("error", "authtempo: a TOTP secret reseal failed", {
    rowId: ROW_ID,
    errorName: ERROR_NAME,
  }),
  "secrets.rewrap_failed": fault(
    "error",
    "authtempo: a sealed value did not move to the current secret; it did not open, or a concurrent write changed it first",
    // An identifier, not a name: plan 12d adds the model ssoConnection, in camel case.
    { model: { kind: "identifier" }, rowId: ROW_ID, version: COUNT },
    {
      args: (e) => [
        "authtempo: a sealed value did not move to the current secret; it did not open, or a concurrent write changed it first",
        shown(e, "model"),
        shown(e, "rowId"),
        `version ${String(shown(e, "version"))}`,
      ],
    },
  ),
  "jwt.key_reseal_failed": fault("error", "authtempo: a signing key reseal failed", {
    kid: ROW_ID,
    errorName: ERROR_NAME,
  }),
  "jwt.key_unopened": fault(
    "error",
    "authtempo: a signing key does not open under this secret; it retires",
    { kid: ROW_ID },
  ),
  "jwt.claims_not_object": fault(
    "error",
    "authtempo: jwtMint.claims answered a value that is not an object",
    {},
  ),
  "jwt.claims_threw": fault("error", "authtempo: jwtMint.claims threw", {
    errorName: ERROR_NAME,
  }),
  "passkey.registration_rejected": fault("error", "authtempo: passkey registration rejected", {
    errorClass: ERROR_CLASS,
  }),
  "passkey.already_registered": fault(
    "error",
    "authtempo: passkey credential already registered",
    {},
  ),
  "passkey.authentication_rejected": fault("error", "authtempo: passkey authentication rejected", {
    errorClass: ERROR_CLASS,
  }),
  "passkey.counter_moved": fault("error", "authtempo: passkey counter moved", {}),
  // The bound of ruling 7 of plan 12g: WebAuthn Level 3 bounds a credential id to 1023 bytes.
  "passkey.credential_id_too_long": fault(
    "error",
    "authtempo: passkey credential id over 1023 bytes",
    {},
  ),
  "social.client_secret_failed": fault("error", "authtempo: social client secret failed", {
    provider: PROVIDER,
    errorClass: ERROR_CLASS,
  }),
  "social.token_request_failed": fault("error", "authtempo: social token request failed", {
    provider: PROVIDER,
    errorClass: ERROR_CLASS,
  }),
  "social.token_status": fault("error", "authtempo: social token endpoint answered", {
    provider: PROVIDER,
    status: STATUS,
  }),
  "social.token_missing": fault("error", "authtempo: social token answer has no token", {
    provider: PROVIDER,
  }),
  "social.token_refused": fault("error", "authtempo: social token answer refused", {
    provider: PROVIDER,
  }),
  "social.id_token_rejected": fault("error", "authtempo: social id token rejected", {
    provider: PROVIDER,
    errorClass: ERROR_CLASS,
  }),
  "social.nonce_mismatch": fault("error", "authtempo: social nonce mismatch", {
    provider: PROVIDER,
  }),
  "social.claims_refused": fault("error", "authtempo: social id token claims refused", {
    provider: PROVIDER,
  }),
  "social.user_info_failed": fault("error", "authtempo: social user info failed", {
    provider: PROVIDER,
    errorName: ERROR_NAME,
  }),
  "social.bad_subject": fault("error", "authtempo: social user info has a bad subject", {
    provider: PROVIDER,
  }),
  "oidc.discovery_failed": fault("error", "authtempo: oidc discovery request failed", {
    provider: PROVIDER,
    errorClass: ERROR_CLASS,
  }),
  "oidc.discovery_status": fault("error", "authtempo: oidc discovery answered", {
    provider: PROVIDER,
    status: STATUS,
  }),
  "oidc.discovery_not_json": fault("error", "authtempo: oidc discovery is not JSON", {
    provider: PROVIDER,
  }),
  "oidc.issuer_mismatch": fault("error", "authtempo: oidc discovery issuer mismatch", {
    provider: PROVIDER,
  }),
  "oidc.endpoint_missing": fault("error", "authtempo: oidc discovery lacks an endpoint", {
    provider: PROVIDER,
  }),
  "oauth.client_metadata_refused": fault(
    "error",
    "authtempo: client metadata document refused",
    { why: enumOf(CIMD_WHYS), status: { kind: "status", optional: true } },
    { args: statusWhy("authtempo: client metadata document refused") },
  ),
  "oauth.client_metadata_member_dropped": fault(
    "warn",
    "authtempo: client metadata member dropped",
    { member: { kind: "identifier" } },
  ),
  "oauth.client_key_set_refused": fault(
    "error",
    "authtempo: client key set refused",
    { why: enumOf(KEY_SET_WHYS), status: { kind: "status", optional: true } },
    { args: statusWhy("authtempo: client key set refused") },
  ),
  "oauth.client_auth_dropped": fault(
    "error",
    "authtempo: client metadata document dropped its client auth; refresh tokens and device codes revoked",
    { clientRef: CLIENT_REF, from: { kind: "identifier" } },
    {
      args: (e) => [
        "authtempo: client metadata document dropped its client auth; refresh tokens and device codes revoked",
        shown(e, "clientRef"),
        shown(e, "from"),
        "none",
      ],
    },
  ),
  "oauth.logout_dropped_attempts": fault(
    "error",
    "authtempo: a back-channel logout is dropped after 6 attempts",
    { clientRef: CLIENT_REF },
  ),
  "oauth.logout_refused": fault(
    "error",
    "authtempo: a back-channel logout is dropped: the client refused it",
    { clientRef: CLIENT_REF, status: STATUS },
  ),
  "oauth.logout_attempt_failed": fault("error", "authtempo: a back-channel logout attempt failed", {
    errorClass: ERROR_CLASS,
  }),
  "oauth.logout_delivery_failed": fault(
    "error",
    "authtempo: the back-channel logout delivery failed",
    { errorClass: ERROR_CLASS },
  ),
  "oauth.refresh_delete_failed": fault(
    "error",
    "authtempo: the delete of a refresh row in a revoked grant failed",
    { rowId: ROW_ID, errorClass: ERROR_CLASS },
  ),
  "operator.step_failed": fault("error", "authtempo: operator step failed", {
    rowId: ROW_ID,
    errorName: ERROR_NAME,
  }),
  "operator.family_end_failed": fault("error", "authtempo: operator family end failed", {
    rowId: ROW_ID,
    errorName: ERROR_NAME,
  }),
  "operator.ban_write_gave_up": fault("error", "authtempo: operator ban write gave up", {
    userId: ROW_ID,
  }),
  // The route keys and `api`, the name of an engine call (ruling 1 point 18 of plan 12h).
  "operator.guard_refused": fault("error", "authtempo: operator guard refused", {
    route: enumOf([...ROUTE_KEYS, "api"]),
  }),
  "operator.read": fault("error", "authtempo: operator read", {
    actor: enumOf(Object.keys(ACTOR_KINDS)),
    actorId: ROW_ID,
    fn: { kind: "identifier" },
  }),
  "operator.route_unauthorized": fault("error", "authtempo: operator route unauthorized", {
    route: { kind: "route" },
    reason: enumOf(Object.keys(UNAUTHORIZED_REASONS)),
  }),
  "role.row_invalid": fault(
    "warn",
    "authtempo: role row invalid <rowId>",
    { rowId: ROW_ID },
    { args: (e) => [filled("authtempo: role row invalid <rowId>", e)] },
  ),
  "sweep.link_stopped": fault("error", "authtempo: the sweep link step stopped", SWEEP_STOP),
  "sweep.outbox_stopped": fault("error", "authtempo: the sweep outbox step stopped", SWEEP_STOP),
  "sweep.pending_end_stopped": fault(
    "error",
    "authtempo: the sweep pending end step stopped",
    SWEEP_STOP,
  ),
  "sweep.sso_recheck_stopped": fault(
    "error",
    "authtempo: the sweep sso recheck step stopped",
    SWEEP_STOP,
  ),
  "sweep.organization_rest_stopped": fault(
    "error",
    "authtempo: the sweep organization rest step stopped",
    SWEEP_STOP,
  ),
  // The anonymous step of plan 12i Task 6.
  "sweep.anonymous_stopped": fault(
    "error",
    "authtempo: the sweep anonymous step stopped",
    SWEEP_STOP,
  ),
  // The lines of plan 12d (SSO and SCIM). The raw IP of a refused sign-in is
  // an address input: only the include rule writes it (spec 31 item 8).
  "sso.guard_refused": fault("error", "authtempo: sso guard refused", {
    step: enumOf(SSO_GUARD_STEPS),
  }),
  "sso.failed": fault("error", "authtempo: sso failed", {
    connectionId: ROW_ID,
    step: enumOf(SSO_FAILED_STEPS),
  }),
  "sso.denied": fault("error", "authtempo: sso denied", { connectionId: ROW_ID }),
  "sso.refused": fault("error", "authtempo: sso refused", {
    connectionId: ROW_ID,
    code: { kind: "code" },
  }),
  "saml.certificate_expired": fault("warn", "authtempo: saml certificate expired", {
    connectionId: ROW_ID,
  }),
  "sso.client_secret_unopened": fault("error", "authtempo: an sso client secret did not open", {
    rowId: ROW_ID,
  }),
  // The row id of the domain, not the name: no field kind holds a DNS name.
  "sso.domain_unverified": fault("error", "authtempo: sso domain unverified", {
    port: PROVIDER,
    domainId: ROW_ID,
  }),
  "sso.domain_lost": fault("error", "authtempo: sso domain lost", { rowId: ROW_ID }),
  // The flow events of plan 12h Task 6. Each success emits after its commit.
  "api_token.create": { level: "info", fields: TOKEN_EVENT },
  "api_token.update": { level: "info", fields: TOKEN_EVENT },
  "api_token.revoke": { level: "info", fields: TOKEN_EVENT },
  "jwt.mint": {
    level: "info",
    fields: {
      kid: ROW_ID,
      userId: ROW_ID,
      sessionId: ROW_ID,
      outcome: ACT_OUTCOME,
      code: ACT_CODE,
    },
  },
  // The cause of a retire: a rotate call, the rotateEvery timer, another alg, or a key that does not open.
  "jwt.key_retire": {
    level: "info",
    fields: { kid: ROW_ID, why: enumOf(["rotate", "timer", "alg", "unopened"]) },
  },
  "oauth.authorize": { level: "info", fields: CLIENT_EVENT },
  "oauth.token": {
    level: "info",
    fields: { grant: enumOf(ALL_GRANT_TYPES), ...CLIENT_EVENT },
  },
  "oauth.revoke": { level: "info", fields: CLIENT_EVENT },
  // A refused create of `api.oauth.clients` names no client.
  "oauth.client_register": {
    level: "info",
    fields: { ...CLIENT_EVENT, clientRef: { kind: "clientRef", optional: true } },
  },
  "organization.change": {
    level: "info",
    fields: { action: enumOf(CHANGE_ACTIONS), organizationId: ROW_ID },
  },
  // The dynamic roles have no hook point (ruling 9 of plan 12h).
  "organization.role_change": {
    level: "info",
    fields: {
      action: enumOf(["create", "update", "delete"]),
      organizationId: ROW_ID,
      roleId: ROW_ID,
    },
  },
  // After the commit of the act and its audit row (spec 26 item 8).
  "operator.action": {
    level: "info",
    fields: {
      action: enumOf(OPERATOR_ACTIONS),
      // The kinds of an audit row: a SCIM write writes `scim` (plan 12d).
      actorKind: enumOf(AUDIT_ACTOR_KINDS),
      auditId: ROW_ID,
    },
  },
  // A refusal of a known actor: the guard, or beforeAction (ruling 1 point 14 of plan 12h).
  "operator.refused": {
    level: "warn",
    fields: {
      action: { kind: "enum", values: OPERATOR_ACTIONS, optional: true },
      actorKind: enumOf(AUDIT_ACTOR_KINDS),
      code: { kind: "code" },
    },
  },
  // A refusal of a limit (plan 12h Task 7). The family only: the subject of
  // the key is an address, an IP, or a user id (spec 31 item 10).
  "limit.hit": { level: "warn", fields: { family: enumOf(LIMIT_FAMILIES) } },
  // The IdP passed the second factor of a connection (spec 30 item 13): the
  // claim that matched, never its value.
  "sso.second_factor_idp": {
    level: "info",
    fields: { connectionId: ROW_ID, claim: enumOf(SSO_MFA_CLAIMS) },
  },
  // A SCIM deactivate kept the member row of an owner (plan 12d Task 10).
  "scim.owner_kept": { level: "info", fields: { scimUserId: ROW_ID } },
  // Beside `hooks.scim.afterChange`, once per committed SCIM write.
  "scim.change": {
    level: "info",
    fields: {
      resource: enumOf(["User", "Group"]),
      action: enumOf(["create", "update", "deactivate", "delete"]),
      organizationId: ROW_ID,
      resourceId: ROW_ID,
    },
  },
  sweep: { level: "info", fields: { ...SWEEP_COUNTS, durationMs: { kind: "durationMs" } } },
} as const satisfies Readonly<Record<string, EventSpec>>;

export type EventName = keyof typeof EVENTS;

type FieldsOf<N extends EventName> = (typeof EVENTS)[N]["fields"];
type Needed<F> = { [K in keyof F as F[K] extends { optional: true } ? never : K]: unknown };
type Maybe<F> = { [K in keyof F as F[K] extends { optional: true } ? K : never]?: unknown };

/** The address fields. Only the include rule of the observer writes them (spec 31 item 8). */
export interface AddressInput {
  ip?: unknown;
  ipHash?: unknown;
  userAgent?: unknown;
  email?: unknown;
  emailHash?: unknown;
}

/**
 * What a flow passes to `emit`: the name and the fields of its row. An
 * `errorName` or `errorClass` field takes the raw thrown value.
 */
export type EventInput<N extends EventName = EventName> = N extends EventName
  ? { name: N } & Needed<FieldsOf<N>> & Maybe<FieldsOf<N>> & AddressInput
  : never;

/** The spec of an event, with the wide type. */
export function specOf(name: EventName): EventSpec {
  return EVENTS[name];
}

/** The name of a thrown value for the kind `errorClass`: its `name`, else its `typeof`. A getter that throws gives `Error`. */
function errorClassOf(e: unknown): unknown {
  if (!(e instanceof Error)) return typeof e;
  try {
    return e.name;
  } catch {
    return "Error";
  }
}

function checked(spec: FieldSpec, value: unknown): unknown {
  switch (spec.kind) {
    // The raw thrown value: the kind reads the name first (deviation 6 of plan 12h).
    case "errorName":
      return FIELD_KINDS.errorName(appErrorName(value));
    case "errorClass":
      return FIELD_KINDS.errorClass(errorClassOf(value));
    case "enum":
      return FIELD_KINDS.enum(value) !== REJECT && spec.values?.includes(value as string)
        ? value
        : REJECT;
    case "code":
      return FIELD_KINDS.code(value) !== REJECT &&
        (Object.hasOwn(ERRORS, value as string) || Object.hasOwn(OAUTH_ERRORS, value as string))
        ? value
        : REJECT;
    case "route":
      return FIELD_KINDS.route(value) !== REJECT &&
        (value === "unmatched" || ROUTE_KEY_SET.has(value as string))
        ? value
        : REJECT;
    case "routePath":
      return FIELD_KINDS.routePath(value) !== REJECT && ROUTE_PATHS.has(value as string)
        ? value
        : REJECT;
    default:
      return FIELD_KINDS[spec.kind](value);
  }
}

/**
 * Checks each field against its kind (spec 31 item 7). It answers the kept
 * fields and the names of the rejected ones. A field is rejected when it
 * fails its kind, or when the row does not name it. It never drops the event.
 */
export function validateEvent(
  name: EventName,
  fields: Record<string, unknown>,
): { fields: Record<string, unknown>; rejected: string[] } {
  const spec: EventSpec | undefined = Object.hasOwn(EVENTS, name) ? specOf(name) : undefined;
  const kept: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "name") continue;
    const field = spec && Object.hasOwn(spec.fields, key) ? spec.fields[key] : undefined;
    const out = field ? checked(field, value) : REJECT;
    if (out === REJECT) rejected.push(key);
    else kept[key] = out;
  }
  return { fields: kept, rejected };
}

/** The reason of each `before` point: its refusal is an answer, not an act. */
const REFUSAL_EXEMPT = {
  exempt: "A refusal answers hook_refused, and the request event carries it.",
} as const;
/** The reason of a point whose act has no event in plan 12h (question q1 of plan 12h Task 6). */
const NO_EVENT_EXEMPT = {
  exempt:
    "No event of plan 12h names this act. The request event carries the answer, and the stored row is the record.",
} as const;
/**
 * The event of each hook point, or an exempt row with its reason (plan 12h
 * Task 6). A Record of every `HookName`, so a new point without a row fails
 * the compile. A test holds each row to the hook point constants.
 */
export const HOOK_EVENTS: Readonly<Record<HookName, EventName | { readonly exempt: string }>> = {
  "organization.beforeCreate": REFUSAL_EXEMPT,
  "organization.afterCreate": "organization.change",
  "organization.beforeUpdate": REFUSAL_EXEMPT,
  "organization.afterUpdate": "organization.change",
  "organization.beforeDelete": REFUSAL_EXEMPT,
  "organization.afterDelete": "organization.change",
  "organization.beforeAddMember": REFUSAL_EXEMPT,
  "organization.afterAddMember": "organization.change",
  "organization.beforeUpdateMemberRole": REFUSAL_EXEMPT,
  "organization.afterUpdateMemberRole": "organization.change",
  "organization.beforeRemoveMember": REFUSAL_EXEMPT,
  "organization.afterRemoveMember": "organization.change",
  "organization.beforeInvite": REFUSAL_EXEMPT,
  "organization.afterInvite": "organization.change",
  "organization.afterAcceptInvitation": "organization.change",
  "organization.afterDeclineInvitation": "organization.change",
  "organization.afterRevokeInvitation": "organization.change",
  "organization.beforeCreateTeam": REFUSAL_EXEMPT,
  "organization.afterCreateTeam": "organization.change",
  "organization.beforeUpdateTeam": REFUSAL_EXEMPT,
  "organization.afterUpdateTeam": "organization.change",
  "organization.beforeDeleteTeam": REFUSAL_EXEMPT,
  "organization.afterDeleteTeam": "organization.change",
  "organization.beforeAddTeamMember": REFUSAL_EXEMPT,
  "organization.afterAddTeamMember": "organization.change",
  "organization.beforeRemoveTeamMember": REFUSAL_EXEMPT,
  "organization.afterRemoveTeamMember": "organization.change",
  "session.beforeCreate": REFUSAL_EXEMPT,
  "session.afterCreate": "sign_in",
  "session.afterEnd": "session.end",
  "user.beforeCreate": REFUSAL_EXEMPT,
  "user.afterCreate": "sign_up",
  "user.beforeUpdate": REFUSAL_EXEMPT,
  "user.afterUpdate": NO_EVENT_EXEMPT,
  "user.beforeDelete": REFUSAL_EXEMPT,
  "user.afterDelete": NO_EVENT_EXEMPT,
  "user.beforeVerify": REFUSAL_EXEMPT,
  "user.afterVerify": "email.verify",
  "identity.beforeLink": REFUSAL_EXEMPT,
  "identity.afterLink": NO_EVENT_EXEMPT,
  "identity.beforeUnlink": REFUSAL_EXEMPT,
  "identity.afterUnlink": NO_EVENT_EXEMPT,
  "operator.beforeAction": "operator.refused",
  "operator.afterAction": "operator.action",
  "sso.beforeSignIn": REFUSAL_EXEMPT,
  "scim.afterChange": "scim.change",
};

/** The `organization.change` event of an `after` point, emitted beside its hook. */
export function organizationChange(
  point: OrganizationAfterPoint,
  organizationId: string,
): EventInput<"organization.change"> {
  return { name: "organization.change", action: changeOf(point), organizationId };
}
