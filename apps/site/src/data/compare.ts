/**
 * The facts of /compare/ (plan 11b Task 6, owner decision 3 of 2026-10-14).
 * The page claims only facts that we hold, each with its source and the day
 * of the read, and no price. check-facts fails a fact older than
 * FACT_MAX_DAYS, so the page cannot show an old fact.
 */

/** The age limit of a fact, in days (decision 3). */
export const FACT_MAX_DAYS = 180;

/** Which side has more on one row, after the read. */
export type CompareSide = "authtempo" | "parity" | "better-auth";

/**
 * One row of the review `review-vs-better-auth.md` of 2026-10-14, shortened
 * to 25 words a cell at most. `id` is the review row. `source` names the
 * review row, and the merged plan file when a fresh read of its code moved
 * the row. `read` is an ISO date: the older read of the two cells.
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

/** The day of the review: every Better Auth cell comes from it. */
const REVIEW_READ = "2026-10-14";
/** The day of the fresh read of the merged plans 11g, 12a, 12b, and 12c, and of the guides. */
const CODE_READ = "2026-10-19";

const review = (id: string) => `review-vs-better-auth.md, row ${id}`;
/** A row that a merged plan changed: the review row for Better Auth, the plan file for authtempo. */
const merged = (id: string, plans: readonly string[]) =>
  `${review(id)}; ${plans.map((p) => `docs/superpowers/plans/${p}`).join(", ")}`;

const P11D = "2026-10-14-11d-sdks.md";
const P11G = "2026-10-14-11g-openapi.md";
const P12A = "2026-10-14-12a-account-self-service.md";
const P12B = "2026-10-14-12b-security-hardening.md";
const P12C = "2026-10-14-12c-second-factor-reach.md";

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
 * is "authtempo" only when it also has more. A part that authtempo leaves
 * out by a design choice of the review keeps the review's side. The
 * authtempo cell then names that part (f4, f16, g6). Each other row is
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
    "Exact origins and app schemes only, with no wildcard and no function. A takeover of one subdomain gives no trust.",
    "Exact origins, wildcards, custom schemes, or a function for each request.",
  ),
  row(
    "f16",
    "authtempo",
    "Provider tokens at rest",
    "Stores no access token and no refresh token of a social provider, so the store holds none to steal. An app cannot call the provider with one.",
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
    "No telemetry, and no setting turns it on. No data leaves your app.",
    "Telemetry that is off by default, and that an app can turn on.",
  ),
  row(
    "g14",
    "authtempo",
    "Workers with no Node compatibility",
    "Every Worker sets no_nodejs_compat, and a bundle proof fails on any node: import.",
    "Not checked in the review.",
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

  // Where both do the same.
  row(
    "a4",
    "parity",
    "PKCE (RFC 7636)",
    "S256 on every code, on every social start, and on the native handoff.",
    "S256 only, and required for a public client.",
  ),
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

  // Where Better Auth does more today.
  row(
    "a1",
    "better-auth",
    "OAuth 2.1 clients",
    "Every client is public.",
    "Public and confidential clients.",
  ),
  row(
    "a2",
    "better-auth",
    "OAuth grants",
    "authorization_code and refresh_token.",
    "authorization_code, refresh_token, client_credentials, and the device code.",
  ),
  row(
    "a8",
    "better-auth",
    "Introspection (RFC 7662)",
    "No introspection route. A resource server checks the JWT offline.",
    "Supported.",
  ),
  row(
    "a10",
    "better-auth",
    "OIDC subjects",
    "Public subjects only.",
    "ID tokens, UserInfo, consent, and pairwise subjects.",
  ),
  row(
    "a11",
    "better-auth",
    "RS256 for OIDC",
    "Signs with EdDSA or ES256 only, so a client that needs RS256 refuses the discovery.",
    "RS256, PS256, ES256, ES512, and EdDSA.",
  ),
  row(
    "a12",
    "better-auth",
    "Sign-out at the provider (OIDC)",
    "No sign-out at the provider. A sign-out does not end an access token.",
    'The OIDC "RP-Initiated Logout" and "Back-Channel Logout" specs.',
  ),
  row(
    "a13",
    "better-auth",
    "Device grant (RFC 8628)",
    "No device grant.",
    "A device authorization plugin.",
  ),
  row(
    "a19",
    "better-auth",
    "DPoP (RFC 9449)",
    "Bearer access tokens only.",
    "DPoP, with the checks of the key and the token hash.",
  ),
  row(
    "a20",
    "better-auth",
    "Client keys (RFC 7523)",
    "No client authentication by a key, because no client is confidential.",
    "Supported.",
  ),
  row(
    "a25",
    "better-auth",
    "MCP authorization, revision 2026-07-28",
    "Targets the revision, but serves public clients only, and turns dynamic registration on by default.",
    "The MCP plugin targets it, with client metadata documents and dynamic registration off.",
  ),
  {
    ...row(
      "a27",
      "better-auth",
      "WebAuthn Level 3",
      "Passkey autofill. No passkey-first sign-up, no extensions, no related origins, no hints, and no Signal API.",
      "Autofill, the PRF, largeBlob, and credProps extensions, and passkey-first sign-up.",
    ),
    source: merged("a27", [P11D]),
  },
  row(
    "a28",
    "better-auth",
    "SCIM 2.0",
    "No directory provisioning.",
    "Users and Groups through @better-auth/scim.",
  ),
  row(
    "a29",
    "better-auth",
    "SAML 2.0 and SSO",
    "No SSO for each organization.",
    "SAML 2.0 and OIDC SSO for each organization, through @better-auth/sso.",
  ),
  moved(
    "a32",
    "better-auth",
    "ASVS 5.0 sessions",
    "A session list, the end of one or of the others, a fresh-session rule, and an absolute lifetime. No operator ends the sessions of a user.",
    "A list, the end of one, of the others, or of all, freshAge, and an admin who ends the sessions of a user.",
    [P12A, P12B],
  ),
  row(
    "b2",
    "better-auth",
    "Social presets",
    "Presets for Google, Apple, GitHub, and LinkedIn. Any other provider comes through the OIDC or the OAuth 2 setting.",
    "Built-in providers from Apple to Zoom, and Cloudflare since 1.7.3.",
  ),
  moved(
    "b3",
    "better-auth",
    "Second factor",
    "TOTP, backup codes, trusted devices, a passkey, or an email code. The factor gates each sign-in method but the passkey, which is two factors itself. No SMS code.",
    "TOTP, a code by email or SMS, backup codes, trusted devices, and a lockout that is on by default.",
    [P12C],
  ),
  {
    ...row(
      "b4",
      "better-auth",
      "Passkeys",
      "Passkeys with user verification and autofill. No passkey-first sign-up.",
      "The passkey plugin, with passkey-first sign-up.",
    ),
    source: merged("b4", [P11D]),
  },
  moved(
    "b6",
    "better-auth",
    "Email codes",
    "A code for sign-in, for a reset, and for a change of address. The address check of a sign-up uses a link.",
    "A code for sign-in, for a reset, for the address check, and for a change of address.",
    [P12A],
  ),
  row(
    "b9",
    "better-auth",
    "JWT algorithms",
    "EdDSA or ES256, with key retirement and rotateEvery.",
    "RS256, PS256, ES256, ES512, and EdDSA.",
  ),
  row(
    "b10",
    "better-auth",
    "OAuth provider",
    "Public clients, the code grant, refresh, revoke, userinfo, and the metadata.",
    "Each item of the OAuth rows above.",
  ),
  row(
    "b13",
    "better-auth",
    "Device authorization plugin",
    "Not supported.",
    "A device authorization plugin.",
  ),
  row(
    "b14",
    "better-auth",
    "API tokens",
    "API tokens of one user, with an optional organization. No scopes, no limit for each token, and no metadata.",
    "Permissions, a rate limit, a quota, and metadata for each key, and keys that an organization owns.",
  ),
  row(
    "b15",
    "better-auth",
    "Organizations",
    "Ranked roles, invitations, limits, and hooks. No teams, no permission statements, and no custom roles.",
    "Roles with permission statements, custom and dynamic roles, teams, and a slug check.",
  ),
  row(
    "b16",
    "better-auth",
    "Access control",
    "No access control builder.",
    "An access control builder.",
  ),
  row(
    "b17",
    "better-auth",
    "Admin tools",
    "The operator routes cover the keys, the secrets, and the info report only.",
    "List users, ban a user, set a role, act as a user, and end the sessions of a user.",
  ),
  row(
    "b18",
    "better-auth",
    "Guest sessions",
    "No guest session.",
    "Guest sessions that link to the account at the upgrade.",
  ),
  row(
    "b19",
    "better-auth",
    "User name sign-in",
    "No sign-in with a user name.",
    "Sign-in with a user name.",
  ),
  row("b20", "better-auth", "Phone sign-in", "No phone sign-in.", "Sign-in by an SMS code."),
  row(
    "b21",
    "better-auth",
    "Google One Tap",
    "No route that takes an ID token from Google One Tap.",
    "Google One Tap.",
  ),
  row(
    "b22",
    "better-auth",
    "Several sessions",
    "No account switch in one browser.",
    "Several sessions in one browser.",
  ),
  row(
    "b23",
    "better-auth",
    "The last method",
    "Not supported.",
    "Remembers the last sign-in method.",
  ),
  row(
    "b25",
    "better-auth",
    "OAuth on preview hosts",
    "No proxy, and no redirect override for each provider.",
    "OAuth on preview deployments through a proxy.",
  ),
  row("b33", "better-auth", "SSO plugin", "Not supported.", "SSO for each organization."),
  row("b34", "better-auth", "SCIM plugin", "Not supported.", "Directory provisioning."),
  row(
    "d1",
    "better-auth",
    "Schema output",
    "No schema output. The adapters ship SQL migration files.",
    "Prisma and Drizzle schemas, or SQL for Kysely.",
  ),
  row(
    "d4",
    "better-auth",
    "A first operator account",
    "No command for a first operator account.",
    "The create-admin command, with the admin plugin.",
  ),
  row(
    "d6",
    "better-auth",
    "Upgrade command",
    "No upgrade command.",
    "The upgrade command updates the packages of one release.",
  ),
  row(
    "f15",
    "better-auth",
    "Disclosure policy",
    "No SECURITY.md yet.",
    "A SECURITY.md with a 72-hour answer and a 90-day disclosure.",
  ),
  row(
    "g1",
    "better-auth",
    "Database adapters",
    "D1, Postgres, and memory.",
    "Kysely for SQLite, D1, Postgres, MySQL, and MSSQL, then Prisma, Drizzle, MongoDB, and memory.",
  ),
  row(
    "g2",
    "better-auth",
    "Migrations and ORM schemas",
    "Append-only SQL files and authtempo migrate. No ORM schema output.",
    "auth migrate, auth generate, and getMigrations in code.",
  ),
  row(
    "g7",
    "better-auth",
    "OpenTelemetry",
    "Fixed log lines with event names. No spans and no metrics.",
    "OpenTelemetry spans, an experimental option since 1.7.4.",
  ),
  row("g10", "better-auth", "Releases", "No release yet.", "Weekly patches on 1.7 and on 1.6."),
  row(
    "g11",
    "better-auth",
    "Changelog",
    "No release notes yet.",
    "A changelog on the site, and GitHub releases.",
  ),
  // Rows where Better Auth keeps a part that authtempo lacks (ruling 26 of the plan 11b lane).
  row(
    "d5",
    "better-auth",
    "A new app from the CLI",
    "authtempo init copies a tested example of each stack, and each copy passes its own test. No stack is Next.js.",
    "The init command covers Next.js and SQLite only.",
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
