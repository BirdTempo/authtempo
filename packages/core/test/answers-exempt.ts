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
  // A store that is down at the session read: the router line of each error class (plan 12h Task 3).
  "GET /session",
  // A store that stops: the trace header and the request event of a 500 (plan 12h Task 4).
  "POST /magic-link/request",
  // A family delete that throws after the end mark (ruling 43 of plan 12e).
  "POST /oauth/token",
  "POST /password/sign-up",
  "POST /reauth/email",
  // An outbox write that throws (plan 12e Task 16).
  "POST /sign-out",
];

/** The routes on which a test causes not_found: a feature that is off, or an id that names no row. */
const NOT_FOUND_ANSWERED: readonly RouteKey[] = [
  "GET /.well-known/openid-configuration",
  // A request to a host other than the RP ID (plan 12i Task 9).
  "GET /.well-known/webauthn",
  "GET /handoff/start",
  "GET /jwks",
  "GET /oauth/device",
  "GET /oauth/grants",
  "GET /openapi.json",
  "GET /operator/audit",
  "GET /operator/info",
  "GET /operator/secrets/status",
  "GET /operator/users",
  "GET /operator/users/get",
  "GET /operator/users/search",
  // An organization id that names no organization (plan 12k Task 3).
  "GET /organizations/permissions",
  // The five role routes with organizations.dynamicRoles off (plan 12k Task 4).
  "GET /organizations/roles",
  "GET /organizations/roles/get",
  // The nine team routes with organizations.teams off, and a team id that names no team (plan 12k Task 5).
  "GET /organizations/teams",
  "GET /organizations/teams/members",
  "GET /organizations/teams/mine",
  "GET /password/reset",
  "GET /password/verify",
  "GET /ready",
  "GET /social/:provider/callback",
  "GET /social/:provider/start",
  "GET /token",
  "GET /totp",
  "GET /totp/challenge",
  "GET /user/delete/confirm",
  "POST /identities/unlink",
  // Plan 12i Task 6: the anonymous routes with anonymous off.
  "POST /anonymous/sign-in",
  "POST /anonymous/delete",
  "POST /oauth/device",
  "POST /oauth/device_authorization",
  "POST /oauth/grants/revoke",
  "POST /oauth/register",
  "POST /operator/impersonate",
  "POST /operator/impersonate/stop",
  "POST /operator/keys/rotate",
  "POST /operator/secrets/rewrap",
  "POST /operator/sessions/end-all",
  "POST /operator/sessions/end-user",
  "POST /operator/users/ban",
  "POST /operator/users/create-admin",
  "POST /operator/users/platform-role",
  "POST /operator/users/second-factor/disable",
  "POST /operator/users/unban",
  "POST /organizations/create",
  "POST /organizations/delete",
  "POST /organizations/invitations/revoke",
  "POST /organizations/invite",
  "POST /organizations/members/add",
  "POST /organizations/members/remove",
  "POST /organizations/members/role",
  "POST /organizations/roles/create",
  "POST /organizations/roles/delete",
  "POST /organizations/roles/update",
  "POST /organizations/teams/active",
  "POST /organizations/teams/create",
  "POST /organizations/teams/delete",
  "POST /organizations/teams/members/add",
  "POST /organizations/teams/members/remove",
  "POST /organizations/teams/update",
  "POST /organizations/tokens/revoke",
  "POST /organizations/tokens/update",
  "POST /organizations/update",
  "POST /otp/request",
  "POST /otp/reset",
  "POST /otp/reset/request",
  "POST /otp/verify",
  "POST /passkey/authenticate/options",
  "POST /passkeys/delete",
  "POST /passkeys/rename",
  // Plan 12i Task 5: the remove of a user with no phone.
  "POST /phone/remove",
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
  "POST /tokens/update",
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
  // Plan 12d: a domain id that names no domain, or sso off.
  "POST /operator/sso/enforce-off",
  "POST /sso/domains/add",
  "POST /sso/domains/delete",
  "POST /sso/domains/update",
  "POST /sso/domains/verify",
  // Plan 12d Task 3: a connection id that names no connection, or an organization that does not exist.
  "GET /sso/connections",
  "POST /sso/connections/create",
  "POST /sso/connections/delete",
  "POST /sso/connections/update",
  // Plan 12d Task 8: the ACS with sso off.
  "POST /sso/:connectionId/acs",
  // Plan 12d Task 4: the discovery with sso off.
  "POST /sso/discover", // Plan 12d Task 9b: the SCIM posts with scim off, and a token id that names no token.
  "POST /scim/tokens/create",
  "POST /scim/tokens/revoke",
  "POST /scim/v2/.search",
  "POST /scim/v2/Bulk",
  "POST /scim/v2/Groups",
  "POST /scim/v2/Groups/.search",
  "POST /scim/v2/Users",
  "POST /scim/v2/Users/.search",
  // A check of a name on a deployment with the username off (plan 12i Task 2).
  "GET /username/available",
  // Plan 12i Task 11: the routes with multiSession off, and an id of no session of the browser.
  "GET /multi-session",
  "POST /multi-session/sign-out",
  "POST /multi-session/switch",
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
  "POST /operator/impersonate",
  "POST /operator/impersonate/stop",
  "POST /operator/keys/rotate",
  "POST /operator/secrets/rewrap",
  "POST /operator/sessions/end-all",
  "POST /operator/sessions/end-user",
  "POST /operator/users/ban",
  "POST /operator/users/create-admin",
  "POST /operator/users/platform-role",
  "POST /operator/users/second-factor/disable",
  "POST /operator/users/unban",
  "POST /organizations/active",
  "POST /organizations/check-slug",
  "POST /organizations/create",
  "POST /organizations/delete",
  "POST /organizations/has-permission",
  "POST /organizations/invitations/accept",
  "POST /organizations/invitations/decline",
  "POST /organizations/invitations/revoke",
  "POST /organizations/invite",
  "POST /organizations/members/add",
  "POST /organizations/members/remove",
  "POST /organizations/members/role",
  "POST /organizations/roles/create",
  "POST /organizations/roles/delete",
  "POST /organizations/roles/update",
  "POST /organizations/teams/active",
  "POST /organizations/teams/create",
  "POST /organizations/teams/delete",
  "POST /organizations/teams/members/add",
  "POST /organizations/teams/members/remove",
  "POST /organizations/teams/update",
  "POST /organizations/tokens",
  "POST /organizations/tokens/revoke",
  "POST /organizations/tokens/update",
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
  "POST /tokens/update",
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
  // Plan 12d: the domain writes and the override.
  "POST /operator/sso/enforce-off",
  "POST /sso/domains/add",
  "POST /sso/domains/delete",
  "POST /sso/domains/update",
  "POST /sso/domains/verify",
  // Plan 12d Task 3: the connection writes.
  "POST /sso/connections/create",
  "POST /sso/connections/delete",
  "POST /sso/connections/update",
  // Plan 12i Task 2: the set of a username.
  "POST /user/username",
  // Plan 12i Task 5: the phone routes.
  "POST /phone/request",
  "POST /phone/verify",
  "POST /phone/add",
  "POST /phone/add/verify",
  "POST /phone/remove",
  // Plan 12i Task 6: the anonymous routes.
  "POST /anonymous/sign-in",
  "POST /anonymous/delete",
  // Plan 12i Task 11: the cross-site switch, and the Fetch Metadata test of every POST.
  "POST /multi-session/sign-out",
  "POST /multi-session/switch",
  // Plan 12d Task 4: the discovery at sign-in.
  "POST /sso/discover", // Plan 12d Task 9b: the SCIM token writes and the posts of /scim/v2.
  "POST /scim/tokens/create",
  "POST /scim/tokens/revoke",
  "POST /scim/v2/.search",
  "POST /scim/v2/Bulk",
  "POST /scim/v2/Groups",
  "POST /scim/v2/Groups/.search",
  "POST /scim/v2/Users",
  "POST /scim/v2/Users/.search",
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
      "POST /organizations/teams/members/add",
    ],
  ),
  ...rows(
    "conflict",
    "a write that races the owner lock; organizations.test.ts proves the engine path. The organization delete also answers it after five rounds lost to a set of the active organization on Postgres; organization-delete-gap-race.test.ts of adapter-postgres proves that path",
    [
      "POST /organizations/delete",
      "POST /organizations/members/remove",
      "POST /organizations/members/role",
    ],
  ),
  ...rows(
    "conflict",
    "five lost rounds of the credential guard; identities.test.ts proves the engine path",
    ["POST /identities/unlink", "POST /passkeys/delete", "POST /phone/remove"],
  ),
  ...rows(
    "conflict",
    "five team delete rounds lost to a set of the active team on Postgres; team-delete-gap-race.test.ts of adapter-postgres proves the engine path",
    ["POST /organizations/teams/delete"],
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
  // Plan 12i Task 5: the set of a phone, the compare-and-set of the profile update.
  ...rows(
    "conflict",
    "five lost rounds of the compare-and-set of the user row; default-lines.test.ts proves the engine path (phone.set_gave_up)",
    ["POST /phone/add/verify"],
  ),
  // Plan 12d: two adds of one domain at once, and an update that races another write of the row.
  ...rows(
    "conflict",
    "a parallel add of the same domain loses the unique key, and a parallel write moves updatedAt under an update; no request can cause either on its own",
    ["POST /sso/domains/add", "POST /sso/domains/update"],
  ),
  // Plan 12d Task 3: an update of a connection that races another write of the row.
  ...rows(
    "conflict",
    "a parallel write moves updatedAt between the read and the update of a connection; no request can cause it on its own",
    ["POST /sso/connections/update"],
  ),
  ...rows(
    "conflict",
    "five lost rounds of the user hold; account-delete.test.ts proves the engine path",
    ["POST /operator/users/second-factor/disable", "POST /operator/sessions/end-user"],
  ),
  ...rows(
    "conflict",
    "five lost rounds of the compare-and-set of the ban fields (writeBanFields of ban.ts); no request can lose them, and no engine test loses them yet: an open point of plan 12f Task 10",
    ["POST /operator/users/ban", "POST /operator/users/unban"],
  ),
  ...rows(
    "conflict",
    "a grant that an account delete or a parallel grant races, or a role change that races the revoke; operator-platform-role.test.ts proves the engine path",
    ["POST /operator/users/platform-role"],
  ),
  ...rows(
    "conflict",
    "an organization or a user that a parallel act writes between the read and the transaction; operator-create-admin.test.ts proves the engine path",
    ["POST /operator/users/create-admin"],
  ),

  // A code that only a race, or a state that no flow reaches, answers.
  ...rows(
    "account_banned",
    "the sign-in needs a passkey ceremony or a provider exchange; operator-ban-doors.test.ts proves the ban at the engine door of each",
    [
      ...CALLBACKS,
      "POST /passkey/authenticate/verify",
      "GET /sso/:connectionId/callback",
      "POST /sso/:connectionId/acs",
    ],
  ),
  // Plan 12d Task 5: the doors of the enforcement and the SSO resolution.
  ...rows(
    "sso_required",
    "the Apple callback needs an Apple key; sso/enforce.test.ts drives the same door of completeSocial through the Google callback",
    ["POST /social/apple/callback"],
  ),
  ...rows(
    "sso_required",
    "the form route of verifyTwoFactor; sso/enforce.test.ts drives the same door through POST /totp/verify (ruling 38 of plan 12d)",
    ["POST /totp/challenge"],
  ),
  ...rows(
    "account_disabled",
    "the ACS needs a signed SAML Response; it shares resolveSsoUser with the OIDC callback, where sso/resolve.test.ts proves the refusal (plan 12d Task 10)",
    ["POST /sso/:connectionId/acs"],
  ),
  // sso/resolve.test.ts answers it at the OIDC callback: an address change before the hold
  // (ruling 78 of plan 12d).
  ...rows(
    "conflict",
    "the ACS needs a signed SAML Response; it shares resolveSsoUser with the OIDC callback, where sso/resolve.test.ts answers it",
    ["POST /sso/:connectionId/acs"],
  ),
  ...rows(
    "account_banned",
    "only a race with the ban reaches it: the ban deletes the challenges and the handoff codes in its transaction; operator-ban-doors.test.ts proves both, and writeSession stops the race row",
    ["POST /handoff/redeem", "POST /totp/verify", "POST /totp/challenge"],
  ),
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

/**
 * Plan 12i Task 11: the rows of a phone user of Task 5 with no address, in
 * the bag or active at a switch. The Task 11 join answers each null form,
 * and then this list is empty.
 */
export const UNTIL_VERIFIED_HANDLE: readonly AnswerShapeExempt[] = (
  [
    ["GET /multi-session", "sessions[].user.email"],
    ["POST /multi-session/switch", "user.email"],
  ] as const
).map(
  ([key, field]): AnswerShapeExempt => ({
    key,
    field,
    form: "null",
    reason:
      "a phone user of plan 12i Task 5 has no address; the join of Task 11 answers the null form and drops the row; address-less.test.ts proves the engine reads",
  }),
);

export const ANSWER_SHAPE_EXEMPT: readonly AnswerShapeExempt[] = [
  ...optionsRows("POST /passkey/register/options", [
    "timeout",
    "attestation",
    "authenticatorSelection",
    "excludeCredentials",
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
  // A ban of the product always holds its reason: the ban takes one, and the unban keeps it.
  ...(["GET /operator/users", "GET /operator/users/search"] as const).map(
    (key): AnswerShapeExempt => ({
      key,
      field: "users[].ban.reason",
      form: "null",
      reason:
        "every ban writes its reason, so no flow leaves a ban with none; the field is nullable because the user row allows it; operator-ban.test.ts proves the ban fields",
    }),
  ),
  {
    key: "GET /operator/users/get",
    field: "user.ban.reason",
    form: "null",
    reason:
      "every ban writes its reason, so no flow leaves a ban with none; the field is nullable because the user row allows it; operator-ban.test.ts proves the ban fields",
  },
  // Plan 12d: a verify answers 200 only for a verified domain, where both times are set.
  ...(["verifiedAt", "checkedAt"] as const).map(
    (field): AnswerShapeExempt => ({
      key: "POST /sso/domains/verify",
      field: `domain.${field}`,
      form: "null",
      reason:
        "a verify answers 200 only with the claim, which sets both times; GET /sso/domains and POST /sso/domains/update answer them null; sso/domain-routes.test.ts proves both",
    }),
  ),
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
    key: "GET /organizations/tokens/current",
    field: "apiToken.lastUsedAt",
    form: "null",
    reason:
      "the bearer check stamps lastUsedAt before the route answers; GET /organizations/tokens answers the null form; organization-tokens.test.ts proves the stamp",
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
  // Plan 12i Task 1: the address is nullable, and these routes answer the user of an address.
  ...(
    [
      ["POST /magic-link/verify", "user.email"],
      ["POST /otp/verify", "user.email"],
      ["POST /otp/reset", "user.email"],
      ["POST /password/reset", "user.email"],
      ["POST /password/sign-up", "user.email"],
      ["POST /user/change-email/confirm", "user.email"],
      ["POST /user/change-email/verify", "user.email"],
    ] as const
  ).map(
    ([key, field]): AnswerShapeExempt => ({
      key,
      field,
      form: "null",
      reason:
        "the route proves an address or sets one, so its user always has one; the schema is nullable because a user can have no address (plan 12i); address-less.test.ts proves the null rules",
    }),
  ),
  ...UNTIL_VERIFIED_HANDLE,
  // Plan 12i Task 1 (ruling 15): these routes need a member, and every member
  // has a verified address. The organization create, the member add, and the
  // invitation accept each need one (`verified` in organizations.ts), and no
  // route takes an address away. No task of plan 12i changes these gates.
  ...(
    [
      ["POST /organizations/active", "user.email"],
      ["POST /organizations/teams/active", "user.email"],
      ["POST /organizations/create", "member.email"],
      ["POST /organizations/invitations/accept", "member.email"],
      ["POST /organizations/members/add", "member.email"],
      ["POST /organizations/members/role", "member.email"],
      ["POST /organizations/teams/members/add", "member.email"],
      ["GET /organizations/members", "members[].email"],
      ["GET /organizations/teams/members", "members[].email"],
    ] as const
  ).map(
    ([key, field]): AnswerShapeExempt => ({
      key,
      field,
      form: "null",
      reason:
        "every member has a verified address: the organization create, the member add, and the invitation accept need one, and no route takes an address away; address-less.test.ts proves the engine reads",
    }),
  ),
];
