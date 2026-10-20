// check-policy-pages (plan 12j Task 13a, spec 33 items 1 and 7). Two docs
// pages state facts that other files hold: the versioning page and the
// security policy page. Each fact sentence of a page is a copy of one
// sentence of its source, so this check holds each copy equal to the source.
// A section that the check holds may hold only those copies, so a fact with
// no source cannot join it. The sources: SECURITY.md (the support window, the
// channels, the times), spec 33 item 1.2 (the 0.x rules), .changeset/config.json
// (one version), the version of core (the state today),
// release/repository.json (the link to the file), and FIRST_RELEASE with the
// two release checks that refuse another first release.
import { type Repository, readPolicyInput } from "./check-security-policy.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The versioning page, by its path under src/content/docs/. */
const VERSIONING = "docs/versioning.md";
/** The security policy page, by its path under src/content/docs/. */
const SECURITY_PAGE = "docs/reference/security-policy.md";
/** The repository path of each page and source that the entry reads. */
const PATHS = {
  versioning: `apps/site/src/content/docs/${VERSIONING}`,
  securityPage: `apps/site/src/content/docs/${SECURITY_PAGE}`,
  spec: "docs/superpowers/specs/2026-10-09-tempo-auth-design.md",
  changesetConfig: ".changeset/config.json",
  core: "packages/core/package.json",
  releaseFacts: "scripts/release/src/lib/release-facts.ts",
  checkChangesets: "scripts/release/src/check-changesets.ts",
  checkPack: "scripts/release/src/check-pack.ts",
} as const;

export interface PolicyPagesInput {
  versioning: string;
  securityPage: string;
  security: string;
  spec: string;
  changesetConfig: string;
  coreVersion: string;
  repository: Repository;
  /** The texts of the release package that keep the first release (ruling 28 of plan 12j). */
  releaseFacts: string;
  checkChangesets: string;
  checkPack: string;
}

/**
 * One sentence of a page that copies one sentence of a source. The source
 * sentence is the one that starts with `starts`. A required tie fails when
 * the source lacks the sentence. A mirror tie follows the source both ways:
 * SECURITY.md states it only before the first release, and check-security-policy
 * holds that state on release/support.json.
 */
interface Tie {
  page: string;
  section: string;
  source: { file: "SECURITY.md"; section: string } | { file: "spec" };
  starts: string;
  mirror?: true;
}

/** The line of spec 33 item 1.2. The spec is a record, so the line stays as written. */
const SPEC_ITEM = "0.x until the first stable.";

const security = (section: string) => ({ file: "SECURITY.md", section }) as const;

const TIES: readonly Tie[] = [
  ...["The first release is", "In 0.x a break", "The owner names"].map(
    (starts): Tie => ({
      page: VERSIONING,
      section: "One version",
      source: { file: "spec" },
      starts,
    }),
  ),
  ...["No release exists yet.", "The first minor is the current minor"].map(
    (starts): Tie => ({
      page: VERSIONING,
      section: "The support window",
      source: security("Supported versions"),
      starts,
      mirror: true,
    }),
  ),
  ...[
    "The current minor gets every fix.",
    "The previous minor gets security fixes",
    "After that date,",
    "A database at a schema version",
  ].map(
    (starts): Tie => ({
      page: VERSIONING,
      section: "The support window",
      source: security("Supported versions"),
      starts,
    }),
  ),
  {
    page: SECURITY_PAGE,
    section: "How to report",
    source: security("How to report"),
    starts: "Until the first release,",
    mirror: true,
  },
  ...[
    "Report a fault through",
    "[GitHub private vulnerability reporting](",
    "[security@",
    "Do not open a public issue",
    "Do not include a real user",
  ].map(
    (starts): Tie => ({
      page: SECURITY_PAGE,
      section: "How to report",
      source: security("How to report"),
      starts,
    }),
  ),
  ...["The first answer comes", "The triage result comes"].map(
    (starts): Tie => ({
      page: SECURITY_PAGE,
      section: "The times",
      source: security("The answer time"),
      starts,
    }),
  ),
  {
    page: SECURITY_PAGE,
    section: "The times",
    source: security("The disclosure window"),
    starts: "The advisory becomes public",
  },
];

/** The sections that hold only copies of a source, and a pointer sentence at most. */
const HELD: readonly { page: string; section: string }[] = [
  { page: VERSIONING, section: "One version" },
  { page: VERSIONING, section: "The support window" },
  { page: SECURITY_PAGE, section: "How to report" },
  { page: SECURITY_PAGE, section: "The times" },
];

/** A sentence that only points at a page, such as "Read [Security policy](/docs/reference/security-policy/)." */
const POINTER = /^Read \[[^\]]+\]\([^)\s]+\)\.$/;

/** The state of the versions while core is at 0.0.0. The release branch removes the section. */
const TODAY_SECTION = "The versions today";
const TODAY =
  "Every package is private and at version `0.0.0`. No release exists, and the owner decides when the packages publish.";
/** The fact of the one fixed Changesets group (spec 33 item 1.1). */
const ONE_VERSION = "Every released package has the same version.";
/** The 0.x cell of a change that is a major version from 1.0.0 (spec 33 item 1.2). */
const BREAK_CELL = "A minor version, with a `Breaking:` line in its changeset";

/** The `## ` sections of a Markdown text, each with its lines up to the next one. */
function sectionsOf(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let lines: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      lines = [];
      map.set(line.slice(3).trim(), lines);
    } else lines?.push(line);
  }
  return map;
}

/**
 * The sentences of some Markdown lines. Each list item and each paragraph is
 * one unit, so a lead-in that ends in a colon stays apart from its list.
 * A table, a heading, and the frontmatter are not prose.
 */
function sentencesOf(lines: readonly string[]): string[] {
  const units: string[] = [];
  let open = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("|") || line.startsWith("#")) {
      open = false;
      continue;
    }
    const item = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item !== null) units.push(item[1] ?? "");
    else if (open) units[units.length - 1] = `${units.at(-1)} ${line}`;
    else units.push(line);
    open = true;
  }
  return units.flatMap((u) => u.split(/(?<=[.!?])\s+(?=[A-Z0-9`["*])/));
}

/** The link targets of some Markdown lines. */
const linksOf = (lines: readonly string[]) =>
  [...lines.join("\n").matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");

/** The cells of a table line, trimmed. */
const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function checkPolicyPages(input: PolicyPagesInput): CheckReport {
  const failures: string[] = [];
  const pages = new Map<string, Map<string, string[]>>();
  if (input.versioning !== "") pages.set(VERSIONING, sectionsOf(input.versioning));
  if (input.securityPage !== "") pages.set(SECURITY_PAGE, sectionsOf(input.securityPage));
  const securitySections = sectionsOf(input.security);
  const specLine = input.spec.split("\n").find((l) => l.includes(SPEC_ITEM));
  const specSentences = specLine === undefined ? [] : sentencesOf([specLine]);
  if (specLine === undefined) failures.push(`${PATHS.spec} has no line "${SPEC_ITEM}"`);

  const section = (page: string, name: string): string[] | null =>
    pages.get(page)?.get(name) ?? null;
  const missing = new Set<string>();
  const sectionOrFail = (page: string, name: string): string[] | null => {
    const lines = section(page, name);
    if (lines === null && pages.has(page) && !missing.has(`${page}#${name}`)) {
      missing.add(`${page}#${name}`);
      failures.push(`${page} has no section "${name}"`);
    }
    return lines;
  };

  // The allowed sentences of each held section: each copy that its source holds now.
  const allowed = new Map<string, Set<string>>();
  const allow = (page: string, name: string, sentence: string) => {
    const key = `${page}#${name}`;
    allowed.set(key, (allowed.get(key) ?? new Set()).add(sentence));
  };

  for (const tie of TIES) {
    const label =
      tie.source.file === "spec"
        ? "spec 33 item 1.2"
        : `SECURITY.md, section "${tie.source.section}"`;
    const from =
      tie.source.file === "spec"
        ? specSentences
        : sentencesOf(securitySections.get(tie.source.section) ?? []);
    const sentence = from.find((s) => s.startsWith(tie.starts));
    const lines = sectionOrFail(tie.page, tie.section);
    if (sentence === undefined) {
      if (tie.mirror !== true)
        failures.push(
          `${label}, holds no sentence that starts "${tie.starts}"; ${tie.page} copies it`,
        );
      continue;
    }
    allow(tie.page, tie.section, sentence);
    if (lines !== null && !sentencesOf(lines).includes(sentence))
      failures.push(
        `${tie.page}, section "${tie.section}", does not state: ${sentence} (from ${label})`,
      );
  }

  // One version: the sentence holds while the config has one fixed group.
  let fixed = 0;
  try {
    const config = JSON.parse(input.changesetConfig) as { fixed?: unknown };
    fixed = Array.isArray(config.fixed) ? config.fixed.length : 0;
  } catch {
    failures.push(`${PATHS.changesetConfig} is not JSON`);
  }
  const oneVersion = sectionOrFail(VERSIONING, "One version");
  if (fixed === 1) {
    allow(VERSIONING, "One version", ONE_VERSION);
    if (oneVersion !== null && !sentencesOf(oneVersion).includes(ONE_VERSION))
      failures.push(
        `${VERSIONING}, section "One version", does not state: ${ONE_VERSION} (from ${PATHS.changesetConfig}, which has 1 fixed group)`,
      );
  }

  // The first release: FIRST_RELEASE gives the version, and check-changesets
  // and check-pack refuse another one. Each names FIRST_RELEASE in its failure
  // message, so a rule that goes takes that line with it.
  const first = /^export const FIRST_RELEASE = "([^"]+)";$/m.exec(input.releaseFacts)?.[1];
  if (first === undefined) failures.push(`${PATHS.releaseFacts} has no export const FIRST_RELEASE`);
  else {
    const sentence = `The first release is \`${first}\`.`;
    allow(VERSIONING, "One version", sentence);
    if (oneVersion !== null && !sentencesOf(oneVersion).includes(sentence))
      failures.push(
        `${VERSIONING}, section "One version", does not state: ${sentence} (from ${PATHS.releaseFacts}, FIRST_RELEASE)`,
      );
    for (const [file, text] of [
      [PATHS.checkChangesets, input.checkChangesets],
      [PATHS.checkPack, input.checkPack],
    ] as const)
      if (!/\$\{FIRST_RELEASE\}/.test(text))
        failures.push(
          `${file} has no message with \${FIRST_RELEASE}, so no rule keeps the sentence: ${sentence}`,
        );
  }

  // The versions today: the section exists only while core is at 0.0.0.
  if (pages.has(VERSIONING)) {
    const today = section(VERSIONING, TODAY_SECTION);
    if (input.coreVersion === "0.0.0") {
      if (today === null || !sentencesOf(today).join(" ").includes(TODAY))
        failures.push(
          `${PATHS.core} is at 0.0.0, so ${VERSIONING}, section "${TODAY_SECTION}", must state: ${TODAY}`,
        );
    } else if (today !== null)
      failures.push(
        `${PATHS.core} is at ${input.coreVersion}, so ${VERSIONING} must not have the section "${TODAY_SECTION}"`,
      );
  }

  for (const held of HELD) {
    const lines = section(held.page, held.section);
    if (lines === null) continue;
    const ok = allowed.get(`${held.page}#${held.section}`) ?? new Set<string>();
    for (const s of sentencesOf(lines))
      if (!ok.has(s) && !POINTER.test(s))
        failures.push(
          `${held.page}, section "${held.section}", states "${s}", which no source holds`,
        );
  }

  // The rule table: the 0.x cell equals the cell from 1.0.0, and a major
  // version becomes a minor with a "Breaking:" line (spec 33 item 1.2).
  let rows = 0;
  const table = (section(VERSIONING, "The rules") ?? []).filter((l) => l.trim().startsWith("|"));
  const header = table[0] === undefined ? [] : cellsOf(table[0]);
  const zero = header.indexOf("In 0.x");
  const stable = header.indexOf("From 1.0.0");
  if (pages.has(VERSIONING)) {
    if (zero < 0) failures.push(`${VERSIONING}: the rule table has no column "In 0.x"`);
    if (stable < 0) failures.push(`${VERSIONING}: the rule table has no column "From 1.0.0"`);
  }
  if (zero >= 0 && stable >= 0)
    for (const line of table.slice(2)) {
      rows++;
      const cells = cellsOf(line);
      const [change, got, from] = [cells[0] ?? "", cells[zero] ?? "", cells[stable] ?? ""];
      const want = from === "A major version" ? BREAK_CELL : from;
      if (got !== want)
        failures.push(
          `${VERSIONING}: the row "${change}" gives "${got}" in 0.x; from 1.0.0 it gives "${from}", so in 0.x it must give "${want}"`,
        );
    }

  // The links: each page points at the source that holds the full facts.
  let links = 0;
  for (const want of [
    { page: VERSIONING, section: "The support window", href: "/docs/reference/security-policy/" },
    { page: SECURITY_PAGE, section: "The policy", href: "/security/" },
    {
      page: SECURITY_PAGE,
      section: "The policy",
      href: `${input.repository.url}/blob/main/SECURITY.md`,
    },
  ]) {
    const lines = sectionOrFail(want.page, want.section);
    if (lines === null) continue;
    if (linksOf(lines).includes(want.href)) links++;
    else failures.push(`${want.page}, section "${want.section}", does not link ${want.href}`);
  }

  return requireCounts(
    {
      name: "check-policy-pages",
      counts: { pages: pages.size, ties: TIES.length, states: 3, rows, links },
      failures,
    },
    ["pages", "rows", "links"],
  );
}

/**
 * Reads the two pages and their sources by their repository paths. A file
 * that is absent is a failure, so the check never passes on a file it did
 * not read. SECURITY.md and release/repository.json come through
 * readPolicyInput, the reader of check-security-policy.
 */
export function readPolicyPagesInput(read: (path: string) => string | null): {
  input: PolicyPagesInput;
  failures: string[];
} {
  const failures: string[] = [];
  const text = (path: string) => {
    const t = read(path);
    if (t === null) failures.push(`${path} is missing`);
    return t ?? "";
  };
  const policy = readPolicyInput(read);
  const versioning = text(PATHS.versioning);
  const securityPage = text(PATHS.securityPage);
  const spec = text(PATHS.spec);
  const changesetConfig = text(PATHS.changesetConfig);
  let coreVersion = "";
  try {
    const v = (JSON.parse(text(PATHS.core) || "{}") as { version?: unknown }).version;
    coreVersion = typeof v === "string" ? v : "";
  } catch {
    failures.push(`${PATHS.core} is not JSON`);
  }
  if (coreVersion === "" && !failures.includes(`${PATHS.core} is missing`))
    failures.push(`${PATHS.core} has no version`);
  failures.push(...policy.failures);
  return {
    input: {
      versioning,
      securityPage,
      security: policy.text ?? "",
      spec,
      changesetConfig,
      coreVersion,
      repository: policy.repository,
      releaseFacts: text(PATHS.releaseFacts),
      checkChangesets: text(PATHS.checkChangesets),
      checkPack: text(PATHS.checkPack),
    },
    failures,
  };
}
