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
];
