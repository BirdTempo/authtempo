import { ROUTES, type RouteFeature } from "@authtempo/core/routes";
import type { IconName } from "./icons.ts";

/**
 * One feature row of the home page (brand spec 9) and of /features/. Plan 11b
 * Task 4 adds `guide`, the docs URL path of the page that shows the feature.
 * It has an anchor when one section of the page holds the feature.
 * check-features holds each guide to a page of the build.
 */
export interface Feature {
  title: string;
  line: string;
  icon: IconName;
  guide: string;
}

/**
 * One row per member of RouteFeature. It had 17 at 0ef9665. Plan 11g adds
 * `openapi`, the 18th, and plan 12e adds `oauthDevice`, the 19th. Plan 12f
 * adds `operatorUsers`, the 20th, and `operatorImpersonation`, the 21st.
 * Plan 12k adds `dynamicRoles`, the 22nd, and `teams`, the 23rd. A Record
 * over the union fails the site's typecheck when core adds a member, so a
 * new feature cannot
 * ship without its row. Each line restates the description of its guide.
 * The sprite has no symbol for `account` or `accountDelete` (spec 8 names 16
 * icons, and decision 3 keeps the list). `account` takes `verify`: its first
 * route is the re-authentication, and the guide says "prove it again".
 * `accountDelete` takes `magic-link`, because each delete mails by default.
 * It mails a link when `account.deleteConfirm` is on, and the notice when
 * `account.notices` is on. The first option is off by default, and the second
 * is on. The next row, `magicLink`, also shows the envelope. We accept the
 * repeat: no symbol of spec 8 means a removal, and spec 9 sets no rule against
 * a repeat. The three oauth rows also repeat.
 * The guide of `session` is the architecture page (plan 11b Task 4). The guide
 * of `operator` is the Operator section of the routes page, which shows its
 * four routes (ruling 18 of the plan 11b lane). Until the guide of plan
 * 12f Task 14, the guide of `operatorUsers` is the section of the routes
 * page that shows its routes. The guide of `operatorImpersonation` is the
 * Impersonation section of that page. Until plan 12k Task 9
 * writes its guide, `dynamicRoles` points to its section of the routes page.
 * `dynamicRoles` repeats the `organization` symbol. `teams` does the same,
 * with its own section of the routes page. `accountDelete`,
 * `oauthRegistration`, and `oauthDevice` point to the section of their guide
 * that holds them.
 * `openapi` has no guide: its
 * reference page documents the route and the document.
 */
export const FEATURES: Readonly<Record<RouteFeature, Feature>> = {
  session: {
    title: "Sessions",
    line: "A session cookie or a bearer token, checked on each request.",
    icon: "session",
    guide: "/docs/concepts/architecture/",
  },
  account: {
    title: "Account settings",
    line: "See and end sessions, prove it again, and change the profile.",
    icon: "verify",
    guide: "/docs/guides/account-settings/",
  },
  accountDelete: {
    title: "Account deletion",
    line: "Delete the account, with a mailed link when the option is on.",
    icon: "magic-link",
    guide: "/docs/guides/account-settings/#how-it-behaves",
  },
  magicLink: {
    title: "Magic links",
    line: "A single-use link by mail opens a session.",
    icon: "magic-link",
    guide: "/docs/guides/magic-link/",
  },
  social: {
    title: "Social sign-in",
    line: "Sign in with Google, Apple, GitHub, LinkedIn, or an OIDC provider.",
    icon: "social",
    guide: "/docs/guides/social/",
  },
  passkey: {
    title: "Passkeys",
    line: "Register a passkey, and sign in with a discoverable passkey.",
    icon: "passkey",
    guide: "/docs/guides/passkeys/",
  },
  password: {
    title: "Passwords",
    line: "Sign-up, sign-in, mail verification, reset, and change with a password.",
    icon: "password",
    guide: "/docs/guides/password/",
  },
  totp: {
    title: "Second factor",
    line: "Finish a sign-in with TOTP, a passkey, or an email code.",
    icon: "second-factor",
    guide: "/docs/guides/second-factor/",
  },
  emailOtp: {
    title: "Email codes",
    line: "A 6 or 8 digit code by mail signs a person in.",
    icon: "otp",
    guide: "/docs/guides/email-code/",
  },
  emailOtpReset: {
    title: "Reset by code",
    line: "A code by mail resets a forgotten password.",
    icon: "otp",
    guide: "/docs/guides/email-code/",
  },
  handoff: {
    title: "Native apps",
    line: "Sign in from Expo or Electron through the system browser.",
    icon: "client",
    guide: "/docs/guides/handoff/",
  },
  organizations: {
    title: "Organizations",
    line: "Organizations, ranked roles, mailed invitations, and the active organization.",
    icon: "organization",
    guide: "/docs/guides/organizations/",
  },
  dynamicRoles: {
    title: "Dynamic roles",
    line: "Each organization stores its own roles, with a rank and a set of actions.",
    icon: "organization",
    guide: "/docs/reference/routes/#dynamic-roles",
  },
  teams: {
    title: "Teams",
    line: "Named groups of members inside an organization, with an active team per session.",
    icon: "organization",
    guide: "/docs/reference/routes/#teams",
  },
  tokens: {
    title: "API tokens",
    line: "A script or a CLI calls your routes with an API token.",
    icon: "keyring",
    guide: "/docs/guides/api-tokens/",
  },
  jwtMint: {
    title: "Session JWTs",
    line: "A short JWT that another server checks against your key set.",
    icon: "verify",
    guide: "/docs/guides/jwt/",
  },
  operator: {
    title: "Operator routes",
    line: "Rotate the signing key and reseal the app secrets with a hashed operator secret.",
    icon: "cli",
    guide: "/docs/reference/routes/#operator",
  },
  operatorUsers: {
    title: "Operator user tools",
    line: "List, ban, and sign out users, with an audit row for each act.",
    icon: "cli",
    guide: "/docs/reference/routes/#operator-user-tools",
  },
  operatorImpersonation: {
    title: "Impersonation",
    line: "A platform operator acts as a user for support, with a time limit, a mark, and a notice.",
    icon: "session",
    guide: "/docs/reference/routes/#impersonation",
  },
  oauth: {
    title: "OAuth provider",
    line: "Agents and MCP clients get access tokens with consent and PKCE.",
    icon: "oauth",
    guide: "/docs/guides/oauth-provider/",
  },
  oauthRegistration: {
    title: "Client registration",
    line: "An MCP client registers itself when you turn the option on.",
    icon: "oauth",
    guide: "/docs/guides/oauth-provider/#how-it-behaves",
  },
  oauthDevice: {
    title: "Device sign-in",
    line: "A device with no browser gets tokens after the person types a short code on your site.",
    icon: "oauth",
    guide: "/docs/guides/oauth-provider/#the-device-flow",
  },
  openapi: {
    title: "OpenAPI document",
    line: "An OpenAPI 3.1 document of the routes, with their schemes and errors.",
    icon: "routes",
    guide: "/docs/reference/openapi/",
  },
};

/** The members of RouteFeature in the order of their first route. */
export function featureOrder(routes: readonly { feature: RouteFeature }[]): RouteFeature[] {
  const out: RouteFeature[] = [];
  for (const r of routes) if (!out.includes(r.feature)) out.push(r.feature);
  return out;
}

/** The count of routes of one feature, from ROUTES at build time. /features/ states it. */
export function routeCount(f: RouteFeature): number {
  return ROUTES.filter((r) => r.feature === f).length;
}

/** The route count as /features/ writes it, and as check-features reads it. */
export function routeLabel(n: number): string {
  return n === 1 ? "1 route" : `${n} routes`;
}

/** One package row of /features/: what a reader installs. */
export interface PackageFeature {
  title: string;
  line: string;
  guide: string;
}

/**
 * One row per folder of packages/ that a reader installs, keyed by the folder.
 * Each line restates the first sentence of the package README. check-features
 * fails a folder with no row and no exemption, so a new package needs one.
 */
export const PACKAGE_FEATURES: Readonly<Record<string, PackageFeature>> = {
  "adapter-d1": {
    title: "D1 adapter",
    line: "The storage adapter for Cloudflare D1, with no Node dependency.",
    guide: "/docs/start/workers-d1/",
  },
  "adapter-postgres": {
    title: "Postgres adapter",
    line: "The storage adapter for Postgres through postgres.js.",
    guide: "/docs/start/workers-hyperdrive/",
  },
  astro: {
    title: "Astro",
    line: "The Astro binding of authtempo, for on-demand pages.",
    guide: "/docs/reference/astro/",
  },
  "breach-check": {
    title: "Breach check",
    line: "The HIBP Pwned Passwords range API behind the password breach check of core.",
    guide: "/docs/guides/breach-check/",
  },
  "captcha-turnstile": {
    title: "Turnstile",
    line: "Cloudflare Turnstile behind the captcha port of core.",
    guide: "/docs/guides/captcha/",
  },
  cli: {
    title: "Command line",
    line: "The authtempo command sets up, migrates, imports into, checks, and maintains a deployment.",
    guide: "/docs/reference/cli/",
  },
  client: {
    title: "Client",
    line: "The app side of authtempo calls the routes of core and returns typed results.",
    guide: "/docs/reference/client/",
  },
  "compat-better-auth": {
    title: "Better Auth compatibility",
    line: "Run an app written for Better Auth on authtempo, with its code and its tables.",
    guide: "/docs/migrate/better-auth/",
  },
  express: {
    title: "Express",
    line: "The Express binding of authtempo, for Express on Node.",
    guide: "/docs/reference/express/",
  },
  fastify: {
    title: "Fastify",
    line: "The Fastify binding of authtempo, for Fastify on Node.",
    guide: "/docs/reference/fastify/",
  },
  handoff: {
    title: "App handoff",
    line: "Sign in a native or desktop app through the system browser, with Expo or Electron.",
    guide: "/docs/reference/handoff/",
  },
  hono: {
    title: "Hono",
    line: "The Hono binding of authtempo, for Workers, Node, Bun, and Deno.",
    guide: "/docs/reference/hono/",
  },
  import: {
    title: "Importer",
    line: "Move users, social identities, password hashes, passkeys, organizations, and members into authtempo.",
    guide: "/docs/reference/cli/import/",
  },
  // The start page names this package in its table. Each provider guide of
  // /docs/migrate/ shows the chain for one provider only (ruling 18).
  "legacy-hashes": {
    title: "Legacy password hashes",
    line: "Verify the password hashes of another provider at sign-in, and rewrite each one as PBKDF2.",
    guide: "/docs/start/",
  },
  mcp: {
    title: "MCP server",
    line: "A coding agent searches and reads the docs, and runs the CLI in the project.",
    guide: "/docs/reference/mcp/",
  },
  next: {
    title: "Next.js",
    line: "The Next.js binding of authtempo, for the App Router.",
    guide: "/docs/reference/next/",
  },
  react: {
    title: "React",
    line: "The React binding of authtempo, for React DOM and React Native.",
    guide: "/docs/reference/react/",
  },
  "react-router": {
    title: "React Router",
    line: "The React Router binding of authtempo, for its server middleware.",
    guide: "/docs/reference/react-router/",
  },
  solid: {
    title: "Solid",
    line: "The Solid binding of authtempo.",
    guide: "/docs/reference/solid/",
  },
  sveltekit: {
    title: "SvelteKit",
    line: "The SvelteKit binding of authtempo.",
    guide: "/docs/reference/sveltekit/",
  },
  "tanstack-start": {
    title: "TanStack Start",
    line: "The TanStack Start binding of authtempo, for React Start and Solid Start.",
    guide: "/docs/reference/tanstack-start/",
  },
  verify: {
    title: "Verify",
    line: "Tell a server that is not the auth app who the caller is.",
    guide: "/docs/reference/verify/",
  },
  vue: {
    title: "Vue",
    line: "The Vue binding of authtempo, with the server of Nuxt.",
    guide: "/docs/reference/vue/",
  },
};

/** Each folder of packages/ that has no row, with its reason. check-features prints each one. */
export const PACKAGE_EXEMPT: Readonly<Record<string, string>> = {
  core: "every route feature is a row of FEATURES",
  "sdk-conformance": "a test package of the SDKs, not a feature",
};

/** The labels of /features/. check-terms and check-sentences read them with the rows. */
export const FEATURES_PAGE = {
  routes: "Route features",
  packages: "Packages",
} as const;
