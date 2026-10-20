// The commands of a release copy (plan 12j, ruling 21). The job check of
// release.yml and the dry run both run them, so one list holds both.
// check-workflows reads it for each run line. The dry run spawns it.

/** The file at the root of each release copy. prepare refuses a folder without it. */
export const RELEASE_COPY_MARKER = ".release-copy";

/** The install of the copy from the store of the first install. */
export const COPY_INSTALL = ["pnpm", "install", "--frozen-lockfile", "--offline"] as const;

/** The release fields from their one source each. */
export const COPY_PREPARE = ["node", "scripts/release/src/prepare.ts"] as const;

/**
 * The build with the cache off, of the released packages and what they need.
 * The site builds its feed from each changelog. Its build fails on a version
 * with no release date (read 2026-10-21 in a copy after changeset version).
 * The site ships in no tarball, so the build skips it.
 */
export const COPY_BUILD = ["pnpm", "turbo", "run", "build", "--force"] as const;

/** The build command for the released names: one filter for each. */
export const buildCommand = (names: readonly string[]): readonly string[] => [
  ...COPY_BUILD,
  ...names.map((name) => `--filter=${name}`),
];

/**
 * The jq path of the released names: fixed[0] of the Changesets config, which
 * releasedNames of src/lib/released.ts also reads. test/release-copy.test.ts
 * runs both on the real config.
 */
const RELEASED_JQ = ".fixed[0][]";

/** The released names as the shell of a workflow reads them, one word for each. */
export const RELEASED_NAMES_SHELL = `$(jq -r '${RELEASED_JQ}' .changeset/config.json)`;

/** One filter for each released name, as the shell of a workflow reads them. */
export const RELEASED_FILTERS_SHELL = `$(jq -r '"--filter=" + ${RELEASED_JQ}' .changeset/config.json)`;

/**
 * The pack of one released package, from the root of the copy, into `out`.
 * It runs no prepack or postpack script, and check-pack refuses one.
 */
export const packCommand = (name: string, out: string): readonly string[] => [
  "pnpm",
  "--filter",
  name,
  "pack",
  "--ignore-scripts",
  "--pack-destination",
  out,
];

/** The pack check. The tarball paths follow. */
export const COPY_CHECK_PACK = ["node", "scripts/release/src/check-pack.ts"] as const;

/** One command as a run line of a workflow. */
export const shellLine = (command: readonly string[]): string => command.join(" ");
