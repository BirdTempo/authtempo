/**
 * The note of the pages while no release exists (plan 12j Task 13, spec 33
 * item 11). The note stays page text, because a .md page cannot render a
 * component (plan 12j deviation 6). check-unpublished holds each page of
 * UNPUBLISHED_PAGES to the mark while core is at 0.0.0, and fails on any docs
 * page that holds the mark above 0.0.0. So the version pull request of the
 * first release replaces each note with REGISTRY_INSTALL, or the site
 * checks fail.
 */

/** The words that each note holds. */
export const UNPUBLISHED_MARK = "not on a registry yet";

/**
 * Each docs page that holds the note, by its path under src/content/docs/.
 * The list was read from the tree with `git grep -l` on 2026-10-30 (ruling 7
 * of plan 12j). check-unpublished fails on a page with the mark that this
 * list lacks, so a new page with the note joins the list.
 */
export const UNPUBLISHED_PAGES: readonly string[] = [
  "docs/migrate/auth0.mdx",
  "docs/migrate/authjs.mdx",
  "docs/migrate/better-auth.mdx",
  "docs/migrate/clerk.mdx",
  "docs/migrate/cognito.mdx",
  "docs/migrate/firebase.mdx",
  "docs/migrate/supabase.mdx",
  "docs/migrate/workos.mdx",
  "docs/operations/secrets.md",
  "docs/operations/upgrades.md",
  "docs/reference/cli/audit-list.md",
  "docs/reference/cli/audit.md",
  "docs/reference/cli/check.md",
  "docs/reference/cli/create-admin.md",
  "docs/reference/cli/generate.md",
  "docs/reference/cli/import.md",
  "docs/reference/cli/index.md",
  "docs/reference/cli/info.md",
  "docs/reference/cli/init.md",
  "docs/reference/cli/keys.md",
  "docs/reference/cli/mcp.md",
  "docs/reference/cli/migrate.md",
  "docs/reference/cli/secret-rewrap.md",
  "docs/reference/cli/secret-status.md",
  "docs/reference/cli/secret.md",
  "docs/reference/cli/sessions-end-all.md",
  "docs/reference/cli/sessions-end.md",
  "docs/reference/cli/sessions.md",
  "docs/reference/cli/users-ban.md",
  "docs/reference/cli/users-create.md",
  "docs/reference/cli/users-delete.md",
  "docs/reference/cli/users-get.md",
  "docs/reference/cli/users-list.md",
  "docs/reference/cli/users-platform-role.md",
  "docs/reference/cli/users-search.md",
  "docs/reference/cli/users-second-factor-off.md",
  "docs/reference/cli/users-unban.md",
  "docs/reference/cli/users-update.md",
  "docs/reference/cli/users.md",
  "docs/start/index.md",
  "docs/start/mcp-server.mdx",
  "docs/start/workers-d1.mdx",
];

/**
 * The install text of a published release. At the first release, each page
 * of UNPUBLISHED_PAGES holds it in place of the note. The scaffold of a
 * published CLI runs each step with pnpm exec (spec 33 item 11).
 */
export const REGISTRY_INSTALL =
  "The `@authtempo` packages are on npm. Add the CLI to your app with `pnpm add -D @authtempo/cli`, and run each command as `pnpm exec authtempo …`.";

/** The one sentence of the Resources page while no release exists (owner decision 6 of 2026-10-14). */
export const RESOURCES_EMPTY =
  "No release exists yet, so no package, example, or demo is published; this page lists them from the first release.";

/** The one sentence of the Releases part of the changelog page while no changelog exists. */
export const CHANGELOG_EMPTY = "No release exists. Every package is at version `0.0.0`.";
