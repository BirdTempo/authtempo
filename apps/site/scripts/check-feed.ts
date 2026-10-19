// check-feed (plan 11b Task 7, spec 24 items 6 and 7, ruling 29 of its lane).
// It reads dist/feed.xml with its own XML reader. It holds the feed to the
// MUST rules of RFC 4287 that the feed uses (read 2026-10-20). It holds the
// entries to the version headings of the changelogs and to RELEASE_DATES.
// It counts the headings with its own pattern, not with the writer's code.
import { entryId, entryKey } from "./lib/feed.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";
import { parseXml, type XmlElement } from "./lib/xml.ts";

const ATOM = "http://www.w3.org/2005/Atom";
/** RFC 3339 date-time; RFC 4287 3.3 also needs an upper-case T and Z. */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** The form of a row of RELEASE_DATES: one form, in UTC, so the newest row is plain to find. */
const ROW_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * True for a date-time of RFC 3339 section 5.6 with a real calendar day.
 * Date.parse takes 2026-02-30 and the hour 24, so this function checks each
 * part. The parts are the month, the day of that month, the hour 00 to 23,
 * the minute, the second, and the offset. The second 60 fails. RFC 3339
 * allows it at a leap second only, and the Atom schema refuses it
 * (Task 7 re-review, Low 1).
 */
export function isDateTime(d: string): boolean {
  const m = DATE_TIME.exec(d);
  if (m === null) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as number[];
  const days = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  return (
    month !== undefined &&
    month >= 1 &&
    month <= 12 &&
    day !== undefined &&
    day >= 1 &&
    day <= days &&
    (hour ?? 99) <= 23 &&
    (minute ?? 99) <= 59 &&
    (second ?? 99) <= 59 &&
    Number(m[7] ?? 0) <= 23 &&
    Number(m[8] ?? 0) <= 59
  );
}

/**
 * True for a row of RELEASE_DATES: the UTC form with no fraction, and a real
 * instant. The round trip through Date fails 2026-02-30 and the hour 24.
 */
export function isRowDate(d: string): boolean {
  if (!ROW_DATE.test(d)) return false;
  const t = new Date(d);
  return !Number.isNaN(t.getTime()) && t.toISOString().replace(".000Z", "Z") === d;
}
/** An absolute IRI: a scheme, a colon, and no space (RFC 3987). */
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;
const TEXT_TYPES = ["text", "html", "xhtml"];

const kids = (el: XmlElement, name: string) => el.children.filter((c) => c.name === name);

export interface FeedInput {
  /** dist/feed.xml, or null when the build did not write it. */
  feed: string | null;
  /** The name and version of each package folder. */
  versions: { pkg: string; version: string }[];
  /** Each CHANGELOG.md of a package, with the package name. */
  changelogs: { pkg: string; text: string }[];
  /** RELEASE_DATES of src/data/releases.ts. */
  dates: Readonly<Record<string, string>>;
  /** FEED_START of src/data/releases.ts: the updated date of a feed with no row. */
  start: string;
}

/** The checks of one feed or entry element. `of` names it in a failure, such as "the feed". */
function checkElement(el: XmlElement, of: string, failures: string[], isEntry: boolean): void {
  const at = `${of} has`;
  for (const name of ["id", "title", "updated"]) {
    const n = kids(el, name).length;
    if (n === 0) failures.push(`${at} no ${name} element`);
    else if (n > 1) failures.push(`${at} ${n} ${name} elements; it must have exactly one`);
  }
  const [id] = kids(el, "id");
  if (kids(el, "id").length === 1 && id !== undefined && !ABSOLUTE_IRI.test(id.text.trim()))
    failures.push(`the id of ${of} is ${id.text}; it is not an absolute IRI`);
  const [updated] = kids(el, "updated");
  if (kids(el, "updated").length === 1 && updated !== undefined) {
    const d = updated.text.trim();
    if (!isDateTime(d))
      failures.push(`the updated date of ${of} is ${d}; it is not an RFC 3339 date-time`);
  }
  for (const title of kids(el, "title")) {
    const type = title.attrs.type ?? "text";
    if (!TEXT_TYPES.includes(type))
      failures.push(`the title of ${of} has the type "${type}"; it must be text, html, or xhtml`);
    else if (type !== "xhtml" && title.children.length > 0)
      failures.push(`the title of ${of} is ${type} and holds a child element`);
  }
  for (const author of kids(el, "author")) {
    const n = kids(author, "name").length;
    if (n !== 1)
      failures.push(`an author of ${of} has ${n} name elements; it must have exactly one`);
  }
  const alternates = new Map<string, number>();
  for (const link of kids(el, "link")) {
    if (link.attrs.href === undefined) failures.push(`a link of ${of} has no href`);
    if ((link.attrs.rel ?? "alternate") !== "alternate") continue;
    const key = `the type ${link.attrs.type ?? "(none)"} and the hreflang ${link.attrs.hreflang ?? "(none)"}`;
    alternates.set(key, (alternates.get(key) ?? 0) + 1);
  }
  for (const [key, n] of alternates)
    if (n > 1) failures.push(`${of} has ${n} alternate links of ${key}; it may have one`);
  if (isEntry) {
    const contents = kids(el, "content");
    if (contents.length === 0 && alternates.size === 0)
      failures.push(`${of} has no content and no alternate link`);
    for (const content of contents) {
      const type = content.attrs.type ?? "text";
      if ((type === "text" || type === "html") && content.children.length > 0)
        failures.push(`the content of ${of} is ${type} and holds a child element`);
    }
  }
}

/** The entry id of a `<pkg>@<version>` key. A package name holds an @ too, so the last @ splits it. */
function entryIdOf(key: string): string {
  const at = key.lastIndexOf("@");
  return entryId(key.slice(0, at), key.slice(at + 1));
}

/** The version headings above 0.0.0 of the changelogs, as `<pkg>@<version>` keys. */
function headingKeys(changelogs: FeedInput["changelogs"]): string[] {
  return changelogs.flatMap(({ pkg, text }) =>
    [...text.matchAll(/^## (\S+)[ \t]*$/gm)]
      .map((m) => m[1] ?? "")
      .filter((v) => v !== "0.0.0")
      .map((v) => entryKey(pkg, v)),
  );
}

export function checkFeed(input: FeedInput): CheckReport {
  const r: CheckReport = {
    name: "check-feed",
    counts: { entries: 0, packages: input.versions.length },
    failures: [],
  };
  const done = () => requireCounts(r, ["packages"]);
  if (input.feed === null) {
    r.failures.push("dist/feed.xml is missing");
    return done();
  }
  let root: XmlElement;
  try {
    root = parseXml(input.feed);
  } catch (e) {
    r.failures.push(
      `dist/feed.xml is not well-formed XML: ${e instanceof Error ? e.message : String(e)}`,
    );
    return done();
  }
  const ns = root.attrs.xmlns;
  if (root.name !== "feed" || ns !== ATOM) {
    r.failures.push(
      `the root element is ${root.name} with the namespace ${ns ?? "(none)"}; it must be feed with the namespace ${ATOM}`,
    );
    return done();
  }

  const entries = kids(root, "entry");
  r.counts.entries = entries.length;
  checkElement(root, "the feed", r.failures, false);
  const everyEntryHasAuthor =
    entries.length > 0 && entries.every((e) => kids(e, "author").length > 0);
  if (kids(root, "author").length === 0 && !everyEntryHasAuthor)
    r.failures.push("the feed has no author element");
  entries.forEach((e, i) => {
    checkElement(e, `the entry ${i + 1}`, r.failures, true);
  });

  // The entries against the changelogs and RELEASE_DATES (ruling 29).
  const headings = headingKeys(input.changelogs);
  if (entries.length !== headings.length)
    r.failures.push(
      `the feed has ${entries.length} entries; the changelogs have ${headings.length} version headings above 0.0.0`,
    );
  const ids = new Set<string>();
  for (const e of entries) {
    const id = kids(e, "id");
    if (id.length !== 1) continue;
    const text = id[0]?.text.trim() ?? "";
    if (ids.has(text)) r.failures.push(`two entries have the id ${text}`);
    ids.add(text);
  }
  for (const key of headings) {
    const [pkg, version] = [
      key.slice(0, key.lastIndexOf("@")),
      key.slice(key.lastIndexOf("@") + 1),
    ];
    if (!ids.has(entryId(pkg, version))) r.failures.push(`the feed has no entry for ${key}`);
  }
  for (const key of headings)
    if (input.dates[key] === undefined)
      r.failures.push(`${key} has a changelog heading and no row of RELEASE_DATES`);
  for (const [key, date] of Object.entries(input.dates)) {
    if (!headings.includes(key))
      r.failures.push(`${key} has a row of RELEASE_DATES and no changelog heading`);
    if (!isRowDate(date))
      r.failures.push(
        `the row ${key} of RELEASE_DATES is ${date}; it must be YYYY-MM-DDTHH:MM:SSZ`,
      );
  }

  // FEED_START has the form of a row, so the feed date of an empty feed is a real instant.
  if (!isRowDate(input.start))
    r.failures.push(`FEED_START is ${input.start}; it must be YYYY-MM-DDTHH:MM:SSZ`);

  // The dates of the feed against RELEASE_DATES (ruling 29, review of Task 7 Low 1).
  // Each entry takes its row. The feed takes the newest row, or FEED_START with no row.
  const keyOfId = new Map(headings.map((key) => [entryIdOf(key), key]));
  for (const e of entries) {
    const [id, updated] = [kids(e, "id"), kids(e, "updated")];
    if (id.length !== 1 || updated.length !== 1) continue;
    const key = keyOfId.get(id[0]?.text.trim() ?? "");
    const row = key === undefined ? undefined : input.dates[key];
    const date = updated[0]?.text.trim() ?? "";
    if (row !== undefined && date !== row)
      r.failures.push(
        `the entry for ${key} has the updated date ${date}; its row of RELEASE_DATES is ${row}`,
      );
  }
  const rows = headings
    .map((key) => input.dates[key])
    .filter((d): d is string => d !== undefined && isRowDate(d));
  const newest = rows.reduce<string | undefined>(
    (a, d) => (a === undefined || Date.parse(d) > Date.parse(a) ? d : a),
    undefined,
  );
  const want = newest ?? input.start;
  const feedDates = kids(root, "updated");
  const feedDate = feedDates[0]?.text.trim() ?? "";
  if (feedDates.length === 1 && isDateTime(feedDate) && feedDate !== want)
    r.failures.push(
      `the feed has the updated date ${feedDate}; it must be ${want}, the newest row of RELEASE_DATES, or FEED_START with no row`,
    );

  // Zero entries: an exemption only while no release exists (spec 18 item 13).
  if (entries.length === 0) {
    const above = input.versions.filter((v) => v.version !== "0.0.0");
    for (const v of above)
      r.failures.push(`${v.pkg} is at ${v.version} and the feed has 0 entries`);
    if (above.length === 0 && input.changelogs.length === 0 && input.versions.length > 0)
      r.exempt = ["every package is at 0.0.0; no release exists (spec 18 item 13)"];
  }
  return done();
}
