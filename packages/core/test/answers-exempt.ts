import { ROUTES, type RouteKey } from "../src/http/route-list.js";

/** One declared code of one route that no test of core answers, with the reason (plan 11g Task 5). */
export interface AnswersExempt {
  readonly key: RouteKey;
  readonly code: string;
  readonly reason: string;
}

/** The key of each entry of `ROUTES`. */
const KEYS = ROUTES.map((r) => `${r.method} ${r.path}` as RouteKey);

/** One row per key of `keys` for `code`, with `reason`. */
function rows(code: string, reason: string, keys: readonly RouteKey[]): AnswersExempt[] {
  return keys.map((key) => ({ key, code, reason }));
}

/**
 * One row per route for a router code, except the routes in `answered`, where
 * a test causes the code. The check refuses a row whose code a record holds.
 * So a route that a test covers must be in `answered`, and no other may be.
 */
function routerRows(code: string, reason: string, answered: readonly RouteKey[]): AnswersExempt[] {
  return rows(
    code,
    reason,
    KEYS.filter((key) => !answered.includes(key)),
  );
}

const ROUTER_REASON = "the router's code; router.test.ts proves the path for one route";

/** The routes on which a test answers `internal`: a storage or a hook that throws inside the route. */
const INTERNAL_ANSWERED: readonly RouteKey[] = [
  // An outbox write that throws: the session end stays undone (plan 12e Task 16).
  "GET /oauth/end-session",
  // A family delete that throws after the end mark (ruling 43 of plan 12e).
  "POST /oauth/token",
  "POST /password/sign-up",
  "POST /reauth/email",
  // An outbox write that throws (plan 12e Task 16).
  "POST /sign-out",
];

/** The routes on which a test calls the path with its feature off. */
const NOT_FOUND_ANSWERED: readonly RouteKey[] = [
  "GET /.well-known/openid-configuration",
  "GET /handoff/start",
  "GET /jwks",
  "GET /oauth/device",
  "GET /oauth/grants",
  "GET /openapi.json",
  "GET /operator/info",
  "GET /operator/secrets/status",
  "GET /password/reset",
  "GET /password/verify",
  "GET /social/:provider/callback",
  "GET /social/:provider/start",
  "GET /token",
  "GET /totp",
  "GET /totp/challenge",
  "GET /user/delete/confirm",
  "POST /identities/unlink",
  "POST /oauth/device",
  "POST /oauth/device_authorization",
  "POST /oauth/grants/revoke",
  "POST /oauth/register",
  "POST /operator/keys/rotate",
  "POST /operator/secrets/rewrap",
  "POST /organizations/create",
  "POST /organizations/delete",
  "POST /organizations/invitations/revoke",
  "POST /organizations/invite",
  "POST /organizations/members/add",
  "POST /organizations/members/remove",
  "POST /organizations/members/role",
  "POST /organizations/update",
  "POST /otp/request",
  "POST /otp/reset",
  "POST /otp/reset/request",
  "POST /otp/verify",
  "POST /passkey/authenticate/options",
  "POST /passkeys/delete",
  "POST /passkeys/rename",
  "POST /password/change",
  "POST /password/reset",
  "POST /password/reset/request",
  "POST /password/sign-in",
  "POST /password/sign-up",
  "POST /password/verify",
  "POST /password/verify/resend",
  "POST /second-factor/passkey/enable",
  "POST /sessions/revoke",
  "POST /token/live",
  "POST /tokens",
  "POST /tokens/revoke",
  "POST /totp/backup-codes",
  "POST /totp/challenge",
  "POST /totp/devices/revoke",
  "POST /totp/disable",
  "POST /totp/enable",
  "POST /totp/setup",
  "POST /totp/verify",
  "POST /user/change-email",
  "POST /user/change-email/verify",
  "POST /user/delete",
  "POST /user/delete/confirm",
];

/** The POST routes on which a test sends an Origin that is not trusted. */
const ORIGIN_ANSWERED: readonly RouteKey[] = [
  "POST /handoff/continue",
  "POST /handoff/redeem",
  "POST /identities/unlink",
  "POST /magic-link/request",
  "POST /magic-link/verify",
  "POST /oauth/authorize",
  "POST /oauth/device",
  "POST /oauth/device_authorization",
  "POST /oauth/grants/revoke",
  "POST /oauth/introspect",
  "POST /oauth/register",
  "POST /oauth/revoke",
  "POST /oauth/token",
  "POST /oauth/userinfo",
  "POST /operator/keys/rotate",
  "POST /operator/secrets/rewrap",
  "POST /organizations/active",
  "POST /organizations/create",
  "POST /organizations/delete",
  "POST /organizations/invitations/accept",
  "POST /organizations/invitations/decline",
  "POST /organizations/invitations/revoke",
  "POST /organizations/invite",
  "POST /organizations/members/add",
  "POST /organizations/members/remove",
  "POST /organizations/members/role",
  "POST /organizations/update",
  "POST /otp/request",
  "POST /otp/reset",
  "POST /otp/reset/request",
  "POST /otp/verify",
  "POST /passkey/authenticate/options",
  "POST /passkey/authenticate/verify",
  "POST /passkey/register/options",
  "POST /passkey/register/verify",
  "POST /passkeys/delete",
  "POST /passkeys/rename",
  "POST /password/change",
  "POST /password/reset",
  "POST /password/reset/request",
  "POST /password/sign-in",
  "POST /password/sign-up",
  "POST /password/verify",
  "POST /password/verify/resend",
  "POST /reauth",
  "POST /reauth/email",
  "POST /reauth/passkey/options",
  "POST /second-factor/disable",
  "POST /second-factor/email/enable",
  "POST /second-factor/email/send",
  "POST /second-factor/passkey/enable",
  "POST /second-factor/passkey/options",
  "POST /session/refresh",
  "POST /sessions/revoke",
  "POST /sessions/revoke-others",
  "POST /sign-out",
  "POST /social/:provider/link",
  "POST /token/live",
  "POST /tokens",
  "POST /tokens/revoke",
  "POST /totp/backup-codes",
  "POST /totp/challenge",
  "POST /totp/devices/revoke",
  "POST /totp/disable",
  "POST /totp/enable",
  "POST /totp/setup",
  "POST /totp/verify",
  "POST /user/change-email",
  "POST /user/change-email/confirm",
  "POST /user/change-email/verify",
  "POST /user/delete",
  "POST /user/delete/confirm",
  "POST /user/update",
];

/** The two provider callbacks: one engine function, `completeSocial`, after a provider exchange. */
const CALLBACKS: readonly RouteKey[] = [
  "GET /social/:provider/callback",
  "POST /social/apple/callback",
];

/**
 * Every declared code with no test that answers it through the router, one
 * row each with the reason. The check run fails on a row that a record
 * makes unneeded, so a row leaves when its test arrives.
 */
export const ANSWERS_EXEMPT: readonly AnswersExempt[] = [
  ...routerRows("internal", ROUTER_REASON, INTERNAL_ANSWERED),
  ...routerRows("origin_not_trusted", ROUTER_REASON, ORIGIN_ANSWERED),
  ...routerRows("not_found", ROUTER_REASON, NOT_FOUND_ANSWERED),

  // `conflict` needs a lost compare-and-set round, which no request can cause on its own.
  ...rows(
    "conflict",
    "five lost rounds of the user hold at a sign-in; account-delete.test.ts proves the engine path",
    [
      ...CALLBACKS,
      "POST /handoff/redeem",
      "POST /magic-link/verify",
      "POST /otp/reset",
      "POST /otp/verify",
      "POST /passkey/authenticate/verify",
      "POST /password/reset",
      "POST /password/sign-in",
      "POST /password/sign-up",
      "POST /password/verify",
      "POST /totp/challenge",
      "POST /totp/verify",
      "POST /organizations/create",
      "POST /organizations/members/add",
      "POST /organizations/invitations/accept",
    ],
  ),
  ...rows(
    "conflict",
    "a write that races the owner lock; organizations.test.ts proves the engine path",
    [
      "POST /organizations/delete",
      "POST /organizations/members/remove",
      "POST /organizations/members/role",
    ],
  ),
  ...rows(
    "conflict",
    "five lost rounds of the credential guard; identities.test.ts proves the engine path",
    ["POST /identities/unlink", "POST /passkeys/delete"],
  ),
  ...rows(
    "conflict",
    "a change that races the verify; sessions-claim.test.ts proves the engine path",
    ["POST /password/change"],
  ),
  ...rows(
    "conflict",
    "a factor row that changed under the write; second-factor.test.ts proves the engine path",
    [
      "POST /second-factor/disable",
      "POST /second-factor/email/enable",
      "POST /second-factor/email/send",
      "POST /second-factor/passkey/enable",
    ],
  ),
  ...rows(
    "conflict",
    "a factor row that changed under the write; totp.test.ts proves the engine path",
    ["POST /totp/setup", "POST /totp/enable", "POST /totp/disable", "POST /totp/backup-codes"],
  ),
  ...rows(
    "conflict",
    "five lost rounds of the user hold; email-change.test.ts proves the engine path",
    ["POST /user/change-email/confirm", "POST /user/change-email/verify"],
  ),
  ...rows(
    "conflict",
    "five lost rounds of the user hold; account-delete.test.ts proves the engine path",
    ["POST /user/delete", "POST /user/delete/confirm"],
  ),
  ...rows("conflict", "five lost rounds of the user hold; profile.test.ts proves the engine path", [
    "POST /user/update",
  ]),

  // A code that only a race, or a state that no flow reaches, answers.
  ...rows(
    "already_member",
    "a concurrent addMember wins the unique key while the token stays live; no test races it (invitations.ts)",
    ["POST /organizations/invitations/accept"],
  ),
  ...rows(
    "totp_not_enabled",
    "the factor row is read twice; a removal between the reads answers it; totp.test.ts proves proveUserFactor on the engine",
    ["POST /reauth"],
  ),
  ...rows(
    "last_credential",
    "the register ceremony refuses an unverified user, so no flow leaves a passkey as the one credential; identities.test.ts proves the guard on the engine",
    ["POST /passkeys/delete"],
  ),
  ...rows(
    "invalid_client",
    "the consent re-checks the held request; a client that changed since the page answers it; oauth-authorize.test.ts proves checkAuthorize",
    ["POST /oauth/authorize"],
  ),
  ...rows(
    "invalid_scope",
    "the consent re-checks the held request; a scope that changed since the page answers it; oauth-authorize.test.ts proves checkAuthorize",
    ["POST /oauth/authorize"],
  ),
  ...rows(
    "invalid_target",
    "the consent re-checks the held request; a resource that changed since the page answers it; oauth-authorize.test.ts proves checkAuthorize",
    ["POST /oauth/authorize"],
  ),
  ...rows(
    "unsupported_response_type",
    "the consent re-checks the held request; a response type that changed since the page answers it; oauth-authorize.test.ts proves checkAuthorize",
    ["POST /oauth/authorize"],
  ),
];

/**
 * One optional or nullable key of one JSON answer that no test answers in
 * that form (plan 11g Task 5, ruling 8). The reason names the engine test.
 * The field is a path: a top-level key, or a key in a nested object or an
 * array item (`sessions[].freshAt`). The recorder writes the paths each
 * answer leaves out and the paths it sets null. The check holds each
 * optional path to one absent record and each nullable path to one null
 * record, or to a row here. A row that a record covers fails.
 */
export interface AnswerShapeExempt {
  readonly key: RouteKey;
  readonly field: string;
  readonly form: "absent" | "null";
  readonly reason: string;
}

/** One row per optional key of a WebAuthn options answer, for each options route. */
function optionsRows(key: RouteKey, fields: readonly string[]): AnswerShapeExempt[] {
  return fields.map((field) => ({
    key,
    field,
    form: "absent",
    reason:
      "the WebAuthn seam always writes it, and the schema keeps it optional as the WebAuthn JSON standard does; webauthn-seam.test.ts proves the options",
  }));
}

/** The optional keys of a request options answer that the seam always writes. */
const REQUEST_OPTION_KEYS = ["timeout", "rpId", "allowCredentials", "userVerification"] as const;

export const ANSWER_SHAPE_EXEMPT: readonly AnswerShapeExempt[] = [
  ...optionsRows("POST /passkey/register/options", [
    "timeout",
    "attestation",
    "authenticatorSelection",
    "excludeCredentials",
    "extensions",
    "hints",
    "rp.id",
    "authenticatorSelection.residentKey",
    "authenticatorSelection.requireResidentKey",
    "authenticatorSelection.userVerification",
  ]),
  ...optionsRows("POST /passkey/authenticate/options", REQUEST_OPTION_KEYS),
  {
    key: "POST /passkey/authenticate/options",
    field: "allowCredentials[].transports",
    form: "absent",
    reason:
      "the sign-in options carry no credentials: passkeys.ts passkeyAuthenticationOptions calls the seam with no list, so no item exists; webauthn-seam.test.ts:96 proves the empty list",
  },
  ...optionsRows("POST /reauth/passkey/options", REQUEST_OPTION_KEYS),
  ...optionsRows("POST /second-factor/passkey/options", REQUEST_OPTION_KEYS),
  {
    key: "POST /passkeys/rename",
    field: "passkey.name",
    form: "null",
    reason:
      "the rename sets a name, so its answer always has one; GET /passkeys answers the null name; passkey-rename.test.ts proves the rename",
  },
  {
    key: "GET /tokens/current",
    field: "apiToken.lastUsedAt",
    form: "null",
    reason:
      "the bearer check stamps lastUsedAt before the route answers; GET /tokens answers the null form; tokens.test.ts proves the stamp",
  },
  {
    key: "GET /sessions",
    field: "sessions[].freshAt",
    form: "null",
    reason:
      "every sign-in writes freshAt, so only a session row from before schema version 10 has none; fresh.test.ts proves the null form on the engine",
  },
  // The enable answers the status after the write, where both keys are set.
  {
    key: "POST /totp/enable",
    field: "enabledAt",
    form: "null",
    reason:
      "the answer is the status after the write, where the key is set; GET /totp answers it null; totp.test.ts proves the enable",
  },
  {
    key: "POST /totp/enable",
    field: "backupCodesVersion",
    form: "null",
    reason:
      "the answer is the status after the write, where the key is set; GET /totp answers it null; totp.test.ts proves the enable",
  },
];
