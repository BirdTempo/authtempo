// check-security-policy (plan 12j Task 12, spec 33 item 7). It holds
// SECURITY.md of the repository root. It reads the seven sections in order
// and the support table against release/support.json. It also reads the times
// of owner decision 4 and the two channels. The prose rules are not here:
// check-terms and check-sentences read the file through policyProsePages (plan 11b).
import { CHANNELS_CLOSED, NO_RELEASE_YET as NO_RELEASE } from "../src/data/unpublished.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The `## ` sections of SECURITY.md, in this order (spec 33 item 7). */
export const SECURITY_SECTIONS = [
  "Supported versions",
  "How to report",
  "The answer time",
  "The disclosure window",
  "The advisory format",
  "Supplier advisories",
  "Out of scope",
] as const;

/**
 * One row of release/support.json. check-support of authtempo-release holds
 * the shape and the rules of each row. This check reads the fields of the table.
 */
export interface SupportRow {
  minor: string;
  status: string;
  released: string;
  securityUntil?: string;
  schemaFrom: readonly number[];
}

/** release/repository.json (plan 12j Task 1). */
export interface Repository {
  url: string;
  owner: string;
  name: string;
}

/** Each time that a section must state, with its source. */
const TIMES: readonly {
  section: (typeof SECURITY_SECTIONS)[number];
  text: string;
  source: string;
}[] = [
  { section: "The answer time", text: "72 hours", source: "owner decision 4" },
  { section: "The answer time", text: "7 days", source: "spec 33 item 7" },
  { section: "The answer time", text: "14 days", source: "spec 33 item 7" },
  { section: "The answer time", text: "CVSS 4.0", source: "spec 33 item 7" },
  { section: "The disclosure window", text: "90 days", source: "owner decision 4" },
];

/** Text that only a draft holds. A `<` is a template part such as `<owner>`. */
const PLACEHOLDERS = ["example.com", "TODO", "<"];

/** The table of release/support.json, one line each, as SECURITY.md holds it. */
function tableLines(rows: readonly SupportRow[]): string[] {
  return rows.map(
    (r) =>
      `| ${r.minor} | ${r.status} | ${r.released} | ${r.securityUntil ?? "none"} | ${r.schemaFrom.join(", ")} |`,
  );
}

/** The `## ` sections of a Markdown text: each heading with the text up to the next one. */
function sectionsOf(text: string): { heading: string; body: string }[] {
  const list: { heading: string; body: string }[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) list.push({ heading: line.slice(3).trim(), body: "" });
    else {
      const last = list[list.length - 1];
      if (last !== undefined) last.body += `${line}\n`;
    }
  }
  return list;
}

/** The target of each Markdown link `[text](target)`, in order. */
const linksOf = (text: string) => [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");

export function checkSecurityPolicy(input: {
  text: string;
  rows: readonly SupportRow[];
  repository: Repository;
  /** The origin of the site. check.ts passes SITE.origin, so the mailbox follows a change of host. */
  origin: string;
}): CheckReport {
  const { text, rows, repository, origin } = input;
  const failures: string[] = [];
  const sections = sectionsOf(text);
  const headings = sections.map((s) => s.heading);
  const known: readonly string[] = SECURITY_SECTIONS;
  const body = (heading: string) => sections.find((s) => s.heading === heading)?.body ?? "";

  for (const heading of SECURITY_SECTIONS)
    if (!headings.includes(heading)) failures.push(`the section "${heading}" is missing`);
  for (const heading of headings)
    if (!known.includes(heading))
      failures.push(`the section "${heading}" is not a section of the policy`);
  const present = headings.filter((h) => known.includes(h));
  const want = SECURITY_SECTIONS.filter((h) => present.includes(h));
  if (present.join("\n") !== want.join("\n"))
    failures.push(`the sections are out of order: ${present.join(", ")}`);

  // The support table is a copy of release/support.json, so it must equal it.
  const supported = body("Supported versions");
  const tableRows = supported
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2);
  const expected = tableLines(rows);
  if (tableRows.length !== expected.length)
    failures.push(
      `the support table differs from release/support.json: it has ${tableRows.length} row${tableRows.length === 1 ? "" : "s"} and release/support.json has ${expected.length}`,
    );
  else
    tableRows.forEach((line, i) => {
      if (line.trim() !== expected[i])
        failures.push(
          `the support table differs from release/support.json: row ${i + 1} is ${line.trim()}; release/support.json gives ${expected[i]}`,
        );
    });

  // The statements that hold only while no release exists, both ways, on the
  // table. check-pre-release holds the same texts on the version of core.
  const released = rows.length > 0;
  const state = released
    ? `release/support.json has ${rows.length} row${rows.length === 1 ? "" : "s"}`
    : "release/support.json is []";
  for (const [section, sentence] of [
    ["Supported versions", NO_RELEASE],
    ["How to report", CHANNELS_CLOSED],
  ] as const) {
    const holds = body(section).includes(sentence);
    if (!released && !holds)
      failures.push(`${state}, so the section "${section}" must state: ${sentence}`);
    if (released && holds)
      failures.push(`${state}, so the section "${section}" must not state: ${sentence}`);
  }

  for (const p of PLACEHOLDERS)
    if (text.includes(p)) failures.push(`SECURITY.md holds the placeholder "${p}"`);
  for (const m of text.matchAll(/\bhttp:\/\/[^\s)]+/g))
    failures.push(`SECURITY.md links ${m[0]}; each link uses https`);
  // Each host form of GitHub, so a link to www.github.com or over http is read too.
  for (const m of text.matchAll(
    /\bhttps?:\/\/(www\.)?github\.com\/([^/\s)]+)\/([^/\s)]+)[^\s)]*/g,
  )) {
    if (m[1] !== undefined)
      failures.push(`SECURITY.md links ${m[0]}; a GitHub link uses the host github.com`);
    const [owner, name] = [m[2] ?? "", m[3] ?? ""];
    if (owner !== repository.owner || name !== repository.name)
      failures.push(
        `SECURITY.md links the repository ${owner}/${name}; release/repository.json names ${repository.owner}/${repository.name}`,
      );
  }

  // The channels of owner decision 4: GitHub private vulnerability reporting
  // first, then the mailbox. The mailbox has the host of the origin input.
  const channels = linksOf(body("How to report"));
  const advisory = `${repository.url}/security/advisories/new`;
  const mailbox = `mailto:security@${new URL(origin).host}`;
  // A reporter reads the text of the link, so the text is the address of its target.
  for (const m of body("How to report").matchAll(/\[([^\]]*)\]\(mailto:([^)\s]+)\)/g))
    if (m[1] !== m[2])
      failures.push(`the mailbox link shows ${m[1]}; its target is mailto:${m[2]}`);
  if (channels.length !== 2)
    failures.push(`the section "How to report" names ${channels.length} channels; it must name 2`);
  if (channels[0] !== undefined && channels[0] !== advisory)
    failures.push(
      `the first channel is ${channels[0]}; it must be ${advisory}, from release/repository.json`,
    );
  if (channels[1] !== undefined && channels[1] !== mailbox)
    failures.push(
      `the second channel is ${channels[1]}; it must be ${mailbox}, at the host of ${origin}`,
    );

  for (const t of TIMES)
    if (!body(t.section).includes(t.text))
      failures.push(`the section "${t.section}" does not state "${t.text}" (${t.source})`);

  const record = `${repository.url}/blob/main/docs/security/advisories.md`;
  if (!linksOf(body("Supplier advisories")).includes(record))
    failures.push(`the section "Supplier advisories" does not link ${record}`);

  return requireCounts(
    {
      name: "check-security-policy",
      counts: { sections: present.length, rows: rows.length, channels: channels.length },
      failures,
    },
    ["sections", "channels"],
  );
}

/**
 * Reads SECURITY.md, release/support.json, and release/repository.json by
 * their paths from the repository root. A file that is absent or not JSON
 * is a failure, so the check never passes on a file it did not read.
 */
export function readPolicyInput(read: (path: string) => string | null): {
  text: string | null;
  rows: SupportRow[];
  repository: Repository;
  failures: string[];
} {
  const failures: string[] = [];
  const json = (path: string): unknown => {
    const raw = read(path);
    if (raw === null) {
      failures.push(`${path} is missing`);
      return null;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      failures.push(`${path} is not JSON`);
      return null;
    }
  };
  const text = read("SECURITY.md");
  if (text === null) failures.push("SECURITY.md is missing");
  const support = json("release/support.json");
  if (support !== null && !Array.isArray(support))
    failures.push("release/support.json is not an array");
  const repo = json("release/repository.json") as Partial<Repository> | null;
  const repository: Repository = {
    url: typeof repo?.url === "string" ? repo.url : "",
    owner: typeof repo?.owner === "string" ? repo.owner : "",
    name: typeof repo?.name === "string" ? repo.name : "",
  };
  if (repo !== null && (repository.url === "" || repository.owner === "" || repository.name === ""))
    failures.push("release/repository.json needs url, owner, and name");
  return {
    text,
    rows: Array.isArray(support) ? (support as SupportRow[]) : [],
    repository,
    failures,
  };
}
