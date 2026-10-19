/**
 * Every export entry of an SDK package and the page that lists its exports
 * (plan 11d). The runner makes one export check per row, and
 * `test/entries.test.ts` holds the list to the `exports` map of each package
 * in `SDK_PACKAGES`: an entry with no row fails, and a row with no entry fails.
 */
export interface ExportEntry {
  /** The name of the check: `check-exports-<label>`. */
  label: string;
  pkg: string;
  /** The key of the package's `exports` map. */
  entry: string;
  /** The source file of the entry, from the repo root. */
  source: string;
  /** The page of the entry's exports tables. */
  page: string;
  /**
   * The h2 or h3 headings of the page whose tables list the exports of this
   * entry, and nothing else. The check reads those sections only.
   */
  headings: readonly string[];
}

export const EXPORT_ENTRIES: readonly ExportEntry[] = [
  {
    label: "core",
    pkg: "@authtempo/core",
    entry: ".",
    source: "packages/core/src/index.ts",
    page: "/docs/reference/api/",
    headings: ["Functions", "Classes and constants", "Types"],
  },
  // The SDK fact entries of core (plan 11d Task 1) and the operator secret entry, each in its own part of the core page.
  {
    label: "core-routes",
    pkg: "@authtempo/core",
    entry: "./routes",
    source: "packages/core/src/routes.ts",
    page: "/docs/reference/api/",
    headings: ["The route entry"],
  },
  {
    label: "core-credentials",
    pkg: "@authtempo/core",
    entry: "./credentials",
    source: "packages/core/src/credentials.ts",
    page: "/docs/reference/api/",
    headings: ["The credential entry"],
  },
  {
    label: "core-operator-secret",
    pkg: "@authtempo/core",
    entry: "./operator-secret",
    source: "packages/core/src/operator-secret.ts",
    page: "/docs/reference/api/",
    headings: ["The operator secret entry"],
  },
  // The app secret rules of plan 11c2, for `authtempo secret`.
  {
    label: "core-secrets",
    pkg: "@authtempo/core",
    entry: "./secrets",
    source: "packages/core/src/secrets-entry.ts",
    page: "/docs/reference/api/",
    headings: ["The secrets entry"],
  },
  // The route contract and the OpenAPI generator (plan 11g), on the page of the document.
  {
    label: "core-openapi",
    pkg: "@authtempo/core",
    entry: "./openapi",
    source: "packages/core/src/openapi/index.ts",
    page: "/docs/reference/openapi/",
    headings: ["Exports"],
  },
  {
    label: "client",
    pkg: "@authtempo/client",
    entry: ".",
    source: "packages/client/src/index.ts",
    page: "/docs/reference/client/",
    headings: ["Exports"],
  },
  {
    label: "client-oauth",
    pkg: "@authtempo/client",
    entry: "./oauth",
    source: "packages/client/src/oauth/index.ts",
    page: "/docs/reference/client-oauth/",
    headings: ["Exports"],
  },
  {
    label: "verify",
    pkg: "@authtempo/verify",
    entry: ".",
    source: "packages/verify/src/index.ts",
    page: "/docs/reference/verify/",
    headings: ["Exports"],
  },
  // The MCP guard of plan 11e Task 11, on its own page.
  {
    label: "verify-mcp",
    pkg: "@authtempo/verify",
    entry: "./mcp",
    source: "packages/verify/src/mcp.ts",
    page: "/docs/reference/verify-mcp/",
    headings: ["Exports"],
  },
  {
    label: "react",
    pkg: "@authtempo/react",
    entry: ".",
    source: "packages/react/src/index.ts",
    page: "/docs/reference/react/",
    headings: ["Exports"],
  },
  {
    label: "next",
    pkg: "@authtempo/next",
    entry: ".",
    source: "packages/next/src/index.ts",
    page: "/docs/reference/next/",
    headings: ["Exports"],
  },
  {
    label: "handoff",
    pkg: "@authtempo/handoff",
    entry: ".",
    source: "packages/handoff/src/index.ts",
    page: "/docs/reference/handoff/",
    headings: ["The main entry"],
  },
  {
    label: "handoff-expo",
    pkg: "@authtempo/handoff",
    entry: "./expo",
    source: "packages/handoff/src/expo.ts",
    page: "/docs/reference/handoff/",
    headings: ["The Expo entry"],
  },
  {
    label: "handoff-electron",
    pkg: "@authtempo/handoff",
    entry: "./electron",
    source: "packages/handoff/src/electron.ts",
    page: "/docs/reference/handoff/",
    headings: ["The Electron entry"],
  },
  // The bindings of plan 11d2, each on its own page; a page of two entries has one section per entry.
  {
    label: "hono",
    pkg: "@authtempo/hono",
    entry: ".",
    source: "packages/hono/src/index.ts",
    page: "/docs/reference/hono/",
    headings: ["Exports"],
  },
  {
    label: "express",
    pkg: "@authtempo/express",
    entry: ".",
    source: "packages/express/src/index.ts",
    page: "/docs/reference/express/",
    headings: ["Exports"],
  },
  {
    label: "astro",
    pkg: "@authtempo/astro",
    entry: ".",
    source: "packages/astro/src/index.ts",
    page: "/docs/reference/astro/",
    headings: ["Exports"],
  },
  {
    label: "sveltekit",
    pkg: "@authtempo/sveltekit",
    entry: ".",
    source: "packages/sveltekit/src/index.ts",
    page: "/docs/reference/sveltekit/",
    headings: ["The main entry"],
  },
  {
    label: "react-router",
    pkg: "@authtempo/react-router",
    entry: ".",
    source: "packages/react-router/src/index.ts",
    page: "/docs/reference/react-router/",
    headings: ["Exports"],
  },
  {
    label: "vue",
    pkg: "@authtempo/vue",
    entry: ".",
    source: "packages/vue/src/index.ts",
    page: "/docs/reference/vue/",
    headings: ["The browser entry"],
  },
  {
    label: "vue-nuxt",
    pkg: "@authtempo/vue",
    entry: "./nuxt",
    source: "packages/vue/src/nuxt.ts",
    page: "/docs/reference/vue/",
    headings: ["The Nuxt entry"],
  },
  {
    label: "solid",
    pkg: "@authtempo/solid",
    entry: ".",
    source: "packages/solid/src/index.ts",
    page: "/docs/reference/solid/",
    headings: ["The browser entry"],
  },
  {
    label: "solid-start",
    pkg: "@authtempo/solid",
    entry: "./start",
    source: "packages/solid/src/start.ts",
    page: "/docs/reference/solid/",
    headings: ["The Solid Start entry"],
  },
  {
    label: "sveltekit-store",
    pkg: "@authtempo/sveltekit",
    entry: "./store",
    source: "packages/sveltekit/src/store.ts",
    page: "/docs/reference/sveltekit/",
    headings: ["The store entry"],
  },
  {
    label: "fastify",
    pkg: "@authtempo/fastify",
    entry: ".",
    source: "packages/fastify/src/index.ts",
    page: "/docs/reference/fastify/",
    headings: ["Exports"],
  },
  {
    label: "tanstack-start",
    pkg: "@authtempo/tanstack-start",
    entry: ".",
    source: "packages/tanstack-start/src/index.ts",
    page: "/docs/reference/tanstack-start/",
    headings: ["Exports"],
  },
];

/** The entries that have no page of their own, each with the reason. */
export const EXEMPT_ENTRIES: readonly { pkg: string; entry: string; reason: string }[] = [
  {
    pkg: "@authtempo/core",
    entry: "./errors",
    reason: "the two error tables; the errors page holds each code (check-errors)",
  },
  {
    pkg: "@authtempo/core",
    entry: "./conformance",
    reason: "the storage adapter suite, for an adapter's own tests",
  },
  {
    pkg: "@authtempo/core",
    entry: "./limiter-conformance",
    reason: "the limiter suite, for a limiter's own tests",
  },
  {
    pkg: "@authtempo/core",
    entry: "./sql",
    reason: "the SQL statements that the two adapters share",
  },
  {
    pkg: "@authtempo/core",
    entry: "./testing",
    reason: "the soft authenticator and the test helpers",
  },
  {
    pkg: "@authtempo/core",
    entry: "./bindings",
    reason: "the gate of the server bindings; each binding page names it (plan 11d2)",
  },
  {
    pkg: "@authtempo/client",
    entry: "./conformance",
    reason: "the error-shape suite, for an SDK's own tests; it imports vitest at run time",
  },
];

/** The packages whose `exports` maps the entry test reads. */
export const SDK_PACKAGES: readonly string[] = [
  "@authtempo/core",
  "@authtempo/client",
  "@authtempo/verify",
  "@authtempo/react",
  "@authtempo/next",
  "@authtempo/handoff",
  "@authtempo/hono",
  "@authtempo/express",
  "@authtempo/astro",
  "@authtempo/sveltekit",
  "@authtempo/react-router",
  "@authtempo/vue",
  "@authtempo/solid",
  "@authtempo/fastify",
  "@authtempo/tanstack-start",
];
