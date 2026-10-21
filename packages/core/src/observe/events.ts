/**
 * The event table of core (plan 12h, spec 31 item 6). It holds each event
 * name, its level, and its fields with a field kind. A fault event also
 * holds its default line. The validator, the default output, the adapters,
 * the events page, and the test recorder read it. No second list of events
 * exists.
 */
import { CAPTCHA_FLOWS } from "../captcha.js";
import {
  IDENTITY_HOOK_POINTS,
  OPERATOR_HOOK_POINTS,
  ORGANIZATION_HOOK_POINTS,
  PATCH_SHAPE_REFUSALS,
  SESSION_HOOK_POINTS,
  SESSION_PATCH_REFUSALS,
  SESSION_VIA,
  type SessionVia,
  USER_HOOK_POINTS,
  USER_PATCH_REFUSALS,
} from "../engine/hooks.js";
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
import type { OperatorActor } from "../engine/operator/guards.js";
import { ERRORS, OAUTH_ERRORS } from "../errors.js";
import { ROUTES, type RouteKey } from "../http/route-list.js";
import type { UnauthorizedReason } from "../http/routes/operator.js";
import { ENTROPY_WARN_BITS } from "../primitives/keyring.js";
import { appErrorName, FIELD_KINDS, type FieldKind, REJECT } from "../redact.js";
import type { AuthEvent } from "./port.js";

export interface FieldSpec {
  readonly kind: FieldKind;
  /** The closed list of an `enum` field. */
  readonly values?: readonly string[];
  readonly optional?: true;
}

/** The log line of a fault event: the `console` method, the text, and the arguments of today. */
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

/** Every hook name, read from the five hook point constants. */
const HOOK_NAMES: readonly string[] = [
  ...Object.keys(ORGANIZATION_HOOK_POINTS).map((p) => `organization.${p}`),
  ...Object.keys(SESSION_HOOK_POINTS).map((p) => `session.${p}`),
  ...Object.keys(USER_HOOK_POINTS).map((p) => `user.${p}`),
  ...Object.keys(IDENTITY_HOOK_POINTS).map((p) => `identity.${p}`),
  ...Object.keys(OPERATOR_HOOK_POINTS).map((p) => `operator.${p}`),
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
 * rows: a row names one `SessionVia`, and those routes cannot (ruling 1
 * point 15 of plan 12h). The engine reports a failed second factor itself.
 */
export const SIGN_IN_ROUTES: { readonly [K in RouteKey]?: SessionVia } = {
  "POST /password/sign-in": "password",
  "GET /magic-link/verify": "magic_link",
  "POST /magic-link/verify": "magic_link",
  "POST /otp/verify": "email_otp",
  "POST /passkey/authenticate/verify": "passkey",
  "POST /handoff/redeem": "handoff",
  "GET /social/:provider/callback": "social",
  "POST /social/apple/callback": "social",
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

/**
 * The events. The fault events (those with `line`) are one row for each
 * text of the log lines of core. The texts are the start list of plan 12h
 * Task 1, read again at the 12k merge (63 texts). Tasks 4 to 8 add the
 * other groups.
 */
export const EVENTS = {
  // One event for each answer of `handle` (plan 12h Task 4). The router
  // stamps the route key. A method other than the three of the router is `other`.
  request: {
    level: "info",
    fields: {
      method: enumOf(["GET", "POST", "OPTIONS", "other"]),
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
    },
  },
  "observe.dropped": {
    level: "warn",
    fields: { buffer_full: COUNT, sink_timeout: COUNT, sink_threw: COUNT },
  },
  "observe.wait_until_threw": fault("error", "authtempo: waitUntil threw; the flush has no hook", {
    errorName: ERROR_NAME,
  }),
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
    { model: { kind: "name" }, rowId: ROW_ID, version: COUNT },
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
  "social.id_token_rejected": fault("error", "authtempo: social id token rejected", {
    provider: PROVIDER,
    errorClass: ERROR_CLASS,
  }),
  "social.nonce_mismatch": fault("error", "authtempo: social nonce mismatch", {
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
