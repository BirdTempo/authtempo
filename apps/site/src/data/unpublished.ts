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

/** The support window of SECURITY.md and of the versioning page while release/support.json is []. */
export const NO_RELEASE_YET =
  "No release exists yet. The first minor is the current minor at its release.";

/**
 * The channels and the times are owner promises, and no person can report
 * before the repository and the mailbox exist. So while no release exists,
 * SECURITY.md and the security policy page say so.
 */
export const CHANNELS_CLOSED =
  "Until the first release, the two channels are not open, and the times of this policy do not apply.";

/** The section "The versions today" of the versioning page while core is at 0.0.0. */
export const VERSIONS_TODAY =
  "Every package is private and at version `0.0.0`. No release exists, and the owner decides when the packages publish.";

/** A text that holds only before the first release, with the repository path of its file. */
export interface PreReleaseSentence {
  file: string;
  /** One sentence, or the sentences of one paragraph that goes as a whole. */
  sentence: string;
}

/**
 * Each text that is true only while no release exists (review M2 and L7 of
 * plan 12j Task 13b). check-pre-release holds each one in its file while core
 * is at 0.0.0, and out of its file above 0.0.0. So the version pull request
 * of the first release removes each one, or the site checks fail. The list
 * was read with `git grep -i` of "no release" and "until the first release"
 * on 2026-10-30. The check also fails on a text that matches
 * PRE_RELEASE_PATTERN in a docs page or a listed file, outside this list.
 * docs/release/RUNBOOK.md quotes each entry, and a site test holds the quotes.
 */
export const PRE_RELEASE_SENTENCES: readonly PreReleaseSentence[] = [
  { file: "SECURITY.md", sentence: NO_RELEASE_YET },
  { file: "SECURITY.md", sentence: CHANNELS_CLOSED },
  {
    file: "apps/site/src/content/docs/docs/reference/security-policy.md",
    sentence: CHANNELS_CLOSED,
  },
  { file: "apps/site/src/content/docs/docs/versioning.md", sentence: VERSIONS_TODAY },
  { file: "apps/site/src/content/docs/docs/versioning.md", sentence: NO_RELEASE_YET },
  {
    file: "apps/site/src/content/docs/docs/changelog.mdx",
    sentence:
      "Until the first release, the plan index of the repo is the record of each change: `docs/superpowers/plans/README.md`. Each row names a plan, its spec sections, and the commit that merged it.",
  },
  { file: "apps/site/src/content/docs/docs/resources.md", sentence: RESOURCES_EMPTY },
  // The authtempo cells of the rows g10 and g11 of /compare/.
  { file: "apps/site/src/data/compare.ts", sentence: "No release yet." },
  { file: "apps/site/src/data/compare.ts", sentence: "No release notes yet." },
];

/** The words of a text that holds only before the first release. */
export const PRE_RELEASE_PATTERN = /no release|until the first release/i;
