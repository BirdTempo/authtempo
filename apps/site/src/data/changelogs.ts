import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The changelogs of the docs changelog page (plan 12j Task 13, spec 33 item 3).
 * ChangelogList.astro renders them, and check-changelog reads the same files
 * through this one function. `changeset version` writes each file on the
 * release branch, so the tree at 0.0.0 holds none.
 */

/** The package whose changelog the page renders in full. Each other package gets a link. */
export const CORE_PACKAGE = "@authtempo/core";

/** One CHANGELOG.md of a package folder. */
export interface ChangelogFile {
  /** The name of the package.json beside it. */
  pkg: string;
  /** The folder from the repository root, such as packages/core. */
  dir: string;
  text: string;
}

/**
 * Each packages/<folder>/CHANGELOG.md, sorted by folder. A changelog with no
 * package.json beside it throws, so the build fails closed (the rule of
 * readChangelogs of the feed).
 */
export function readChangelogFiles(root: string): ChangelogFile[] {
  const packages = join(root, "packages");
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packages, e.name, "CHANGELOG.md")))
    .map((e) => e.name)
    .sort()
    .map((folder) => {
      const dir = `packages/${folder}`;
      const manifest = join(root, dir, "package.json");
      if (!existsSync(manifest))
        throw new Error(`${dir}/CHANGELOG.md has no package.json beside it`);
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name: string };
      return { pkg: name, dir, text: readFileSync(join(root, dir, "CHANGELOG.md"), "utf8") };
    });
}

/** A version heading of the Changesets form, such as `## 0.2.0`. */
const HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/gm;

/** Each version of the `## <version>` headings of a changelog, in file order. */
export function changelogVersions(text: string): string[] {
  return [...text.matchAll(HEADING)].map((m) => m[1] ?? "");
}

/**
 * The id that the Markdown processor gives the heading `## <version>`. It is
 * the github-slugger form, which drops each dot: `0.1.0` gives `010`. A site
 * test holds this form to the real processor of renderMarkdown, and to the
 * link that `authtempo upgrade` prints for each crossed minor.
 *
 * The limit: two versions can give one id. 0.1.10 and 0.11.0 both give `0110`,
 * and the processor gives the lower heading `0110-1`. check-changelog fails
 * on two versions with one id, so such a release fails before it ships.
 */
export function changelogAnchor(version: string): string {
  return version.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/** The link to a changelog file of the repository. */
export const changelogFileUrl = (repoUrl: string, dir: string): string =>
  `${repoUrl}/blob/main/${dir}/CHANGELOG.md`;

/**
 * The Markdown of the part "Releases" of the changelog page. ChangelogList.astro
 * renders it, and the agent markdown of the page holds it, so a person and an
 * agent read the same text. With no changelog, it is the empty state. Else it
 * is the changelog of core with no title line and each heading one level
 * lower, so each `## <version>` keeps its id, and a link to the file of each
 * other package. Every released package has the same version, so the versions
 * of core are the versions of the group.
 */
export function changelogMarkdown(
  files: readonly ChangelogFile[],
  repoUrl: () => string,
  empty: string,
): string {
  if (files.length === 0) return empty;
  const parts: string[] = [];
  const core = files.find((f) => f.pkg === CORE_PACKAGE);
  if (core !== undefined) {
    const body = core.text
      .split("\n")
      .filter((line) => !/^# /.test(line))
      .map((line) => (/^#{2,5} /.test(line) ? `#${line}` : line))
      .join("\n")
      .trim();
    parts.push(`The changelog of \`${CORE_PACKAGE}\`:`, body);
  }
  const others = files.filter((f) => f.pkg !== CORE_PACKAGE);
  if (others.length > 0) {
    const url = repoUrl();
    parts.push(
      "The changelog of each other package:",
      others.map((f) => `- [\`${f.pkg}\`](${changelogFileUrl(url, f.dir)})`).join("\n"),
    );
  }
  return parts.join("\n\n");
}
