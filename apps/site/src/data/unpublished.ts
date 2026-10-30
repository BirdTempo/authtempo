/**
 * The note of the pages while no release exists (plan 12j Task 13, spec 33
 * item 11). The note stays page text, because a .md page cannot render a
 * component (plan 12j deviation 6). check-unpublished holds each page of
 * UNPUBLISHED_PAGES to a note form while core is at 0.0.0, and fails on any
 * docs page that holds a note form above 0.0.0. At the first release, the
 * script scripts/release/src/rewrite-unpublished.ts replaces each note line
 * of PAGE_NOTES and each text of PRE_RELEASE_SENTENCES with its published
 * text (ruling 50 of plan 12j). So this file is the one list of the
 * pre-release texts of the site, and the release package reads it.
 */

/**
 * The forms of the note, in lower case (ruling 53 of plan 12j, Major 1). A
 * README can say "It is not published" or "When the package is published" in
 * place of the first form. The last two forms were found by `git grep -i` on
 * 2026-10-30, in the READMEs of observe and verify, the README of the CLI,
 * and the init page. A text holds the note when its lower-case text holds a
 * form, with each run of white space read as one space. So "Not on a
 * registry yet" counts too, also across a line break. check-pack, the source
 * test of the packed files, the README test, and rewrite-unpublished read
 * this list. check-unpublished reads it too (ruling 58 of plan 12j, item 3).
 */
export const UNPUBLISHED_FORMS = [
  "not on a registry yet",
  "it is not published",
  "when the package is published",
  "when the package is on npm",
  "until the packages are on a registry",
] as const;

/** One form of the note. */
export type UnpublishedForm = (typeof UNPUBLISHED_FORMS)[number];

/** The words that each note of a page holds: the first form. */
export const UNPUBLISHED_MARK: UnpublishedForm = UNPUBLISHED_FORMS[0];

/** Each form of the note that a text holds, with no regard to case or to a line break. */
export function noteForms(text: string): UnpublishedForm[] {
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  return UNPUBLISHED_FORMS.filter((form) => lower.includes(form));
}

/** The text of a published text that rewrite-unpublished replaces with the new version. */
export const VERSION_SLOT = "<version>";

/**
 * Each docs page that holds the note, by its path under src/content/docs/.
 * The list was read from the tree with `git grep -l` on 2026-10-30 (ruling 7
 * of plan 12j). check-unpublished fails on a page with a note form that this
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

/** A note line of the pages, and the line that takes its place at the first release. */
export interface PageNote {
  /** The whole line of the note. */
  note: string;
  /** The whole line in its place. */
  published: string;
}

/** The run note of a CLI page: each command runs from a clone. */
const RUN_NOTE =
  "The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how.";

/**
 * Each note line of the pages of UNPUBLISHED_PAGES, read from the tree on
 * 2026-10-30. rewrite-unpublished replaces each whole line with its published
 * line, and it fails on a page line with a note form that this list lacks. A
 * line of a list keeps its list mark.
 */
export const PAGE_NOTES: readonly PageNote[] = [
  { note: RUN_NOTE, published: REGISTRY_INSTALL },
  {
    note: `${RUN_NOTE} The pnpm filter form runs in \`examples/worker\` and exits 1 on any failure, so use it for \`--help\` only.`,
    published: REGISTRY_INSTALL,
  },
  {
    note: `${RUN_NOTE} Else the shell answers "command not found" at step 1.`,
    published: REGISTRY_INSTALL,
  },
  {
    note: "- A clone of the authtempo repo. The `@authtempo` packages are not on a registry yet, so your app lives in the pnpm workspace of the repo. [Choose your stack](/docs/start/) tells why.",
    published: `- ${REGISTRY_INSTALL}`,
  },
  {
    note: "- A clone of the authtempo repo. The `@authtempo` packages are not on a registry yet, so the command runs only from the repo. [Choose your stack](/docs/start/) tells why.",
    published: `- ${REGISTRY_INSTALL}`,
  },
  {
    note: "- Until the packages are on a registry, a new app installs only inside the pnpm workspace of the repo.",
    published: "- A new app names each `@authtempo` package at the version of the CLI.",
  },
  {
    note: "The `@authtempo` packages are private and at version `0.0.0`. They are not on a registry yet, and the owner decides when they publish. Until then, put your app in the pnpm workspace of the repo, in a folder under `examples/`. The `workspace:*` versions then link the packages, and Turbo builds them before your tests.",
    published: REGISTRY_INSTALL,
  },
];

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
  /** One sentence, the sentences of one paragraph that goes as a whole, or one code sample. */
  sentence: string;
  /**
   * The text that rewrite-unpublished writes in its place at the first
   * release, with VERSION_SLOT for the version. "" removes the paragraph, and
   * a heading that the removal leaves with no text. null: the owner writes it
   * in the step of docs/release/RUNBOOK.md that the comment of the entry names.
   */
  published: string | null;
}

/** The dependencies of the alias sample of the Better Auth migration page, at 0.0.0. */
const PAGE_ALIASES = `    "better-auth": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/drizzle-adapter": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/expo": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/passkey": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/api-key": "npm:@authtempo/compat-better-auth@0.0.0",
    "@authtempo/core": "0.0.0",
    "@authtempo/client": "0.0.0",
    "@authtempo/handoff": "0.0.0",
    "@authtempo/adapter-d1": "0.0.0",
    "@authtempo/adapter-postgres": "0.0.0"`;

/** The dependencies of the alias sample of the compat README, at 0.0.0. */
const README_ALIASES = `    "better-auth": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/drizzle-adapter": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/expo": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/passkey": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/api-key": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/sso": "npm:@authtempo/compat-better-auth@0.0.0",
    "@better-auth/scim": "npm:@authtempo/compat-better-auth@0.0.0",
    "@authtempo/core": "0.0.0",
    "@authtempo/client": "0.0.0",
    "@authtempo/handoff": "0.0.0",
    "@authtempo/adapter-d1": "0.0.0",
    "@authtempo/adapter-postgres": "0.0.0"`;

/** A code sample at the new version: each 0.0.0 becomes VERSION_SLOT. */
const atVersion = (sample: string) => sample.replaceAll("0.0.0", VERSION_SLOT);

/** The install line of the section Packages of the root README, before the first release. */
const README_INSTALL =
  "After the first release: `pnpm add @authtempo/core @authtempo/adapter-d1`, then `npm audit signatures`.";

/** The owner check of the ID token route on the routes page, with its three steps. */
const ID_TOKEN_OWNER_CHECK = `Owner check before the first release with this route. Core's tests use test keys, not real tokens. Run these checks on a real device:

1. Sign in once with Google One Tap. Give it \`providerNonce\`, and confirm that the token's \`nonce\` claim is that value.
2. Sign in once with the native Apple sheet. Give it \`providerNonce\`, and confirm that the token's \`nonce\` claim is that value.
3. On the Apple token, confirm that \`exp\` minus \`iat\` is 86400 seconds or less. Core refuses a token with a longer life.`;

/**
 * Each text that is true only while no release exists (review M2 and L7 of
 * plan 12j Task 13b). check-pre-release holds each one in its file while core
 * is at 0.0.0, and out of its file above 0.0.0. So the version pull request
 * of the first release removes each one, or the site checks fail. The list
 * was read with `git grep -i` of "no release" and "until the first release"
 * on 2026-10-30. The check also fails on a text that matches
 * PRE_RELEASE_PATTERN in a docs page or a listed file, outside this list.
 * The note of the root README and the code samples that pin 0.0.0 joined it
 * (ruling 52 of plan 12j), so the list holds each pre-release text of a file
 * outside the packed notes and the page notes. docs/release/RUNBOOK.md quotes
 * each entry, and a site test holds the quotes. Ruling 58 of plan 12j added
 * "before the first release" and "after the first release" to
 * PRE_RELEASE_PATTERN, with their two texts: the install line of the root
 * README and the owner check of the routes page (`git grep -i`, 2026-10-30).
 */
export const PRE_RELEASE_SENTENCES: readonly PreReleaseSentence[] = [
  // The support row step writes the support table in its place.
  { file: "SECURITY.md", sentence: NO_RELEASE_YET, published: null },
  { file: "SECURITY.md", sentence: CHANNELS_CLOSED, published: "" },
  {
    file: "apps/site/src/content/docs/docs/reference/security-policy.md",
    sentence: CHANNELS_CLOSED,
    published: "",
  },
  {
    file: "apps/site/src/content/docs/docs/versioning.md",
    sentence: VERSIONS_TODAY,
    published: "",
  },
  {
    file: "apps/site/src/content/docs/docs/versioning.md",
    sentence: NO_RELEASE_YET,
    published: "",
  },
  {
    file: "apps/site/src/content/docs/docs/changelog.mdx",
    sentence:
      "Until the first release, the plan index of the repo is the record of each change: `docs/superpowers/plans/README.md`. Each row names a plan, its spec sections, and the commit that merged it.",
    published: "",
  },
  // The owner adds the rows of the packages, the examples, and the demo in its place.
  {
    file: "apps/site/src/content/docs/docs/resources.md",
    sentence: RESOURCES_EMPTY,
    published: null,
  },
  // The authtempo cells of the rows g10 and g11 of /compare/.
  {
    file: "apps/site/src/data/compare.ts",
    sentence: "No release yet.",
    published: `One version of every package, from ${VERSION_SLOT}.`,
  },
  {
    file: "apps/site/src/data/compare.ts",
    sentence: "No release notes yet.",
    published: "A changelog page and a feed of each release.",
  },
  { file: "README.md", sentence: "The packages are not on a registry yet.", published: "" },
  {
    file: "README.md",
    sentence: README_INSTALL,
    published:
      "Add the packages with `pnpm add @authtempo/core @authtempo/adapter-d1`, then run `npm audit signatures`.",
  },
  {
    file: "apps/site/src/content/docs/docs/migrate/better-auth.mdx",
    sentence: PAGE_ALIASES,
    published: atVersion(PAGE_ALIASES),
  },
  {
    file: "packages/compat-better-auth/README.md",
    sentence: README_ALIASES,
    published: atVersion(README_ALIASES),
  },
  // The owner runs the checks on a real device, then removes the text: the
  // check-pre-release step of "The first release" in docs/release/RUNBOOK.md.
  // A script cannot run them, and a removal by the script drops the gate.
  {
    file: "apps/site/src/content/docs/docs/reference/routes.md",
    sentence: ID_TOKEN_OWNER_CHECK,
    published: null,
  },
];

/** The words of a text that holds only before the first release. */
export const PRE_RELEASE_PATTERN = /no release|(?:until|before|after) the first release/i;

/** A text that holds PRE_RELEASE_PATTERN and stays true at every version. */
export interface PreReleaseExempt {
  file: string;
  /** The whole text, as in its file. */
  text: string;
  /** Why the text stays after the first release. */
  reason: string;
}

/**
 * The texts that hold PRE_RELEASE_PATTERN and stay at every version, each
 * with its reason (ruling 58 of plan 12j, item 5). check-pre-release passes
 * a match inside one of them. It fails an entry whose file lacks the text,
 * an entry with no reason, a text that PRE_RELEASE_SENTENCES also lists, and
 * a text with no match of the pattern. A `git grep -i` of the pattern on
 * 2026-10-30 found no such text, so the list is empty.
 */
export const PRE_RELEASE_EXEMPT: readonly PreReleaseExempt[] = [];
