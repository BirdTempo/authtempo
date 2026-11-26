/**
 * The facts of /compare/ (plan 11b Task 6, owner decision 3 of 2026-10-14).
 * The page claims only facts that we hold, each with its source and the day
 * of the read, and no price. check-facts fails a fact older than
 * FACT_MAX_DAYS, so the page cannot show an old fact.
 */

import type { BetterAuthDoc } from "./better-auth-docs.ts";

/** The age limit of a fact, in days (decision 3). */
export const FACT_MAX_DAYS = 180;

/** Which side has more on one row, after the read. */
export type CompareSide = "authtempo" | "parity" | "better-auth";

/**
 * One row of the review `review-vs-better-auth.md` of 2026-10-14, shortened
 * to 25 words a cell at most. `id` is the review row. `source` names the
 * public source of the Better Auth cell (SOURCES). When a fresh read of
 * merged code moved the row, it also names the plan file. Parts end at "; ".
 * `read` is an ISO date: the older read of the two cells.
 */
export interface CompareRow {
  id: string;
  topic: string;
  authtempo: string;
  betterAuth: string;
  side: CompareSide;
  source: string;
  read: string;
}

/**
 * One provider by its model only (decision 3): where the users are, and who
 * runs the sign-in. No price, no plan name, and no count of users.
 */
export interface HostedModel {
  /** The name in PROVIDERS of @authtempo/cli. The row id is `host-<provider>`. */
  provider: string;
  /** The name that the page shows. */
  name: string;
  users: "The provider's database" | "Your database";
  signIn: "The provider's servers" | "Your app";
  /** The `authtempo import <provider>` command, or null when PROVIDERS lacks the name. */
  importer: string | null;
  guide: string;
  source: string;
  read: string;
}

/**
 * The day of the review. Each Better Auth cell came from it, and so did each
 * authtempo cell of a `row()`. A row keeps this day while one of its cells
 * is that old: a row is as old as its older cell.
 */
const REVIEW_READ = "2026-10-14";
/**
 * The version of Better Auth that each Better Auth cell holds for, and the
 * day of that read. On that day each cell was read again in the packages of
 * this version on npm and in the docs. 70 cells held, and 4 changed: d5, g7,
 * g10, and g14. check-facts holds each npm source and the text of the page
 * to these two values.
 */
export const BETTER_AUTH_VERSION = "1.7.27";
export const BETTER_AUTH_READ = "2026-11-25";
/** The day of the fresh read of the merged plans 11g, 12a, 12b, and 12c, and of the guides. */
const CODE_READ = "2026-10-19";

/** The base of each docs page of Better Auth. */
export const BETTER_AUTH_DOCS_BASE = "https://better-auth.com/docs/";
/** A docs page of Better Auth: its path must be a member of BETTER_AUTH_DOCS (re-review R6). */
const doc = (path: BetterAuthDoc) => `${BETTER_AUTH_DOCS_BASE}${path}`;
/** The package that the read of BETTER_AUTH_READ read in code, at its version. */
const NPM = `npm better-auth@${BETTER_AUTH_VERSION},`;
/** Another package of Better Auth at the same version: `auth` is its CLI, and `@better-auth/core` its core. */
const npm = (name: "auth" | "@better-auth/core", file: string) =>
  `npm ${name}@${BETTER_AUTH_VERSION}, ${file}`;
/** The releases of Better Auth on GitHub. */
const RELEASES = "https://github.com/better-auth/better-auth/releases";

/**
 * The public source of each Better Auth cell (final review m4 of plan 11b).
 * Each id is a row of the review review-vs-better-auth.md of 2026-10-14, an
 * internal file. The review read each source below on that day, so the page
 * names the source and keeps the date of the read. check-facts fails a
 * source that is not public and not a tracked file of this repository.
 */
const SOURCES: Readonly<Record<string, readonly string[]>> = {
  a1: [doc("plugins/oauth-provider")],
  a2: [doc("plugins/oauth-provider")],
  a4: [doc("plugins/oauth-provider")],
  a8: [doc("plugins/oauth-provider")],
  a9: [doc("plugins/oauth-provider")],
  a10: [doc("plugins/oauth-provider")],
  a11: [doc("plugins/jwt"), `${NPM} dist/plugins/jwt/types.d.mts`],
  a12: [doc("plugins/oauth-provider"), `${RELEASES}/tag/v1.7.0`],
  a13: [doc("plugins/device-authorization")],
  a18: [doc("plugins/oauth-provider")],
  a19: [doc("plugins/oauth-provider"), `${RELEASES}/tag/v1.7.0`],
  a20: [doc("plugins/oauth-provider")],
  a25: [doc("plugins/mcp")],
  a26: [doc("plugins/2fa")],
  a27: [doc("plugins/passkey")],
  a28: [doc("plugins/scim")],
  a29: [doc("plugins/sso")],
  a31: [
    doc("plugins/have-i-been-pwned"),
    doc("plugins/2fa"),
    `${NPM} dist/api/routes/password.mjs`,
  ],
  a32: [doc("concepts/session-management"), doc("plugins/admin")],
  b1: [doc("authentication/email-password")],
  b2: [doc("concepts/oauth"), doc("authentication/cloudflare")],
  b3: [doc("plugins/2fa")],
  b4: [doc("plugins/passkey")],
  b5: [doc("plugins/magic-link")],
  b6: [doc("plugins/email-otp")],
  b8: [doc("plugins/bearer")],
  b9: [doc("plugins/jwt"), `${NPM} dist/plugins/jwt/types.d.mts`],
  b10: [doc("plugins/oauth-provider")],
  b13: [doc("plugins/device-authorization")],
  b14: [doc("plugins/api-key")],
  b15: [doc("plugins/organization")],
  b16: [doc("plugins/admin")],
  b17: [doc("plugins/admin")],
  b18: [doc("plugins/anonymous")],
  b19: [doc("plugins/username")],
  b20: [doc("plugins/phone-number")],
  b21: [doc("plugins/one-tap")],
  b22: [doc("plugins/multi-session")],
  b23: [doc("plugins/last-login-method")],
  b25: [doc("plugins/oauth-proxy")],
  b28: [doc("plugins/captcha")],
  b29: [doc("plugins/have-i-been-pwned")],
  b31: [doc("plugins/open-api")],
  b33: [doc("plugins/sso")],
  b34: [doc("plugins/scim")],
  b41: [doc("concepts/users-accounts"), doc("concepts/session-management")],
  d1: [doc("concepts/cli")],
  d4: [doc("plugins/admin")],
  // The docs page concepts/cli still names Next.js and SQLite only. The code of the CLI has the lists.
  d5: [npm("auth", "dist/index.mjs")],
  d6: [doc("concepts/cli")],
  d11: [doc("concepts/cli")],
  d12: [doc("plugins/jwt")],
  e1: [doc("plugins/open-api")],
  e7: [doc("reference/errors")],
  e10: [doc("guides/1-7-upgrade-guide")],
  f2: [doc("reference/security"), `${NPM} dist/context/create-context.mjs`],
  f3: [doc("reference/security")],
  f4: [doc("reference/options")],
  f6: [doc("concepts/cookies")],
  f10: [doc("plugins/have-i-been-pwned")],
  f11: [doc("plugins/captcha")],
  f12: [doc("reference/security")],
  f15: ["https://github.com/better-auth/better-auth/blob/main/SECURITY.md"],
  f16: [doc("concepts/users-accounts")],
  f18: [doc("concepts/session-management")],
  g1: [doc("concepts/database")],
  g2: [doc("concepts/cli")],
  g3: [`${RELEASES}/tag/v1.7.3`],
  g6: [doc("reference/telemetry")],
  g7: [doc("reference/instrumentation")],
  g8: [doc("concepts/hooks")],
  g10: [RELEASES],
  g11: [RELEASES],
  // The review did not read Better Auth for this row; the authtempo cell comes from this proof.
  g14: [
    "examples/worker/proof/bundle-no-node.mjs",
    npm("@better-auth/core", "dist/async_hooks/index.mjs"),
  ],
};

/** The public source of the Better Auth cell of a row. */
function review(id: string): string {
  const parts = SOURCES[id];
  if (parts === undefined) throw new Error(`compare.ts: row ${id} has no public source`);
  return parts.join("; ");
}
/** A row that merged code changed: the Better Auth source, then the file of this repository that holds the authtempo cell. */
const merged = (id: string, files: readonly string[]) => [review(id), ...files].join("; ");

const P11D = "packages/client/src/client.ts";
const P11G = "packages/core/src/openapi/document.ts";
const P12A = "packages/core/src/engine/account-delete.ts";
const P12B = "packages/core/src/secrets-entry.ts";
const P12C = "packages/core/src/engine/second-factor.ts";
const P12E = "packages/core/src/engine/oauth-token.ts";
const P12I = "packages/core/src/engine/phone.ts";

/**
 * The file of this repository that holds the authtempo cell of a row that
 * the read of 2026-11-25 moved. Plans 12d to 12k and the CLI plans shipped
 * these features after the read of 2026-10-19, and the rows still denied
 * them. check-compare now holds each such denial to the code.
 */
const CODE = {
  access: "packages/core/src/access.ts",
  anonymous: "packages/core/src/engine/anonymous.ts",
  config: "packages/core/src/config.ts",
  createAdmin: "packages/cli/src/commands/create-admin.ts",
  generate: "packages/cli/src/commands/generate.ts",
  idToken: "packages/core/src/engine/id-token.ts",
  impersonation: "packages/core/src/engine/operator/impersonation.ts",
  lastMethod: "packages/core/src/engine/last-method.ts",
  multiSession: "packages/core/src/engine/multi-session.ts",
  mysql: "packages/adapter-mysql/src/index.ts",
  operatorSessions: "packages/core/src/engine/operator/sessions.ts",
  operatorUsers: "packages/core/src/engine/operator/users.ts",
  organizationTokens: "packages/core/src/engine/organization-tokens.ts",
  otlp: "packages/observe/src/otlp.ts",
  passkeyExtensions: "packages/core/src/engine/passkey-extensions.ts",
  passkeys: "packages/core/src/engine/passkeys.ts",
  password: "packages/core/src/engine/password.ts",
  postgresMigrations: "packages/adapter-postgres/src/migrations.ts",
  roles: "packages/core/src/engine/roles.ts",
  scim: "packages/core/src/engine/scim/users.ts",
  securityPolicy: "SECURITY.md",
  sessionList: "packages/core/src/engine/session-list.ts",
  sqlite: "packages/adapter-sqlite/src/index.ts",
  sso: "packages/core/src/engine/sso/connections.ts",
  teams: "packages/core/src/engine/teams.ts",
  tokens: "packages/core/src/engine/tokens.ts",
  upgrade: "packages/cli/src/commands/upgrade.ts",
  username: "packages/core/src/engine/username.ts",
  webauthn: "packages/client/src/webauthn.ts",
} as const;

/** A row of the review as it stands, read on the day of the review. */
function row(
  id: string,
  side: CompareSide,
  topic: string,
  authtempo: string,
  betterAuth: string,
): CompareRow {
  return { id, topic, authtempo, betterAuth, side, source: review(id), read: REVIEW_READ };
}

/**
 * A row whose authtempo cell comes from a fresh read of merged code. The
 * read date stays the day of the review. A row is as old as its older
 * cell, and the Better Auth cell comes from the review.
 */
function moved(
  id: string,
  side: CompareSide,
  topic: string,
  authtempo: string,
  betterAuth: string,
  plans: readonly string[],
): CompareRow {
  return { id, topic, authtempo, betterAuth, side, source: merged(id, plans), read: REVIEW_READ };
}

/**
 * The rows, by side (rulings 25 and 26 of the plan 11b lane). A row is
 * "parity" only when authtempo has each part of its Better Auth cell. A row
 * is "authtempo" only when it also has more. One exception (ruling 27): a
 * lack that is a stated design choice for safety or privacy keeps the
 * review's side. Its reason is in the review, and the authtempo cell names
 * the lack and the reason with "by design" (f4, f16, g6). Each other row is
 * "better-auth": the new plan rows that are not merged, and each row where
 * Better Auth keeps a part. A port with one adapter does not match five
 * shipped providers.
 */
export const COMPARE_ROWS: readonly CompareRow[] = [
  // Where authtempo does more.
  row(
    "b5",
    "authtempo",
    "Magic link",
    "The link opens a confirm page with no side effect, so a mail scanner that follows it spends nothing.",
    "Has a magic link sign-in.",
  ),
  row(
    "d11",
    "authtempo",
    "Import from another provider",
    "authtempo import reads the users of each provider in the table below. A legacy hash passes at the first sign-in.",
    "No import command. Better Auth has migration guides only.",
  ),
  row(
    "e7",
    "authtempo",
    "Error reference",
    "A check holds every error code to an anchor of the reference, so a code with no anchor fails the build.",
    "Has error pages in its reference.",
  ),
  row(
    "f4",
    "authtempo",
    "Trusted origins",
    "Exact origins and app schemes only. No wildcard and no function, by design: a takeover of one subdomain then gives no trust.",
    "Exact origins, wildcards, custom schemes, or a function for each request.",
  ),
  row(
    "f16",
    "authtempo",
    "Provider tokens at rest",
    "No provider token at rest, by design: the store holds none to steal. So an app cannot call the provider API with a stored token.",
    "Stores the tokens of each linked account, with encryption as an option.",
  ),
  row(
    "g3",
    "authtempo",
    "Schema version",
    "A numbered schema version. An adapter checks it at its first use and refuses an older database. authtempo migrate stops on a newer one.",
    "Checks the schema at start, on by default since 1.7.3.",
  ),
  row(
    "g6",
    "authtempo",
    "Telemetry",
    "No telemetry, and no setting turns it on, by design: no data leaves your app.",
    "Telemetry that is off by default, and that an app can turn on.",
  ),
  row(
    "g14",
    "authtempo",
    "Workers with no Node compatibility",
    "Every Worker sets no_nodejs_compat, and a bundle proof fails on any node: import.",
    "Loads AsyncLocalStorage from node:async_hooks. With none, it warns that some features may not work.",
  ),
  row(
    "a26",
    "authtempo",
    "TOTP (RFC 6238)",
    "The same time window. Tests pin the vectors of RFC 6238 and RFC 4226, and a code passes once only.",
    "TOTP with a 30 second step and one step on each side.",
  ),
  moved(
    "f18",
    "authtempo",
    "Absolute session lifetime",
    "session.absoluteDays ends a session after a fixed number of days, whatever its sliding refresh.",
    "No cap in the docs that the review read.",
    [P12B],
  ),
  moved(
    "a27",
    "authtempo",
    "WebAuthn Level 3",
    "Autofill, passkey-first sign-up, the PRF, largeBlob, and credProps extensions, related origins, hints, and the Signal API.",
    "Autofill, the PRF, largeBlob, and credProps extensions, and passkey-first sign-up.",
    [P11D, CODE.passkeyExtensions, CODE.webauthn],
  ),

  // Where both do the same.
  row(
    "a9",
    "parity",
    "Server metadata (RFC 8414)",
    "Served at the root and under the base path.",
    "Served.",
  ),
  row(
    "a18",
    "parity",
    "The iss parameter (RFC 9207)",
    "On every redirect, and the metadata states it.",
    "Supported.",
  ),
  row(
    "b8",
    "parity",
    "Bearer token",
    "The bearer header works on every route.",
    "A bearer token works on every route.",
  ),
  row(
    "d12",
    "parity",
    "Signing key rotation",
    "authtempo keys rotate calls the operator route, and rotateEvery rotates on a schedule.",
    "The JWT plugin rotates on an interval that the config sets.",
  ),
  row(
    "e10",
    "parity",
    "Upgrade guide",
    "The docs have an upgrades page.",
    "Has an upgrade guide for 1.7.",
  ),
  moved(
    "b1",
    "parity",
    "Turn off open sign-up",
    "signUp is open, invited, or false.",
    "disableSignUp turns off the sign-up.",
    [P12B],
  ),
  moved(
    "b29",
    "parity",
    "Breach check",
    "@authtempo/breach-check calls the range API with padding and a time limit, and fails closed.",
    "The haveibeenpwned plugin calls the range API with padding.",
    [P12B],
  ),
  moved(
    "b41",
    "parity",
    "Account self-service",
    "Routes to update the profile, change the address, delete the account, list and end sessions, and link and unlink a provider.",
    "Routes to update the user, change the address, delete the user, list and end sessions, and link and unlink accounts.",
    [P12A],
  ),
  moved(
    "f2",
    "parity",
    "Secret strength",
    "Refuses a short secret, or a weak one by an entropy estimate. A secret near the limit gets a warning.",
    "Refuses the default secret, and warns on a short secret or low entropy.",
    [P12B],
  ),
  moved(
    "f3",
    "parity",
    "Secret rotation",
    "Versioned secrets. A signing key gets a new seal at its next signature, and an operator route reseals each old row.",
    "Versioned secrets, with a new encryption on the next write and no downtime.",
    [P12B],
  ),
  moved(
    "f6",
    "parity",
    "Cookie name prefix",
    "The session cookie is __Host-tempo_session by default.",
    "The __Secure- prefix by default on https.",
    [P12B],
  ),
  moved(
    "f10",
    "parity",
    "Breach check, as a security rule",
    "@authtempo/breach-check ships. A password that the check cannot test is refused.",
    "The haveibeenpwned plugin.",
    [P12B],
  ),
  moved(
    "f12",
    "parity",
    "A taken address at sign-up",
    "By default, each sign-up gets the same answer, and the owner of a taken address gets a mail.",
    "With a setting, each sign-up gets the same answer, with a simulated hash.",
    [P12B],
  ),
  moved(
    "a4",
    "parity",
    "PKCE (RFC 7636)",
    "S256 only. A public client sends it on every code. A confidential client may omit it only when it asks for openid with a nonce.",
    "S256 only, and required for a public client.",
    [P12E],
  ),
  moved(
    "a1",
    "parity",
    "OAuth 2.1 clients",
    "Public and confidential clients. A confidential client sends a secret by Basic or the form, or signs a client assertion.",
    "Public and confidential clients.",
    [P12E],
  ),
  moved(
    "a2",
    "parity",
    "OAuth grants",
    "authorization_code, refresh_token, client_credentials, and the device code. oauth.device turns on the device code.",
    "authorization_code, refresh_token, client_credentials, and the device code.",
    [P12E],
  ),
  moved(
    "a8",
    "parity",
    "Introspection (RFC 7662)",
    "An introspection route for a confidential client that api.oauth.clients marks with introspect.",
    "Supported.",
    [P12E],
  ),
  moved(
    "a10",
    "parity",
    "OIDC subjects",
    "ID tokens, UserInfo, consent, and pairwise subjects for a client of the pairwise subject type.",
    "ID tokens, UserInfo, consent, and pairwise subjects.",
    [P12E],
  ),
  moved(
    "a12",
    "parity",
    "Sign-out at the provider (OIDC)",
    "A sign-out that the client starts at the end-session route, and a back-channel sign-out to each linked client through oauth.fetch.",
    'The OIDC "RP-Initiated Logout" and "Back-Channel Logout" specs.',
    [P12E],
  ),
  moved(
    "a13",
    "parity",
    "Device grant (RFC 8628)",
    "The device grant, which oauth.device turns on.",
    "A device authorization plugin.",
    [P12E],
  ),
  moved(
    "a19",
    "parity",
    "DPoP (RFC 9449)",
    "DPoP-bound access tokens, with the checks of the key and the token hash.",
    "DPoP, with the checks of the key and the token hash.",
    [P12E],
  ),
  moved(
    "a20",
    "parity",
    "Client keys (RFC 7523)",
    "private_key_jwt: the client signs an assertion with a key of its jwks or jwks_uri.",
    "Supported.",
    [P12E],
  ),
  moved(
    "a25",
    "parity",
    "MCP authorization, revision 2026-07-28",
    "Targets the revision, with client metadata documents, public and confidential clients, and dynamic registration off by default.",
    "The MCP plugin targets it, with client metadata documents and dynamic registration off.",
    [P12E],
  ),
  moved(
    "b13",
    "parity",
    "Device authorization plugin",
    "The device grant ships in core, and oauth.device turns it on.",
    "A device authorization plugin.",
    [P12E],
  ),
  moved(
    "a28",
    "parity",
    "SCIM 2.0",
    "Users, Groups, and Bulk for each organization, with a SCIM token. scim turns it on.",
    "Users and Groups through @better-auth/scim.",
    [CODE.scim],
  ),
  moved(
    "a29",
    "parity",
    "SAML 2.0 and SSO",
    "SAML 2.0 and OIDC SSO for each organization, with verified domains. sso turns it on.",
    "SAML 2.0 and OIDC SSO for each organization, through @better-auth/sso.",
    [CODE.sso],
  ),
  moved(
    "b4",
    "parity",
    "Passkeys",
    "Passkeys with user verification, autofill, and passkey-first sign-up, which passkey.signUp turns on.",
    "The passkey plugin, with passkey-first sign-up.",
    [P11D, CODE.passkeys],
  ),
  moved(
    "b6",
    "parity",
    "Email codes",
    "A code for sign-in, for a reset, for the address check of a sign-up, and for a change of address.",
    "A code for sign-in, for a reset, for the address check, and for a change of address.",
    [P12A, CODE.password],
  ),
  moved(
    "b14",
    "parity",
    "API tokens",
    "Permissions, a rate limit, a quota with a refill, and metadata for each token, and tokens that an organization owns.",
    "Permissions, a rate limit, a quota, and metadata for each key, and keys that an organization owns.",
    [CODE.tokens, CODE.organizationTokens],
  ),
  moved(
    "b15",
    "parity",
    "Organizations",
    "Roles with permission statements, custom and dynamic roles, teams, and a slug check. Also ranked roles, invitations, limits, and hooks.",
    "Roles with permission statements, custom and dynamic roles, teams, and a slug check.",
    [CODE.roles, CODE.teams],
  ),
  moved(
    "b16",
    "parity",
    "Access control",
    "organizations.statements and organizations.roles set the permissions of each role, and a route checks a permission.",
    "An access control builder.",
    [CODE.access],
  ),
  moved(
    "b17",
    "parity",
    "Admin tools",
    "Operator routes list users, ban a user, set the platform role, act as a user, and end the sessions of a user.",
    "List users, ban a user, set a role, act as a user, and end the sessions of a user.",
    [CODE.operatorUsers, CODE.impersonation],
  ),
  moved(
    "b18",
    "parity",
    "Guest sessions",
    "anonymous turns on guest sessions. A sign-up replaces the guest user, and a hook moves its data to the account.",
    "Guest sessions that link to the account at the upgrade.",
    [CODE.anonymous],
  ),
  moved(
    "b19",
    "parity",
    "User name sign-in",
    "Sign-in with a user name, which username turns on.",
    "Sign-in with a user name.",
    [CODE.username],
  ),
  moved(
    "b20",
    "parity",
    "Phone sign-in",
    "Sign-in by an SMS code, which phone turns on.",
    "Sign-in by an SMS code.",
    [P12I],
  ),
  moved(
    "b21",
    "parity",
    "Google One Tap",
    "A route takes the ID token of Google One Tap, with a nonce by default.",
    "Google One Tap.",
    [CODE.idToken],
  ),
  moved(
    "b22",
    "parity",
    "Several sessions",
    "multiSession keeps the sessions of several users in one browser, with an account switch.",
    "Several sessions in one browser.",
    [CODE.multiSession],
  ),
  moved(
    "b23",
    "parity",
    "The last method",
    "lastMethod sets a cookie with the last sign-in method of the browser.",
    "Remembers the last sign-in method.",
    [CODE.lastMethod],
  ),
  moved(
    "b33",
    "parity",
    "SSO plugin",
    "SSO for each organization ships in core, and sso turns it on.",
    "SSO for each organization.",
    [CODE.sso],
  ),
  moved(
    "b34",
    "parity",
    "SCIM plugin",
    "Directory provisioning ships in core, and scim turns it on.",
    "Directory provisioning.",
    [CODE.scim],
  ),
  moved(
    "d1",
    "parity",
    "Schema output",
    "authtempo generate prints the schema as SQL, as a Drizzle schema, or as Prisma models.",
    "Prisma and Drizzle schemas, or SQL for Kysely.",
    [CODE.generate],
  ),
  moved(
    "d4",
    "parity",
    "A first operator account",
    "authtempo create-admin makes the first platform operator of a deployment.",
    "The create-admin command, with the admin plugin.",
    [CODE.createAdmin],
  ),
  moved(
    "d6",
    "parity",
    "Upgrade command",
    "authtempo upgrade moves every authtempo package of an app to one version.",
    "The upgrade command updates the packages of one release.",
    [CODE.upgrade],
  ),
  moved(
    "f15",
    "parity",
    "Disclosure policy",
    "A SECURITY.md with a first answer within 72 hours and a disclosure within 90 days.",
    "A SECURITY.md with a 72-hour answer and a 90-day disclosure.",
    [CODE.securityPolicy],
  ),
  moved(
    "g2",
    "parity",
    "Migrations and ORM schemas",
    "Append-only SQL files, authtempo migrate, and authtempo generate. The Postgres, MySQL, and SQLite adapters apply the migrations in code.",
    "auth migrate, auth generate, and getMigrations in code.",
    [CODE.generate, CODE.postgresMigrations],
  ),
  moved(
    "g7",
    "parity",
    "OpenTelemetry",
    "@authtempo/observe sends logs, a span for each request, and metrics as OTLP JSON over HTTP.",
    "OpenTelemetry spans, on by default and marked experimental. One option turns them off.",
    [CODE.otlp],
  ),
  moved(
    "a32",
    "parity",
    "ASVS 5.0 sessions",
    "A session list, the end of one, of the others, or of all, a fresh-session rule, and an absolute lifetime. An operator ends the sessions of a user.",
    "A list, the end of one, of the others, or of all, freshAge, and an admin who ends the sessions of a user.",
    [P12A, P12B, CODE.operatorSessions, CODE.sessionList],
  ),

  // Where Better Auth does more today.
  moved(
    "a11",
    "better-auth",
    "RS256 for OIDC",
    "jwtMint.alg is EdDSA, ES256, or RS256, and the ID token signs with it. No PS256 and no ES512.",
    "RS256, PS256, ES256, ES512, and EdDSA.",
    [P12E],
  ),
  moved(
    "b2",
    "better-auth",
    "Social presets",
    "Presets for Google, Apple, GitHub, LinkedIn, Microsoft Entra ID, Discord, GitLab, Slack, X, and Facebook. Any other provider comes through the OIDC or the OAuth 2 setting.",
    "Built-in providers from Apple to Zoom, and Cloudflare since 1.7.3.",
    [P12I],
  ),
  moved(
    "b3",
    "better-auth",
    "Second factor",
    "TOTP, backup codes, trusted devices, a passkey, or an email code. The factor gates each sign-in method but the passkey, which is two factors itself. No SMS code.",
    "TOTP, a code by email or SMS, backup codes, trusted devices, and a lockout that is on by default.",
    [P12C],
  ),
  moved(
    "b9",
    "better-auth",
    "JWT algorithms",
    "EdDSA, ES256, or RS256, with key retirement and rotateEvery. No PS256 and no ES512.",
    "RS256, PS256, ES256, ES512, and EdDSA.",
    [P12E],
  ),
  moved(
    "b10",
    "better-auth",
    "OAuth provider",
    "Each item of the OAuth rows above, but core signs no token with PS256 or ES512.",
    "Each item of the OAuth rows above.",
    [P12E],
  ),
  moved(
    "b25",
    "better-auth",
    "OAuth on preview hosts",
    "No proxy. baseURL takes a list of exact hosts, and each provider takes a redirectURI.",
    "OAuth on preview deployments through a proxy.",
    [CODE.config],
  ),
  moved(
    "g1",
    "better-auth",
    "Database adapters",
    "D1, Postgres, MySQL, SQLite, and memory.",
    "Kysely for SQLite, D1, Postgres, MySQL, and MSSQL, then Prisma, Drizzle, MongoDB, and memory.",
    [CODE.mysql, CODE.sqlite],
  ),
  row(
    "g10",
    "better-auth",
    "Releases",
    "One version of every package, from 0.1.0.",
    "Several patches a week on 1.7, and a patch on 1.6 every few weeks. Betas of 1.8 since 2026-10-15.",
  ),
  row(
    "g11",
    "better-auth",
    "Changelog",
    "A changelog page and a feed of each release.",
    "A changelog on the site, and GitHub releases.",
  ),
  // Rows where Better Auth keeps a part that authtempo lacks (ruling 26 of the plan 11b lane).
  row(
    "d5",
    "better-auth",
    "A new app from the CLI",
    "authtempo init copies a tested example of each stack, and each copy passes its own test. No stack is Next.js.",
    "The init command detects 13 frameworks, Next.js too. It sets up SQLite, Postgres, MySQL, MSSQL, MongoDB, Drizzle, or Prisma.",
  ),
  moved(
    "a31",
    "better-auth",
    "ASVS 5.0 authentication",
    "A reset asks for the second factor. A breach check, a uniform sign-up answer, and a mail after each credential change ship. No lockout.",
    "Ships a breach check, a sign-up mode that hides a taken address, and a second-factor lockout. A reset opens no session.",
    [P12A, P12B, P12C],
  ),
  moved(
    "b28",
    "better-auth",
    "Captcha",
    "A captcha port, and a Turnstile adapter package. Another provider answers the same port.",
    "Turnstile, reCAPTCHA, hCaptcha, CaptchaFox, and Vercel BotID.",
    [P12B],
  ),
  moved(
    "b31",
    "better-auth",
    "OpenAPI document",
    "An OpenAPI document of every route, served by core and by the docs, and held to the routes by a check.",
    "An OpenAPI document from the routes, with an interactive page.",
    [P11G],
  ),
  moved(
    "e1",
    "better-auth",
    "OpenAPI reference",
    "The docs serve the document and a reference page of it.",
    "An interactive page from the routes.",
    [P11G],
  ),
  moved(
    "f11",
    "better-auth",
    "Captcha, as a security rule",
    "A captcha port with a Turnstile adapter.",
    "Five captcha providers, Turnstile among them.",
    [P12B],
  ),
  moved(
    "g8",
    "better-auth",
    "Hooks",
    "Hooks on the user, the identity, the session, and the organization. No request hook: an app wraps the handler.",
    "Hooks before and after each endpoint, and database hooks on the user, the session, and the account.",
    [P12A],
  ),
];

/** The source of a model row: its migration guide. */
const guideFile = (provider: string) => `apps/site/src/content/docs/docs/migrate/${provider}.mdx`;

/** A hosted provider: the users are in its database, and its servers run the sign-in. */
function hosted(provider: string, name: string): HostedModel {
  return {
    provider,
    name,
    users: "The provider's database",
    signIn: "The provider's servers",
    importer: `authtempo import ${provider}`,
    guide: `/docs/migrate/${provider}/`,
    source: guideFile(provider),
    read: CODE_READ,
  };
}

/** Each member of PROVIDERS (plan 11f added WorkOS): six hosted providers, then Auth.js, a library. */
export const HOSTED_MODELS: readonly HostedModel[] = [
  hosted("supabase", "Supabase Auth"),
  hosted("clerk", "Clerk"),
  hosted("auth0", "Auth0"),
  hosted("firebase", "Firebase Auth"),
  hosted("cognito", "Amazon Cognito"),
  hosted("workos", "WorkOS"),
  {
    provider: "authjs",
    name: "Auth.js",
    users: "Your database",
    signIn: "Your app",
    importer: "authtempo import authjs",
    guide: "/docs/migrate/authjs/",
    source: guideFile("authjs"),
    read: CODE_READ,
  },
];

/**
 * The name of each other product of this page, in full and in short (spec 24
 * item 4, final review m1). No other root page and no demo page names one;
 * check-claims holds that, with its allowed phrases.
 */
export function otherNames(): string[] {
  const short = (name: string) => name.replace(/ Auth$/, "").replace(/^Amazon /, "");
  const names = [COMPARE_PAGE.betterAuth, ...HOSTED_MODELS.flatMap((m) => [m.name, short(m.name)])];
  return [...new Set(names)];
}

/** The labels of /compare/ outside its entry. check-terms and check-sentences read them. */
export const COMPARE_PAGE = {
  topic: "Topic",
  authtempo: "authtempo",
  betterAuth: "Better Auth",
  read: "Read",
  provider: "Provider",
  users: "Where the users are",
  signIn: "Who runs the sign-in",
  importer: "Import",
  noImporter: "None",
  age: `A row older than ${FACT_MAX_DAYS} days fails our build, so this page cannot show an old fact.`,
} as const;
