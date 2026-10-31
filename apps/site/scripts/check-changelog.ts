// check-changelog (plan 12j Task 13, spec 33 item 3). The built changelog
// page against the changelog files of the tree. With no file, the page states
// the empty state. With files, the page has the anchor of each version of
// core, which `authtempo upgrade` links for each crossed minor, and a link to
// the file of each other package. The page always links the feed. Two
// versions with one heading id fail, such as 0.1.10 and 0.11.0 (both 0110):
// the link of `authtempo upgrade` can name only one of them.
import {
  type ChangelogFile,
  CORE_PACKAGE,
  changelogAnchor,
  changelogFileUrl,
  changelogVersions,
} from "../src/data/changelogs.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

export interface ChangelogInput {
  changelogs: readonly ChangelogFile[];
  /** The built HTML of /docs/changelog/, or "" when the build lacks it. */
  page: string;
  repoUrl: string;
  /** CHANGELOG_EMPTY. */
  empty: string;
}

/** The text of HTML with no tags and one space for each run of white space. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
/** The text of a Markdown sentence with no code marks. */
const plain = (md: string) => md.replace(/`/g, "");

export function checkChangelog(input: ChangelogInput): CheckReport {
  const { changelogs, page, repoUrl } = input;
  const r: CheckReport = {
    name: "check-changelog",
    counts: { pages: page === "" ? 0 : 1, changelogs: changelogs.length, versions: 0, links: 0 },
    failures: [],
  };
  const text = textOf(page);
  const empty = plain(input.empty);
  if (!page.includes('href="/feed.xml"')) r.failures.push("the page does not link /feed.xml");
  if (changelogs.length === 0) {
    if (!text.includes(empty))
      r.failures.push(`no changelog exists, so the page must state: ${empty}`);
    r.exempt = ["no changelog exists, so the page states the empty state and no version"];
    return requireCounts(r, ["pages"]);
  }
  if (text.includes(empty))
    r.failures.push(`a changelog exists, so the page must not state: ${empty}`);
  const core = changelogs.find((c) => c.pkg === CORE_PACKAGE);
  if (core === undefined)
    r.failures.push(`no changelog of ${CORE_PACKAGE}, and other packages have one`);
  else {
    const byAnchor = new Map<string, string[]>();
    for (const version of changelogVersions(core.text)) {
      r.counts.versions = (r.counts.versions ?? 0) + 1;
      const anchor = changelogAnchor(version);
      byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), version]);
      if (!page.includes(`id="${anchor}"`))
        r.failures.push(
          `the page has no anchor #${anchor} for the heading ${version} of ${CORE_PACKAGE}`,
        );
    }
    for (const [anchor, versions] of byAnchor)
      if (versions.length > 1)
        r.failures.push(
          `the versions ${versions.join(" and ")} of ${CORE_PACKAGE} give one heading id #${anchor}; the link of authtempo upgrade names only one of them`,
        );
  }
  for (const c of changelogs) {
    if (c.pkg === CORE_PACKAGE) continue;
    const href = changelogFileUrl(repoUrl, c.dir);
    if (page.includes(`href="${href}"`)) r.counts.links = (r.counts.links ?? 0) + 1;
    else r.failures.push(`the page does not link the changelog of ${c.pkg}: ${href}`);
  }
  return requireCounts(r, ["pages", "versions"]);
}
