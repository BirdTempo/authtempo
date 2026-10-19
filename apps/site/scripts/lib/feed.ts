// The Atom feed of the release records (plan 11b Task 7, spec 24 item 6).
// build-feed.ts writes dist/feed.xml with these functions, and check-feed
// reads it again with its own XML reader. RFC 4287, read 2026-10-20 at
// https://www.rfc-editor.org/rfc/rfc4287.txt, gives each element below.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FEED_PATH, FEED_TITLE } from "../../src/data/releases.ts";
import { SITE } from "../../src/data/site.ts";
import { isXmlChar } from "./xml.ts";

/** One version heading of a package's CHANGELOG.md. */
export interface FeedEntry {
  pkg: string;
  version: string;
  /** The text of the section under the heading, trimmed. */
  body: string;
}

/** An entry with its updated date from RELEASE_DATES. */
export interface DatedEntry extends FeedEntry {
  updated: string;
}

export const ATOM_NS = "http://www.w3.org/2005/Atom";
export const FEED_URL = `${SITE.origin}${FEED_PATH}`;
/** The docs changelog stays the page for a person (spec 24 item 6). */
export const CHANGELOG_URL = `${SITE.origin}${SITE.docs}changelog/`;
/** The author of the feed. RFC 4287 4.1.1 needs one when no entry has its own (ruling 29). */
export const FEED_AUTHOR = "authtempo";

/** A version heading of the Changesets form, such as `## 0.2.0` or `## 1.0.0-next.1`. */
const HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/;

/** The key of a release in RELEASE_DATES. */
export const entryKey = (pkg: string, version: string): string => `${pkg}@${version}`;

/** The id of an entry: a tag URI (RFC 4151) that never changes for one release. */
export const entryId = (pkg: string, version: string): string =>
  `tag:authtempo.com,2026:${entryKey(pkg, version)}`;

/**
 * One entry per version heading above 0.0.0, in the order of the changelogs
 * and of the headings in each. The body is the text up to the next heading
 * of level 2.
 */
export function releaseEntries(changelogs: { pkg: string; text: string }[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const { pkg, text } of changelogs) {
    let current: { version: string; lines: string[] } | null = null;
    const flush = () => {
      if (current !== null && current.version !== "0.0.0")
        out.push({ pkg, version: current.version, body: current.lines.join("\n").trim() });
    };
    for (const line of text.split(/\r?\n/)) {
      const m = HEADING.exec(line);
      if (m !== null) {
        flush();
        current = { version: m[1] ?? "", lines: [] };
      } else if (line.startsWith("## ")) {
        flush();
        current = null;
      } else current?.lines.push(line);
    }
    flush();
  }
  return out;
}

/** The entries that have a row of `dates`, and the key of each entry with no row. */
export function datedEntries(
  entries: FeedEntry[],
  dates: Readonly<Record<string, string>>,
): { dated: DatedEntry[]; missing: string[] } {
  const dated: DatedEntry[] = [];
  const missing: string[] = [];
  for (const e of entries) {
    const updated = dates[entryKey(e.pkg, e.version)];
    if (updated === undefined) missing.push(entryKey(e.pkg, e.version));
    else dated.push({ ...e, updated });
  }
  return { dated, missing };
}

/** The updated date of the feed: the newest entry date, or `start` with no entry. */
export function feedUpdated(entries: DatedEntry[], start: string): string {
  let newest: DatedEntry | undefined;
  for (const e of entries)
    if (newest === undefined || Date.parse(e.updated) > Date.parse(newest.updated)) newest = e;
  return newest?.updated ?? start;
}

/**
 * The text escaped for XML: `&`, `<`, `>`, and `"`. It throws on a character
 * that XML 1.0 cannot hold, because no escape can carry it.
 */
export function escapeXml(text: string): string {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!isXmlChar(cp))
      throw new Error(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} cannot go in XML 1.0`);
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The Atom feed of the entries. The text holds no build time and no git commit. */
export function atomFeed(entries: DatedEntry[], updated: string): string {
  const x = escapeXml;
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed xmlns="${ATOM_NS}">`,
    `  <id>${x(FEED_URL)}</id>`,
    `  <title>${x(FEED_TITLE)}</title>`,
    `  <updated>${x(updated)}</updated>`,
    `  <link rel="self" href="${x(FEED_URL)}"/>`,
    `  <link rel="alternate" href="${x(CHANGELOG_URL)}"/>`,
    `  <author><name>${x(FEED_AUTHOR)}</name></author>`,
  ];
  for (const e of entries)
    lines.push(
      "  <entry>",
      `    <id>${x(entryId(e.pkg, e.version))}</id>`,
      `    <title>${x(`${e.pkg} ${e.version}`)}</title>`,
      `    <updated>${x(e.updated)}</updated>`,
      `    <link rel="alternate" href="${x(CHANGELOG_URL)}"/>`,
      `    <content type="text">${x(e.body)}</content>`,
      "  </entry>",
    );
  lines.push("</feed>", "");
  return lines.join("\n");
}

/**
 * The one list of the files outside apps/site that build-feed.ts reads, as
 * globs from the repository root. readChangelogs and readVersions read only
 * the files that these globs name. turbo.json lists each glob as an input of
 * the site build, and turbo-inputs.test.ts holds both to this list.
 */
export const FEED_GLOBS = {
  changelogs: "packages/*/CHANGELOG.md",
  packages: "packages/*/package.json",
} as const;

/**
 * Each file of a tree that a glob names, by its path from the root, sorted.
 * A `*` names any one folder or file name, as a glob of turbo.json does.
 */
export function expandGlob(root: string, glob: string): string[] {
  let paths = [""];
  const parts = glob.split("/");
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    const re = new RegExp(
      `^${part
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*")}$`,
    );
    paths = paths.flatMap((dir) => {
      const abs = join(root, dir);
      if (!existsSync(abs)) return [];
      return readdirSync(abs, { withFileTypes: true })
        .filter((e) => (last ? e.isFile() : e.isDirectory()) && re.test(e.name))
        .map((e) => (dir === "" ? e.name : `${dir}/${e.name}`));
    });
  });
  return paths.sort();
}

/** Each file that build-feed.ts reads, by its path from the root: the files of FEED_GLOBS. */
export function feedSources(root: string): string[] {
  return Object.values(FEED_GLOBS)
    .flatMap((glob) => expandGlob(root, glob))
    .sort();
}

const readJson = (root: string, path: string) =>
  JSON.parse(readFileSync(join(root, path), "utf8")) as { name: string; version: string };

/**
 * Each changelog of FEED_GLOBS, with the name of the package.json beside it.
 * A changelog with no package.json beside it throws, so the build fails closed.
 */
export function readChangelogs(root: string): { pkg: string; text: string }[] {
  const packages = new Set(expandGlob(root, FEED_GLOBS.packages));
  return expandGlob(root, FEED_GLOBS.changelogs).map((path) => {
    const pkgPath = path.replace(/[^/]+$/, "package.json");
    if (!packages.has(pkgPath)) throw new Error(`${path} has no package.json beside it`);
    return { pkg: readJson(root, pkgPath).name, text: readFileSync(join(root, path), "utf8") };
  });
}

/** The name and version of each package.json of FEED_GLOBS. */
export function readVersions(root: string): { pkg: string; version: string }[] {
  return expandGlob(root, FEED_GLOBS.packages).map((path) => {
    const p = readJson(root, path);
    return { pkg: p.name, version: p.version };
  });
}
