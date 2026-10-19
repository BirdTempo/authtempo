import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFeed } from "../scripts/check-feed.ts";
import {
  atomFeed,
  datedEntries,
  entryKey,
  type FeedEntry,
  feedSources,
  feedUpdated,
  readChangelogs,
  readVersions,
  releaseEntries,
} from "../scripts/lib/feed.ts";
import { SITE } from "../scripts/lib/paths.ts";
import { parseXml } from "../scripts/lib/xml.ts";
import { FEED_START, RELEASE_DATES } from "../src/data/releases.ts";
import { REPO_ROOT } from "../src/data/repo.ts";

/** Two packages: client with two versions, core with one (plan 11b Task 7). */
const FIXTURE = `${SITE}test/fixtures/site/changelogs`;
const changelogs = readChangelogs(FIXTURE);
const DATES: Record<string, string> = {
  "@authtempo/client@0.2.0": "2026-11-20T09:00:00Z",
  "@authtempo/client@0.1.0": "2026-11-02T09:00:00Z",
  "@authtempo/core@0.1.0": "2026-11-02T09:00:00Z",
};
const AT_ZERO = [
  { pkg: "@authtempo/client", version: "0.0.0" },
  { pkg: "@authtempo/core", version: "0.0.0" },
];
const FIXTURE_VERSIONS = [
  { pkg: "@authtempo/client", version: "0.2.0" },
  { pkg: "@authtempo/core", version: "0.1.0" },
];

/** The feed of the fixture, as build-feed.ts writes it. */
function fixtureFeed(): string {
  const { dated } = datedEntries(releaseEntries(changelogs), DATES);
  return atomFeed(dated, feedUpdated(dated, FEED_START));
}
/** The feed with no entry, as build-feed.ts writes it on a tree with no changelog. */
const emptyFeed = atomFeed([], FEED_START);

const check = (feed: string | null) =>
  checkFeed({ start: FEED_START, feed, versions: FIXTURE_VERSIONS, changelogs, dates: DATES });
/** The empty feed with one line replaced: each break of the feed replaces one whole element. */
const emptyWith = (from: string, to: string) => {
  expect(emptyFeed).toContain(from);
  return checkFeed({
    start: FEED_START,
    feed: emptyFeed.replace(from, to),
    versions: AT_ZERO,
    changelogs: [],
    dates: {},
  });
};
/** The fixture feed with one part replaced. */
const fixtureWith = (from: string | RegExp, to: string) => {
  const feed = fixtureFeed();
  expect(feed).toMatch(from);
  return check(feed.replace(from, to));
};

describe("the feed writer (plan 11b Task 7)", () => {
  it("writes one entry per version heading", () => {
    const entries = releaseEntries(changelogs);
    expect(entries.map((e) => `${e.pkg}@${e.version}`)).toEqual([
      "@authtempo/client@0.2.0",
      "@authtempo/client@0.1.0",
      "@authtempo/core@0.1.0",
    ]);
    expect(entries[1]?.body).toBe(
      "### Minor Changes\n\n- e4f5a6b: The first release of the client.",
    );
    const feed = fixtureFeed();
    expect(feed.match(/<entry>/g)?.length).toBe(3);
    expect(feed).toContain("<id>tag:authtempo.com,2026:@authtempo/core@0.1.0</id>");
    expect(feed).toContain("<title>@authtempo/core 0.1.0</title>");
    expect(feed).toContain("<updated>2026-11-02T09:00:00Z</updated>");
    expect(check(feed)).toEqual({
      name: "check-feed",
      counts: { entries: 3, packages: 2 },
      failures: [],
    });
  });

  it("skips a 0.0.0 heading and ends a section at each heading of level 2", () => {
    const text = "# @a/b\n\n## 0.1.0\n\none\n\n## Notes\n\nnot a release\n\n## 0.0.0\n\nzero\n";
    expect(releaseEntries([{ pkg: "@a/b", text }])).toEqual([
      { pkg: "@a/b", version: "0.1.0", body: "one" },
    ]);
  });

  it("escapes the text of an entry", () => {
    const feed = fixtureFeed();
    expect(feed).toContain("Add the refresh call &amp; keep the &lt;session&gt; &quot;warm&quot;.");
    expect(feed).not.toContain("<session>");
    // The parser reads the text back as the changelog wrote it.
    const entry = parseXml(feed).children.find((c) => c.name === "entry");
    const content = entry?.children.find((c) => c.name === "content");
    expect(content?.text).toContain('Add the refresh call & keep the <session> "warm".');
  });

  it("refuses a character that XML 1.0 cannot hold", () => {
    const entry: FeedEntry = { pkg: "a", version: "1.0.0", body: "x\u0001y" };
    expect(() => atomFeed([{ ...entry, updated: "2026-11-02T09:00:00Z" }], FEED_START)).toThrow(
      "U+0001",
    );
  });

  it("writes a valid feed with zero entries", () => {
    expect(emptyFeed).not.toContain("<entry>");
    expect(emptyFeed).toContain(`<updated>${FEED_START}</updated>`);
    expect(emptyFeed).toContain('<link rel="self" href="https://authtempo.com/feed.xml"/>');
    expect(emptyFeed).toContain(
      '<link rel="alternate" href="https://authtempo.com/docs/changelog/"/>',
    );
    expect(emptyFeed).toContain("<author><name>authtempo</name></author>");
    const root = parseXml(emptyFeed);
    expect(root.name).toBe("feed");
    expect(root.attrs.xmlns).toBe("http://www.w3.org/2005/Atom");
    expect(
      checkFeed({
        start: FEED_START,
        feed: emptyFeed,
        versions: AT_ZERO,
        changelogs: [],
        dates: {},
      }).failures,
    ).toEqual([]);
  });

  it("dates the feed by its newest entry, and by FEED_START with no entry", () => {
    const { dated } = datedEntries(releaseEntries(changelogs), DATES);
    expect(feedUpdated(dated, FEED_START)).toBe("2026-11-20T09:00:00Z");
    // The newest entry is not always the first one.
    expect(feedUpdated([...dated].reverse(), FEED_START)).toBe("2026-11-20T09:00:00Z");
    expect(feedUpdated([], FEED_START)).toBe("2026-10-14T00:00:00Z");
  });

  it("names each heading that has no row of RELEASE_DATES", () => {
    const { missing } = datedEntries(releaseEntries(changelogs), {
      "@authtempo/client@0.2.0": "2026-11-20T09:00:00Z",
    });
    expect(missing).toEqual(["@authtempo/client@0.1.0", "@authtempo/core@0.1.0"]);
  });

  it("reads each changelog and version of a tree, and only paths that turbo.json hashes", () => {
    expect(changelogs.map((c) => c.pkg)).toEqual(["@authtempo/client", "@authtempo/core"]);
    expect(readVersions(FIXTURE)).toEqual(FIXTURE_VERSIONS);
    expect(feedSources(FIXTURE)).toEqual([
      "packages/client/CHANGELOG.md",
      "packages/client/package.json",
      "packages/core/CHANGELOG.md",
      "packages/core/package.json",
    ]);
  });

  // Review of Task 7, Low 4: the drift rule of ruling 29 on this tree, not a literal.
  // A release adds a heading and a row, and the test holds without an edit.
  it("reads a changelog only beside its package.json, and fails closed without one", () => {
    const root = mkdtempSync(join(tmpdir(), "feed-"));
    try {
      mkdirSync(join(root, "packages/a"), { recursive: true });
      mkdirSync(join(root, "packages/b"), { recursive: true });
      writeFileSync(join(root, "packages/a/package.json"), '{"name":"@x/a","version":"0.1.0"}');
      writeFileSync(join(root, "packages/a/CHANGELOG.md"), "# @x/a\n\n## 0.1.0\n\none\n");
      writeFileSync(join(root, "packages/a/CHANGELOGxmd"), "not a changelog");
      expect(feedSources(root)).toEqual(["packages/a/CHANGELOG.md", "packages/a/package.json"]);
      expect(readChangelogs(root)).toEqual([{ pkg: "@x/a", text: "# @x/a\n\n## 0.1.0\n\none\n" }]);
      writeFileSync(join(root, "packages/b/CHANGELOG.md"), "# b\n");
      expect(() => readChangelogs(root)).toThrow(
        "packages/b/CHANGELOG.md has no package.json beside it",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds a row of RELEASE_DATES for each heading of this tree, and a heading for each row", () => {
    const keys = releaseEntries(readChangelogs(REPO_ROOT)).map((e) => entryKey(e.pkg, e.version));
    expect(Object.keys(RELEASE_DATES).sort()).toEqual(keys.sort());
  });
});

describe("checkFeed (plan 11b Task 7)", () => {
  it("passes zero entries with every package at 0.0.0, as an exemption", () => {
    expect(
      checkFeed({
        start: FEED_START,
        feed: emptyFeed,
        versions: AT_ZERO,
        changelogs: [],
        dates: {},
      }),
    ).toEqual({
      name: "check-feed",
      counts: { entries: 0, packages: 2 },
      failures: [],
      exempt: ["every package is at 0.0.0; no release exists (spec 18 item 13)"],
    });
  });

  it("fails zero entries with a package above 0.0.0", () => {
    const r = checkFeed({
      start: FEED_START,
      feed: emptyFeed,
      versions: [
        { pkg: "@authtempo/client", version: "0.1.0" },
        { pkg: "@authtempo/core", version: "0.0.0" },
      ],
      changelogs: [],
      dates: {},
    });
    expect(r.failures).toEqual(["@authtempo/client is at 0.1.0 and the feed has 0 entries"]);
    expect(r.exempt).toBeUndefined();
  });

  it("fails a feed with no updated element", () => {
    expect(emptyWith(`<updated>${FEED_START}</updated>`, "").failures).toEqual([
      "the feed has no updated element",
    ]);
  });

  it("fails a feed that is missing", () => {
    expect(check(null).failures).toEqual(["dist/feed.xml is missing"]);
  });

  it("fails an entry count that differs from the version headings", () => {
    const r = fixtureWith(/<entry>(?:(?!<\/entry>)[\s\S])*<\/entry>/, "");
    expect(r.failures).toEqual([
      "the feed has 2 entries; the changelogs have 3 version headings above 0.0.0",
      "the feed has no entry for @authtempo/client@0.2.0",
    ]);
  });

  it("fails a changelog heading with no row of RELEASE_DATES", () => {
    const { "@authtempo/core@0.1.0": _, ...dates } = DATES;
    const r = checkFeed({
      start: FEED_START,
      feed: fixtureFeed(),
      versions: FIXTURE_VERSIONS,
      changelogs,
      dates,
    });
    expect(r.failures).toEqual([
      "@authtempo/core@0.1.0 has a changelog heading and no row of RELEASE_DATES",
    ]);
  });

  it("fails a row of RELEASE_DATES with no changelog heading", () => {
    const r = checkFeed({
      start: FEED_START,
      feed: fixtureFeed(),
      versions: FIXTURE_VERSIONS,
      changelogs,
      dates: { ...DATES, "@authtempo/core@0.3.0": "2026-12-01T09:00:00Z" },
    });
    expect(r.failures).toEqual([
      "@authtempo/core@0.3.0 has a row of RELEASE_DATES and no changelog heading",
    ]);
  });

  it("fails a row of RELEASE_DATES that is not a UTC date-time", () => {
    const r = checkFeed({
      start: FEED_START,
      feed: fixtureFeed(),
      versions: FIXTURE_VERSIONS,
      changelogs,
      dates: { ...DATES, "@authtempo/core@0.1.0": "2026-11-02" },
    });
    expect(r.failures).toContain(
      "the row @authtempo/core@0.1.0 of RELEASE_DATES is 2026-11-02; it must be YYYY-MM-DDTHH:MM:SSZ",
    );
  });

  it.each(["2026-02-30T10:00:00Z", "2026-11-15T24:00:00Z"])(
    "fails a row of RELEASE_DATES at %s, which is no real instant",
    (date) => {
      const r = checkFeed({
        start: FEED_START,
        feed: fixtureFeed(),
        versions: FIXTURE_VERSIONS,
        changelogs,
        dates: { ...DATES, "@authtempo/core@0.1.0": date },
      });
      expect(r.failures).toContain(
        `the row @authtempo/core@0.1.0 of RELEASE_DATES is ${date}; it must be YYYY-MM-DDTHH:MM:SSZ`,
      );
    },
  );

  // Review of Task 7, Low 1: the dates of the feed against RELEASE_DATES.
  it("fails an entry whose updated date differs from its row", () => {
    const r = fixtureWith(
      "<updated>2026-11-02T09:00:00Z</updated>\n    <link",
      "<updated>2026-11-03T09:00:00Z</updated>\n    <link",
    );
    expect(r.failures).toEqual([
      "the entry for @authtempo/client@0.1.0 has the updated date 2026-11-03T09:00:00Z; its row of RELEASE_DATES is 2026-11-02T09:00:00Z",
    ]);
  });

  it("fails a feed whose updated date is not the newest row", () => {
    const r = fixtureWith(
      "  <updated>2026-11-20T09:00:00Z</updated>\n  <link",
      "  <updated>2026-11-02T09:00:00Z</updated>\n  <link",
    );
    expect(r.failures).toEqual([
      "the feed has the updated date 2026-11-02T09:00:00Z; it must be 2026-11-20T09:00:00Z, the newest row of RELEASE_DATES, or FEED_START with no row",
    ]);
  });

  it("passes a feed dated by its newest row when that row is not the first heading", () => {
    const dates = { ...DATES, "@authtempo/core@0.1.0": "2026-12-01T09:00:00Z" };
    const { dated } = datedEntries(releaseEntries(changelogs), dates);
    const feed = atomFeed(dated, feedUpdated(dated, FEED_START));
    expect(feed).toContain("  <updated>2026-12-01T09:00:00Z</updated>\n  <link");
    const r = checkFeed({ start: FEED_START, feed, versions: FIXTURE_VERSIONS, changelogs, dates });
    expect(r.failures).toEqual([]);
  });

  it("fails an empty feed whose updated date is not FEED_START", () => {
    expect(
      emptyWith(`<updated>${FEED_START}</updated>`, "<updated>2026-10-15T00:00:00Z</updated>")
        .failures,
    ).toEqual([
      "the feed has the updated date 2026-10-15T00:00:00Z; it must be 2026-10-14T00:00:00Z, the newest row of RELEASE_DATES, or FEED_START with no row",
    ]);
  });

  it("reads zero packages as a failure", () => {
    const r = checkFeed({
      start: FEED_START,
      feed: emptyFeed,
      versions: [],
      changelogs: [],
      dates: {},
    });
    expect(r.failures).toEqual(["read 0 packages"]);
  });
});

// RFC 4287, read 2026-10-20 at https://www.rfc-editor.org/rfc/rfc4287.txt.
// Each test holds one MUST of the sections that the feed uses.
describe("checkFeed and RFC 4287 (plan 11b Task 7, ruling 29)", () => {
  /** An entry with no single id names no release, so the check also misses the release of entry 1. */
  const lostId = (name: string) =>
    name === "id" ? ["the feed has no entry for @authtempo/client@0.2.0"] : [];

  it("fails a feed that is not well-formed XML", () => {
    const r = emptyWith("</title>", "");
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toMatch(
      /^dist\/feed\.xml is not well-formed XML: <title> closes with <\/feed> at offset \d+$/,
    );
  });

  it("fails a root element that is not feed of the Atom namespace", () => {
    expect(emptyWith(' xmlns="http://www.w3.org/2005/Atom"', "").failures).toEqual([
      "the root element is feed with the namespace (none); it must be feed with the namespace http://www.w3.org/2005/Atom",
    ]);
  });

  it.each(["id", "title", "updated"])("4.1.1: fails a feed with two %s elements", (name) => {
    const one = new RegExp(`<${name}>[^<]*</${name}>`);
    const line = one.exec(emptyFeed)?.[0] ?? "";
    expect(emptyWith(line, `${line}${line}`).failures).toEqual([
      `the feed has 2 ${name} elements; it must have exactly one`,
    ]);
  });

  it.each(["id", "title"])("4.1.1: fails a feed with no %s element", (name) => {
    const line = new RegExp(`<${name}>[^<]*</${name}>`).exec(emptyFeed)?.[0] ?? "";
    expect(emptyWith(line, "").failures).toEqual([`the feed has no ${name} element`]);
  });

  it("4.1.1: fails a feed with no author", () => {
    expect(emptyWith("<author><name>authtempo</name></author>", "").failures).toEqual([
      "the feed has no author element",
    ]);
  });

  it("3.2: fails an author with no name, and an author with two", () => {
    expect(emptyWith("<name>authtempo</name>", "").failures).toEqual([
      "an author of the feed has 0 name elements; it must have exactly one",
    ]);
    expect(
      emptyWith("<name>authtempo</name>", "<name>authtempo</name><name>b</name>").failures,
    ).toEqual(["an author of the feed has 2 name elements; it must have exactly one"]);
  });

  it("4.1.1: fails two alternate links of one type and hreflang on the feed", () => {
    const alt = '<link rel="alternate" href="https://authtempo.com/docs/changelog/"/>';
    expect(emptyWith(alt, `${alt}${alt}`).failures).toEqual([
      "the feed has 2 alternate links of the type (none) and the hreflang (none); it may have one",
    ]);
    expect(
      emptyWith(alt, `${alt}<link rel="alternate" hreflang="de" href="https://a.example/"/>`)
        .failures,
    ).toEqual([]);
  });

  it.each(["id", "title", "updated"])("4.1.2: fails an entry with no %s element", (name) => {
    const r = fixtureWith(new RegExp(`(<entry>[\\s\\S]*?)<${name}>[^<]*</${name}>`), "$1");
    expect(r.failures).toEqual([`the entry 1 has no ${name} element`, ...lostId(name)]);
  });

  it.each(["id", "title", "updated"])("4.1.2: fails an entry with two %s elements", (name) => {
    const r = fixtureWith(new RegExp(`(<entry>[\\s\\S]*?)(<${name}>[^<]*</${name}>)`), "$1$2$2");
    expect(r.failures).toEqual([
      `the entry 1 has 2 ${name} elements; it must have exactly one`,
      ...lostId(name),
    ]);
  });

  it("4.1.2: fails an entry with no content and no alternate link", () => {
    const r = fixtureWith(
      /(<entry>[\s\S]*?)<link rel="alternate"[^>]*\/>([\s\S]*?)<content type="text">[^<]*<\/content>/,
      "$1$2",
    );
    expect(r.failures).toEqual(["the entry 1 has no content and no alternate link"]);
  });

  it("3.3: fails a date that is not an RFC 3339 date-time with T and Z", () => {
    expect(
      emptyWith(`<updated>${FEED_START}</updated>`, "<updated>2026-10-14 00:00:00z</updated>")
        .failures,
    ).toEqual([
      "the updated date of the feed is 2026-10-14 00:00:00z; it is not an RFC 3339 date-time",
    ]);
    expect(
      emptyWith(
        `<updated>${FEED_START}</updated>`,
        "<updated>2026-10-14T00:00:00.5+08:00</updated>",
      ).failures,
    ).toEqual([
      "the feed has the updated date 2026-10-14T00:00:00.5+08:00; it must be 2026-10-14T00:00:00Z, the newest row of RELEASE_DATES, or FEED_START with no row",
    ]);
  });

  // Date.parse takes each of these, and RFC 3339 does not (review of Task 7, Minor 1).
  it.each([
    "2026-02-30T10:00:00Z",
    "2026-11-15T24:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-11-15T10:60:00Z",
    "2026-11-15T10:00:00+24:00",
  ])("3.3: fails the date %s, which is no real calendar instant", (date) => {
    expect(
      emptyWith(`<updated>${FEED_START}</updated>`, `<updated>${date}</updated>`).failures,
    ).toEqual([`the updated date of the feed is ${date}; it is not an RFC 3339 date-time`]);
  });

  it("3.3: passes the last day of February in a leap year, and a leap second", () => {
    expect(
      emptyWith(`<updated>${FEED_START}</updated>`, "<updated>2028-02-29T23:59:60Z</updated>")
        .failures,
    ).toEqual([
      "the feed has the updated date 2028-02-29T23:59:60Z; it must be 2026-10-14T00:00:00Z, the newest row of RELEASE_DATES, or FEED_START with no row",
    ]);
  });

  it("4.2.6: fails an id that is not an absolute IRI, and two entries with one id", () => {
    expect(
      emptyWith("<id>https://authtempo.com/feed.xml</id>", "<id>feed.xml</id>").failures,
    ).toEqual(["the id of the feed is feed.xml; it is not an absolute IRI"]);
    const r = fixtureWith(
      "<id>tag:authtempo.com,2026:@authtempo/client@0.1.0</id>",
      "<id>tag:authtempo.com,2026:@authtempo/client@0.2.0</id>",
    );
    expect(r.failures).toEqual([
      "two entries have the id tag:authtempo.com,2026:@authtempo/client@0.2.0",
      "the feed has no entry for @authtempo/client@0.1.0",
      // The second entry now names the release 0.2.0, and its date is the row of 0.1.0.
      "the entry for @authtempo/client@0.2.0 has the updated date 2026-11-02T09:00:00Z; its row of RELEASE_DATES is 2026-11-20T09:00:00Z",
    ]);
  });

  it("4.2.7: fails a link with no href", () => {
    expect(
      emptyWith('<link rel="self" href="https://authtempo.com/feed.xml"/>', '<link rel="self"/>')
        .failures,
    ).toEqual(["a link of the feed has no href"]);
  });

  it("3.1.1 and 4.1.3: fails a text type that is not text, html, or xhtml, and a child element in text", () => {
    expect(
      emptyWith("<title>authtempo releases</title>", '<title type="text/plain">a</title>').failures,
    ).toEqual(['the title of the feed has the type "text/plain"; it must be text, html, or xhtml']);
    expect(
      emptyWith("<title>authtempo releases</title>", "<title>a<b>c</b></title>").failures,
    ).toEqual(["the title of the feed is text and holds a child element"]);
    const r = fixtureWith(/(<entry>[\s\S]*?<content type="text">)/, "$1<b>x</b>");
    expect(r.failures).toEqual(["the content of the entry 1 is text and holds a child element"]);
  });
});

describe("parseXml (plan 11b Task 7)", () => {
  it("reads elements, attributes, entities, references, comments, and the declaration", () => {
    const root = parseXml(
      '<?xml version="1.0"?>\n<!-- a -->\n<a x="1 &amp; 2" y=\'q\'>t &lt;&#65;&#x42;<b/><!-- c --><c>d</c></a>\n',
    );
    expect(root).toEqual({
      name: "a",
      attrs: { x: "1 & 2", y: "q" },
      text: "t <AB",
      children: [
        { name: "b", attrs: {}, children: [], text: "" },
        { name: "c", attrs: {}, children: [], text: "d" },
      ],
    });
  });

  it.each([
    ["<a>x & y</a>", "a bare & at offset 5"],
    ["<a>&nbsp;</a>", "the reference &nbsp; at offset 3"],
    ["<a>&#0;</a>", "the reference &#0; at offset 3"],
    ["<a><b></a>", "<b> closes with </a> at offset 6"],
    ["<a>x", "<a> at offset 0 does not close"],
    ["<a/><b/>", "text after the root element at offset 4"],
    ['<a x="1" x="2"/>', "the attribute x twice at offset 11"],
    ["<a x=1/>", "the attribute x has no quote at offset 5"],
    ["<a x/>", "the attribute x has no value at offset 4"],
    ['<a x="<"/>', "a < in the attribute x at offset 5"],
    ["<a>]]></a>", "]]> in text at offset 3"],
    ["<a><![CDATA[x]]></a>", "an unsupported construct at offset 3"],
    ["<!DOCTYPE a><a/>", "no root element at offset 0"],
    ["<a>\u0001</a>", "U+0001 at offset 3"],
    ["<!-- x <a/>", "a comment does not close at offset 0"],
  ])("throws on %j", (text, message) => {
    expect(() => parseXml(text)).toThrow(message);
  });
});
