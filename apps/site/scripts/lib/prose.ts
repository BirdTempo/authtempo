import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readRepoText } from "../../src/data/repo.ts";
import { cliHelpPages } from "./cli-help.ts";
import { compareProsePage } from "./compare-prose.ts";
import { demoProsePage } from "./demo-prose.ts";
import { featuresProsePage } from "./features-prose.ts";
import { homeProsePage } from "./home-prose.ts";
import { docsPages, sitePages } from "./load.ts";
import type { Page } from "./markdown.ts";
import { SITE_CONTENT } from "./paths.ts";
import { policyProsePages, rootProsePage } from "./root-prose.ts";

/**
 * Every page of prose that check-terms and check-sentences read. It holds the
 * docs and the entries of the collection `site` (spec 24 item 7). It holds the
 * home prose of plan 11b1 and the CLI help of plan 11c. From plan 11b, it holds
 * the package rows of /features/, the data of /pricing/ and /security/, and
 * the rows of /compare/. It also holds the data of /demo/, and SECURITY.md
 * when it exists. Both rows of check.ts call this one list. A test passes `policy` to read a
 * fixture in place of the root file.
 */
export function prosePages(
  siteDir: string = SITE_CONTENT,
  policy: string | null = readRepoText("SECURITY.md"),
): Page[] {
  return [
    ...docsPages(),
    ...sitePages(siteDir),
    homeProsePage(),
    featuresProsePage(),
    rootProsePage(),
    compareProsePage(),
    demoProsePage(),
    ...policyProsePages(policy),
    ...recordProsePages(),
    ...guideProsePages(),
    ...cliHelpPages(),
  ];
}

/**
 * The guides of the repository for a person who works on it (ruling 64 of
 * plan 12j, Low 6). Each one is Simplified Technical English, so the prose
 * checks read it too. docs/security/advisories.md is a record with long old
 * sentences that no edit may change, so it stays out.
 */
export const GUIDE_PATHS = ["CONTRIBUTING.md", "scripts/release/README.md"] as const;

/** The guides of GUIDE_PATHS as plain pages. A missing guide throws, so the checks never pass on a file they did not read. */
export function guideProsePages(root: string = REPO_ROOT): Page[] {
  return GUIDE_PATHS.map((path) => ({
    path,
    source: readFileSync(join(root, path), "utf8"),
    plain: true,
  }));
}

/** The runbook of the owner (plan 12j Task 13). */
export const RUNBOOK_PATH = "docs/release/RUNBOOK.md";

/**
 * The record files of the release as plain pages (plan 12j Task 13): each
 * changeset and the README of .changeset/, each packages/<folder>/CHANGELOG.md,
 * and the runbook. Each one is Simplified Technical English (spec 33 items 3
 * and 4.3), so check-terms and check-sentences read it. A frontmatter block
 * becomes blank lines, so each line number of a failure stays real.
 */
export function recordProsePages(root: string = REPO_ROOT): Page[] {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const files = (dir: string, keep: (name: string) => boolean) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir))
          .filter(keep)
          .sort()
          .map((name) => `${dir}/${name}`)
      : [];
  const changesets = files(".changeset", (n) => n.endsWith(".md"));
  const changelogs = files("packages", (n) =>
    existsSync(join(root, "packages", n, "CHANGELOG.md")),
  ).map((dir) => `${dir}/CHANGELOG.md`);
  const runbook = existsSync(join(root, RUNBOOK_PATH)) ? [RUNBOOK_PATH] : [];
  return [...changesets, ...changelogs, ...runbook].map((path) => ({
    path,
    source: blankFrontmatter(read(path)),
    plain: true,
  }));
}

/** The text with each line of a leading `---` block made blank. */
function blankFrontmatter(text: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") return text;
  const end = lines.indexOf("---", 1);
  if (end === -1) return text;
  return lines.map((line, i) => (i <= end ? "" : line)).join("\n");
}
