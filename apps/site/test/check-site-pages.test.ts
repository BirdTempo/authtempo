import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSitePages } from "../scripts/check-site-pages.ts";
import { checkTerms } from "../scripts/check-terms.ts";
import { walk } from "../scripts/lib/files.ts";
import { docsPages, rootPages, sitePages } from "../scripts/lib/load.ts";
import { SITE } from "../scripts/lib/paths.ts";

const FIXTURES = `${SITE}test/fixtures/site/pages/`;

/** The entries of a fixture tree, read as the real collection is read. */
const entries = (tree: string) => sitePages(`${FIXTURES}${tree}/site/`);

/** The root pages of a fixture tree, read as the real build is read. */
function built(tree: string): Map<string, string> {
  const dist = `${FIXTURES}${tree}/dist/`;
  return rootPages(
    new Map(
      walk(dist, (p) => p.endsWith(".html")).map((p) => [
        p.slice(dist.length),
        readFileSync(p, "utf8"),
      ]),
    ),
  );
}

/** The valid tree with one built page changed. */
function withPage(file: string, change: (html: string) => string): Map<string, string> {
  const pages = built("valid");
  pages.set(file, change(pages.get(file) ?? ""));
  return pages;
}

/** The valid tree's one entry with one frontmatter line changed. */
function withEntry(from: string, to: string) {
  return entries("valid").map((e) => ({ ...e, source: e.source.replace(from, to) }));
}

const HOME_EXEMPT =
  "/ (index.html): the home keeps the page of plan 11b1, built from HOME (ruling 5 of the plan 11b lane); homeProsePage() holds its prose";

describe("the site loaders", () => {
  it("reads each entry by the path site/<file>", () => {
    expect(entries("valid").map((e) => e.path)).toEqual(["site/features.md"]);
  });

  it("reads no entry when the collection folder does not exist", () => {
    expect(sitePages(`${FIXTURES}unlisted/site/`)).toEqual([]);
  });

  it("reads the root pages and not the docs, the search files, or the 404 page", () => {
    expect([...built("valid").keys()].sort()).toEqual(["features/index.html", "index.html"]);
  });
});

describe("checkSitePages", () => {
  it("passes a root page with its layout and its entry", () => {
    const r = checkSitePages(entries("valid"), built("valid"), 1);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 2, entries: 1 });
    expect(r.exempt).toEqual([HOME_EXEMPT]);
  });

  it("fails a root page with no description", () => {
    const r = checkSitePages(
      entries("valid"),
      withPage("features/index.html", (h) => h.replace(/ *<meta name="description"[^>]*>\n/, "")),
      1,
    );
    expect(r.failures).toEqual(["features/index.html has no description meta with a content"]);
  });

  it("fails a root page with an empty description", () => {
    const r = checkSitePages(
      entries("valid"),
      withPage("index.html", (h) =>
        h.replace('content="Authentication that your app owns."', 'content=""'),
      ),
      1,
    );
    expect(r.failures).toEqual(["index.html has no description meta with a content"]);
  });

  it("fails a root page with no title, no viewport meta, or no layout", () => {
    const r = checkSitePages(
      entries("valid"),
      withPage("index.html", (h) =>
        h
          .replace(/ *<title>[^<]*<\/title>\n/, "")
          .replace(/ *<meta name="viewport"[^>]*>\n/, "")
          .replace('class="site-header astro-fixture"', 'class="header"'),
      ),
      1,
    );
    expect(r.failures).toEqual([
      "index.html has no <title>",
      "index.html has no viewport meta",
      "index.html lacks the class site-header of the root layout",
    ]);
  });

  it("fails a root page with data-pagefind-body", () => {
    const r = checkSitePages(
      entries("valid"),
      withPage("index.html", (h) =>
        h.replace('<main id="main">', '<main id="main" data-pagefind-body>'),
      ),
      1,
    );
    expect(r.failures).toEqual(["index.html holds data-pagefind-body"]);
  });

  it("fails an entry whose page does not exist", () => {
    const r = checkSitePages(withEntry("page: /features/", "page: /home/"), built("valid"), 1);
    expect(r.failures).toEqual([
      "site/features.md names /home/, which is not a root page",
      "/features/ (features/index.html) has no entry in src/content/site/",
    ]);
  });

  it("fails an entry with no page", () => {
    const r = checkSitePages(withEntry("page: /features/\n", ""), built("valid"), 1);
    expect(r.failures).toEqual([
      "site/features.md names no page",
      "/features/ (features/index.html) has no entry in src/content/site/",
    ]);
  });

  it("fails an entry whose title is not the page's h1", () => {
    const r = checkSitePages(
      withEntry("title: Features", "title: All features"),
      built("valid"),
      1,
    );
    expect(r.failures).toEqual([
      'site/features.md: the h1 of /features/ is "Features", not the entry title "All features"',
    ]);
  });

  it("fails a page with no h1 for its entry", () => {
    const r = checkSitePages(
      entries("valid"),
      withPage("features/index.html", (h) => h.replace(/<h1[^>]*>Features<\/h1>/, "")),
      1,
    );
    expect(r.failures).toEqual([
      'site/features.md: /features/ has no h1; the entry title is "Features"',
    ]);
  });

  it("fails two entries that name one page", () => {
    const [entry] = entries("valid");
    if (entry === undefined) throw new Error("the valid tree has no entry");
    const r = checkSitePages([entry, { ...entry, path: "site/copy.md" }], built("valid"), 1);
    expect(r.failures).toEqual([
      "site/copy.md names /features/, which site/features.md also names",
    ]);
  });

  it("fails a root page with no entry, and exempts the home", () => {
    const r = checkSitePages([], built("unlisted"), 0);
    expect(r.failures).toEqual([
      "/pricing/ (pricing/index.html) has no entry in src/content/site/",
    ]);
    expect(r.counts).toEqual({ pages: 2, entries: 0 });
    expect(r.exempt).toEqual([HOME_EXEMPT]);
  });

  it("passes 0 entries when the minimum is 0", () => {
    const r = checkSitePages(
      [],
      new Map([...built("valid")].filter(([p]) => p === "index.html")),
      0,
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, entries: 0 });
  });

  it("fails fewer entries than the minimum", () => {
    const r = checkSitePages(entries("valid"), built("valid"), 2);
    expect(r.failures).toEqual(["entries=1 is below MINIMUM_ENTRIES=2; an entry is lost"]);
  });

  it("fails on zero root pages", () => {
    const r = checkSitePages([], new Map(), 0);
    expect(r.failures).toEqual(["read 0 pages"]);
  });

  it("reads the site collection in the term check", () => {
    const glossary = docsPages().filter((p) => p.path === "docs/reference/glossary.md");
    const r = checkTerms([...glossary, ...entries("terms")]);
    expect(r.failures).toEqual(['site/terms.md:7: "Log in" is forbidden; write "sign in"']);
  });
});
