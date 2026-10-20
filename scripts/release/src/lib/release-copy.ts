// The commands of a release copy (plan 12j, ruling 21). The job check of
// release.yml and the dry run both run them, so one list holds both:
// check-workflows reads it for each run line, and the dry run spawns it.

/** The file at the root of each release copy. prepare refuses a folder without it. */
export const RELEASE_COPY_MARKER = ".release-copy";

/** The install of the copy from the store of the first install. */
export const COPY_INSTALL = ["pnpm", "install", "--frozen-lockfile", "--offline"] as const;

/** The release fields from their one source each. */
export const COPY_PREPARE = ["node", "scripts/release/src/prepare.ts"] as const;

/**
 * The build with the cache off, of the released packages and what they need.
 * The site builds its feed from each changelog, and its build fails on a
 * version with no release date (read 2026-10-21 in a copy after changeset
 * version). The site ships in no tarball, so the build skips it.
 */
export const COPY_BUILD = ["pnpm", "turbo", "run", "build", "--force"] as const;

/** The build command for the released names: one filter for each. */
export const buildCommand = (names: readonly string[]): readonly string[] => [
  ...COPY_BUILD,
  ...names.map((name) => `--filter=${name}`),
];

/** The released names as the shell of a workflow reads them: fixed[0] of the Changesets config. */
export const RELEASED_FILTERS_SHELL = `$(jq -r '"--filter=" + .fixed[0][]' .changeset/config.json)`;

/** The pack of one released package, from the root of the copy, into `out`. */
export const packCommand = (name: string, out: string): readonly string[] => [
  "pnpm",
  "--filter",
  name,
  "pack",
  "--pack-destination",
  out,
];

/** The pack check. The tarball paths follow. */
export const COPY_CHECK_PACK = ["node", "scripts/release/src/check-pack.ts"] as const;

/** One command as a run line of a workflow. */
export const shellLine = (command: readonly string[]): string => command.join(" ");
