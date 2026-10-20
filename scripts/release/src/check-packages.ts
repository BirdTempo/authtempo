import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readChangesetConfig } from "./lib/released.ts";
import { type Report, requireCounts, summaryLine } from "./lib/report.ts";
import { readWorkspace, type WorkspacePackage } from "./lib/workspace.ts";

export interface PackagesInput {
  packages: WorkspacePackage[];
  /** `fixed[0]` of .changeset/config.json: the released packages. */
  fixed: string[];
  /** `ignore` of .changeset/config.json. */
  ignore: string[];
  /** release/unreleased.json: each package outside the group, with its reason. */
  unreleased: Record<string, unknown>;
}

/** The dependency keys whose `@authtempo` references must be `workspace:*`. */
const DEPENDENCY_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Each workspace package is in exactly one list: the fixed group or the
 * unreleased list (spec 33 item 2). `ignore` holds the unreleased list again,
 * because Changesets reads only its own config.
 */
export function checkPackages(input: PackagesInput): Report {
  const failures: string[] = [];
  const fixed = new Set(input.fixed);
  const ignore = new Set(input.ignore);
  const unreleased = new Set(Object.keys(input.unreleased));
  const names = new Set(input.packages.map((p) => p.name));

  for (const name of [...names].sort()) {
    const inFixed = fixed.has(name);
    const inUnreleased = unreleased.has(name);
    if (!inFixed && !inUnreleased) failures.push(`${name} is in neither list`);
    if (inFixed && inUnreleased)
      failures.push(`${name} is in the fixed group and in release/unreleased.json`);
    if (inFixed && ignore.has(name)) failures.push(`${name} is in the fixed group and in ignore`);
  }

  for (const name of [...ignore].sort())
    if (!unreleased.has(name))
      failures.push(`${name} is in ignore and not in release/unreleased.json`);
  for (const name of [...unreleased].sort()) {
    if (!ignore.has(name)) failures.push(`${name} is in release/unreleased.json and not in ignore`);
    const reason = input.unreleased[name];
    if (typeof reason !== "string" || reason.trim() === "")
      failures.push(`${name} has no reason in release/unreleased.json`);
  }

  // A name stays in a list after a rename or a removal. Changesets also refuses an
  // unknown name in `fixed`, but no supplier is the only guard of the split.
  for (const [list, set] of [
    ["the fixed group", fixed],
    ["ignore", ignore],
    ["release/unreleased.json", unreleased],
  ] as const)
    for (const name of [...set].sort())
      if (!names.has(name)) failures.push(`${name} is in ${list} and is not a workspace package`);

  const released = input.packages.filter((p) => fixed.has(p.name));
  // `private: true` is the hold: only `prepare` removes it, in a release copy.
  for (const p of released)
    if (p.manifest.private !== true)
      failures.push(`${p.name} is released and not private: true on main`);

  const versions = new Set(released.map((p) => p.manifest.version));
  if (versions.size > 1)
    failures.push(
      `the fixed group holds ${versions.size} versions: ${released
        .map((p) => `${p.name}@${p.manifest.version}`)
        .sort()
        .join(", ")}`,
    );

  // The pack writes the exact version only for `workspace:*` (spec 33 item 1.4).
  for (const p of input.packages)
    for (const key of DEPENDENCY_KEYS)
      for (const [dep, range] of Object.entries(p.manifest[key] ?? {}))
        if (dep.startsWith("@authtempo/") && range !== "workspace:*")
          failures.push(`${p.name} references ${dep} as ${range}, not workspace:*`);

  return requireCounts(
    {
      name: "check-packages",
      counts: {
        packages: input.packages.length,
        released: released.length,
        unreleased: input.packages.filter((p) => unreleased.has(p.name)).length,
      },
      failures,
      notes: [],
    },
    ["packages", "released"],
  );
}

/** Reads the input of `checkPackages` from the workspace at `root`. */
export function readInput(root: string): PackagesInput {
  const config = readChangesetConfig(root);
  return {
    packages: readWorkspace(root),
    fixed: config.fixed[0] ?? [],
    ignore: config.ignore,
    unreleased: JSON.parse(readFileSync(join(root, "release/unreleased.json"), "utf8")) as Record<
      string,
      unknown
    >,
  };
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const report = checkPackages(readInput(root));
  console.log(summaryLine(report));
  for (const failure of report.failures) console.log(`  ${failure}`);
  for (const note of report.notes) console.log(`  note: ${note}`);
  if (report.failures.length > 0) process.exit(1);
}
