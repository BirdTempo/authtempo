// The root inputs of the release (ruling 67 of plan 12j, Minor 1): each file
// outside a released folder that prepare or the build of a released package
// reads, with the released names whose tarballs it changes. check-changesets
// counts a change of one as a change of each of those names, so it needs a
// changeset that names them. test/root-inputs.test.ts holds the list to the
// build scripts, to prepare, to the stacks of the CLI, and to
// release/migration-sources.json.

/** One root input. */
export interface RootInput {
  /** A file, or a folder that ends in "/", from the repository root. */
  path: string;
  /** The released names whose tarballs change with it, or "all" for the fixed group. */
  names: "all" | readonly string[];
  /** For a JSON file: the keys that count. A change of another key changes no tarball. */
  keys?: readonly string[];
  /** What reads it. */
  reason: string;
}

export const ROOT_INPUTS: readonly RootInput[] = [
  {
    path: "tsconfig.base.json",
    names: "all",
    reason: "the tsconfig.json of each released package extends it, and the CLI templates copy it",
  },
  {
    path: "scripts/clean-dist.mjs",
    names: "all",
    reason: "the build of each released package runs it first",
  },
  {
    path: "scripts/write-version.mjs",
    names: ["@authtempo/core", "@authtempo/mcp"],
    reason: "the build of core and mcp writes the version module with it",
  },
  { path: "LICENSE", names: "all", reason: "prepare copies it into each released package" },
  {
    path: "package.json",
    names: "all",
    keys: ["license"],
    reason: "prepare writes the license of each released package from it",
  },
  {
    path: "release/repository.json",
    names: "all",
    reason: "prepare writes the repository field of each released package from it",
  },
  {
    path: "release/deprecations.json",
    names: ["@authtempo/core"],
    reason: "prepare writes authtempo.deprecations of core from it",
  },
  {
    path: ".changeset/config.json",
    names: "all",
    // Each new unreleased package adds its name to ignore (check-packages).
    // With each key counted, that edit needed a changeset of every released
    // package, which writes a false entry in each changelog (ruling 77 of
    // plan 12j). Only fixed changes a tarball.
    keys: ["fixed"],
    reason: "its fixed group is the released list of prepare, the build, and the pack",
  },
  {
    path: "packages/adapter-d1/migrations/",
    names: ["@authtempo/adapter-sqlite"],
    reason: "the build of adapter-sqlite copies each D1 file (release/migration-sources.json)",
  },
  {
    path: "examples/worker-d1/",
    names: ["@authtempo/cli"],
    reason: "the build of the CLI renders its init templates from the example of each stack",
  },
  {
    path: "examples/worker-postgres/",
    names: ["@authtempo/cli"],
    reason: "the build of the CLI renders its init templates from the example of each stack",
  },
  {
    path: "examples/node/",
    names: ["@authtempo/cli"],
    reason: "the build of the CLI renders its init templates from the example of each stack",
  },
  {
    path: "examples/mcp-server/",
    names: ["@authtempo/cli"],
    reason: "the build of the CLI renders its init templates from the example of each stack",
  },
];

/** The root input that holds `path`, or undefined. */
export function rootInputOf(
  path: string,
  inputs: readonly RootInput[] = ROOT_INPUTS,
): RootInput | undefined {
  return inputs.find((i) => (i.path.endsWith("/") ? path.startsWith(i.path) : path === i.path));
}
