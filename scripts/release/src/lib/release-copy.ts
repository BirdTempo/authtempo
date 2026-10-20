// The commands of a release copy (plan 12j, ruling 21). The job check of
// release.yml and the dry run both run them, so one list holds both:
// check-workflows reads it for each run line, and the dry run spawns it.

/** The file at the root of each release copy. prepare refuses a folder without it. */
export const RELEASE_COPY_MARKER = ".release-copy";

/** The install of the copy from the store of the first install. */
export const COPY_INSTALL = ["pnpm", "install", "--frozen-lockfile", "--offline"] as const;

/** The release fields from their one source each. */
export const COPY_PREPARE = ["node", "scripts/release/src/prepare.ts"] as const;

/** The build with the cache off. */
export const COPY_BUILD = ["pnpm", "turbo", "run", "build", "--force"] as const;

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
