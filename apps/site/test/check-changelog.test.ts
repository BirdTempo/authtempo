import { changelogLink } from "@authtempo/cli";
import { describe, expect, it } from "vitest";
import { type ChangelogInput, checkChangelog } from "../scripts/check-changelog.ts";
import { SITE } from "../scripts/lib/paths.ts";
import { summaryLine } from "../scripts/lib/report.ts";
import { changelogAnchor, changelogMarkdown, readChangelogFiles } from "../src/data/changelogs.ts";
import { renderMarkdown } from "../src/data/markdown.ts";
import { CHANGELOG_EMPTY } from "../src/data/unpublished.ts";

/** Two packages: client with 0.2.0 and 0.1.0, core with 0.1.0 (the fixture of the feed). */
const FIXTURE = `${SITE}test/fixtures/site/changelogs`;
const URL = "https://github.com/BirdTempo/authtempo";
const FEED = '<a href="/feed.xml">/feed.xml</a>';
const CLIENT = `<a href="${URL}/blob/main/packages/client/CHANGELOG.md">client</a>`;

const EMPTY = "<p>No release exists. Every package is at version <code>0.0.0</code>.</p>";
const EMPTY_PAGE = `<h2 id="releases">Releases</h2>${EMPTY}${FEED}`;
const BASE: ChangelogInput = {
  changelogs: [],
  page: EMPTY_PAGE,
  repoUrl: URL,
  empty: CHANGELOG_EMPTY,
};
const RELEASED: ChangelogInput = {
  ...BASE,
  changelogs: readChangelogFiles(FIXTURE),
  page: `<h3 id="010">0.1.0</h3>${CLIENT}${FEED}`,
};

describe("check-changelog", () => {
  it("passes the empty state with no changelog", () => {
    expect(summaryLine(checkChangelog(BASE))).toBe(
      "check-changelog: PASS pages=1 changelogs=0 versions=0 links=0 failures=0",
    );
  });

  it("fails the empty state when the page lacks the sentence", () => {
    expect(checkChangelog({ ...BASE, page: FEED }).failures).toEqual([
      "no changelog exists, so the page must state: No release exists. Every package is at version 0.0.0.",
    ]);
  });

  it("passes a page with each anchor of core and each link", () => {
    expect(summaryLine(checkChangelog(RELEASED))).toBe(
      "check-changelog: PASS pages=1 changelogs=2 versions=1 links=1 failures=0",
    );
  });

  it("fails a version heading with no anchor on the page", () => {
    expect(
      checkChangelog({ ...RELEASED, page: `<h3>0.1.0</h3>${CLIENT}${FEED}` }).failures,
    ).toEqual(["the page has no anchor #010 for the heading 0.1.0 of @authtempo/core"]);
  });

  it("fails when the page lacks a link to a package's file", () => {
    expect(
      checkChangelog({ ...RELEASED, page: `<h3 id="010">0.1.0</h3>${FEED}` }).failures,
    ).toEqual([
      `the page does not link the changelog of @authtempo/client: ${URL}/blob/main/packages/client/CHANGELOG.md`,
    ]);
  });

  it("fails a page that keeps the empty state or drops the feed link once a changelog exists", () => {
    expect(
      checkChangelog({ ...RELEASED, page: `${EMPTY}<h3 id="010">0.1.0</h3>${CLIENT}` }).failures,
    ).toEqual([
      "the page does not link /feed.xml",
      "a changelog exists, so the page must not state: No release exists. Every package is at version 0.0.0.",
    ]);
  });

  it("fails a build with no page", () => {
    expect(checkChangelog({ ...BASE, page: "" }).failures).toContain("read 0 pages");
  });
});

describe("the anchor of a version", () => {
  it("is the id that the Markdown processor gives the heading", async () => {
    for (const version of ["0.1.0", "0.10.0", "1.2.3"])
      expect(await renderMarkdown(`## ${version}`)).toContain(`id="${changelogAnchor(version)}"`);
  });

  it("is the anchor of the link that authtempo upgrade prints for a crossed minor", () => {
    for (const minor of ["0.2", "0.10", "1.0"])
      expect(changelogLink(minor)).toBe(
        `https://authtempo.com/docs/changelog/#${changelogAnchor(`${minor}.0`)}`,
      );
  });
});

describe("the text of the Releases part", () => {
  it("is the empty state with no changelog", () => {
    expect(changelogMarkdown([], () => URL, CHANGELOG_EMPTY)).toBe(CHANGELOG_EMPTY);
  });

  it("renders core one level lower with its anchor, and links each other package", async () => {
    const text = changelogMarkdown(readChangelogFiles(FIXTURE), () => URL, CHANGELOG_EMPTY);
    expect(text).not.toContain("# @authtempo/core");
    expect(text).toContain("### 0.1.0");
    expect(text).toContain(
      `- [\`@authtempo/client\`](${URL}/blob/main/packages/client/CHANGELOG.md)`,
    );
    const html = await renderMarkdown(text);
    expect(checkChangelog({ ...RELEASED, page: `${html}${FEED}` }).failures).toEqual([]);
  });
});
