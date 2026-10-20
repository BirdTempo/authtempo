import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TAG_PREFIX } from "./lib/release-facts.ts";
import { releasedNames } from "./lib/released.ts";
import { type Report, reportLines, unreadReport } from "./lib/report.ts";
import { readWorkspace } from "./lib/workspace.ts";

/**
 * The rules of the release tag (spec 33 items 1.3 and 5). The tag is
 * `v<major>.<minor>.<patch>` with no prerelease part, because the release has
 * no pre mode. It equals the group version. Its commit is on main, or on
 * release/<major>.<minor> for a patch of an older minor.
 */
export function checkTag(input: {
  tag: string;
  groupVersion: string;
  onMain: boolean;
  onReleaseBranch: boolean;
}): Report {
  const failures: string[] = [];
  const { tag, groupVersion } = input;
  const m = new RegExp(`^${TAG_PREFIX}(\\d+)\\.(\\d+)\\.(\\d+)(-.+)?$`).exec(tag);
  if (m === null) failures.push(`the tag ${tag} is not ${TAG_PREFIX}<major>.<minor>.<patch>`);
  else if (m[4] !== undefined)
    failures.push(`the tag ${tag} has a prerelease part, and the release has no pre mode`);
  else {
    if (tag.slice(TAG_PREFIX.length) !== groupVersion)
      failures.push(`the tag ${tag} differs from the group version ${groupVersion}`);
    const branch = `release/${m[1]}.${m[2]}`;
    if (!input.onMain) {
      if (!input.onReleaseBranch)
        failures.push(`the tagged commit is on neither main nor ${branch}`);
      else if (m[3] === "0") failures.push(`a tag on ${branch} is a patch, and ${tag} is not`);
    }
  }
  return { name: "check-tag", counts: { tags: 1 }, failures, notes: [] };
}

function git(root: string, args: string[]): { code: number } {
  try {
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0 };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return { code: typeof status === "number" ? status : -1 };
  }
}

const hasRef = (root: string, ref: string) =>
  git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0;

/** True when HEAD is `ref` or a commit before it. */
function onRef(root: string, ref: string): boolean {
  const { code } = git(root, ["merge-base", "--is-ancestor", "HEAD", ref]);
  if (code === 0) return true;
  if (code === 1) return false;
  throw new Error(`git merge-base --is-ancestor HEAD ${ref} exited ${code}`);
}

/**
 * Checks `tag` against the checkout at `root`: the version of each released
 * package, and the remote branches that a checkout with fetch-depth 0 writes.
 * A tag checkout has no local main, so the check reads `<remote>/main`.
 */
export function entry(
  root: string,
  tag: string,
  remote = "origin",
): { lines: string[]; code: number } {
  const unread = (reason: string) => {
    const r = unreadReport("check-tag", ["tags"], reason);
    return { lines: reportLines(r), code: 1 };
  };
  const main = `refs/remotes/${remote}/main`;
  if (!hasRef(root, main))
    return unread(`the checkout has no ${main}; fetch the full history (fetch-depth: 0)`);
  const released = new Set(releasedNames(root));
  const versions = [
    ...new Set(
      readWorkspace(root)
        .filter((p) => released.has(p.name))
        .map((p) => p.manifest.version),
    ),
  ].sort();
  const [groupVersion] = versions;
  if (versions.length !== 1 || groupVersion === undefined)
    return unread(`the released packages hold ${versions.length} versions: ${versions.join(", ")}`);
  const minor = /^v?(\d+\.\d+)\./.exec(tag)?.[1];
  const branch = `refs/remotes/${remote}/release/${minor}`;
  const report = checkTag({
    tag,
    groupVersion,
    onMain: onRef(root, main),
    onReleaseBranch: minor !== undefined && hasRef(root, branch) && onRef(root, branch),
  });
  return { lines: reportLines(report), code: report.failures.length > 0 ? 1 : 0 };
}

if (import.meta.main) {
  const { lines, code } = entry(
    fileURLToPath(new URL("../../../", import.meta.url)),
    process.argv[2] ?? "",
  );
  for (const line of lines) console.log(line);
  process.exit(code);
}
