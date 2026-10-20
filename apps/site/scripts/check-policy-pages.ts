// check-policy-pages (plan 12j Task 13a, spec 33 items 1 and 7). Two docs
// pages state facts that other files hold: the versioning page and the
// security policy page. Each fact sentence of a page is a copy of one
// sentence of its source, so this check holds each copy equal to the source.
// A held section holds only its allowed sentences, so a fact with no source
// cannot join it. SECURITY.md gives the support window, the channels, and
// the times. Spec 33 item 1.2 gives the 0.x rules and the bump of each class
// of change. .changeset/config.json gives one version. The version of core
// gives the state today. release/repository.json gives the link to the file.
// FIRST_RELEASE gives the first release. Two release checks refuse a release
// at 0.0.x, and each names FIRST_RELEASE.
import { existsSync, readdirSync } from "node:fs";
import { type Repository, readPolicyInput } from "./check-security-policy.ts";
import { REPO } from "./lib/paths.ts";
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
  checkTag: "scripts/release/src/check-tag.ts",
  checkPack: "scripts/release/src/check-pack.ts",
  docs: "apps/site/src/content/docs/docs",
  built: "apps/site/dist/docs",
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
  checkTag: string;
  checkPack: string;
  /** The folder names under the docs tree. A versioned tree is a folder v<major>.<minor>. */
  docsFolders: string[];
  /** The folder names under the built docs, dist/docs/. */
  builtFolders: string[];
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

/** A section that holds only its allowed sentences. With `pointer`, it also takes a pointer sentence. */
interface Held {
  page: string;
  section: string;
  pointer: boolean;
}

/** The sections that the check always holds. Other sections join while their state holds. */
const HELD: readonly Held[] = [
  { page: VERSIONING, section: "One version", pointer: true },
  { page: VERSIONING, section: "The support window", pointer: true },
  { page: SECURITY_PAGE, section: "How to report", pointer: true },
  { page: SECURITY_PAGE, section: "The times", pointer: true },
  { page: VERSIONING, section: "The rules", pointer: false },
];

/** The section of the security page that links the full policy. It holds the one link sentence only. */
const POLICY_SECTION = "The policy";
const policySentence = (url: string) =>
  `The full policy is on the [security page](/security/) of this site, and in [SECURITY.md](${url}/blob/main/SECURITY.md) at the repository root.`;

/** A sentence that only points at a page, such as "Read [Security policy](/docs/reference/security-policy/)." */
const POINTER = /^Read \[[^\]]+\]\([^)\s]+\)\.$/;

/** The state of the versions while core is at 0.0.0. The release branch removes the section. */
const TODAY_SECTION = "The versions today";
const TODAY =
  "Every package is private and at version `0.0.0`. No release exists, and the owner decides when the packages publish.";
/**
 * The docs of today (ruling 29 of plan 12j). Spec 33 item 13 puts the
 * versioned docs trees outside plan 12j. So the page says that only the docs
 * of main exist, until a versioned tree exists.
 */
const DOCS_SECTION = "The docs";
const DOCS_TODAY =
  "The site shows the docs of the current main only, at `/docs/`. A later plan adds a docs tree for each earlier minor.";
/** The fact of the one fixed Changesets group (spec 33 item 1.1). */
const ONE_VERSION = "Every released package has the same version.";
/** The three classes of a change in spec 33 item 1.2. */
type ChangeClass = "break" | "feature" | "fix";

/**
 * The class of each row of the rule table, by its Change cell. The spec
 * gives the bump of each class, so the check holds each In 0.x cell to the
 * spec through the class. A schema version also needs a migration in each
 * adapter (spec 33 item 1.5 and spec 6), so its cells add that text.
 */
const ROWS: Readonly<Record<string, { class: ChangeClass; with?: string }>> = {
  "A change that breaks a caller: a removed export, a changed answer, a removed route": {
    class: "break",
  },
  "A new error code": { class: "feature" },
  "A new route, a new config key, a new export": { class: "feature" },
  "A fix that changes no answer that a caller reads": { class: "fix" },
  "A new schema version": { class: "feature", with: "with its migration in each adapter" },
};

/**
 * The bump of each class from 1.0.0: Semantic Versioning 2.0.0, items 6 to
 * 8. Spec 33 item 1.2 leaves 1.0.0 to a later decision of the owner, so no
 * spec line holds this column. The column is a rule of the page, and this
 * check holds it to the class of each row.
 */
const STABLE: Readonly<Record<ChangeClass, string>> = {
  break: "major",
  feature: "minor",
  fix: "patch",
};

/**
 * The bullets of the section The rules, each with its source. The page
 * states them as written, so a changed or a new bullet fails.
 */
const RULES: readonly { sentence: string; from: string }[] = [
  { sentence: "The error codes are stable strings.", from: "spec 10" },
  {
    sentence: "A code never changes its meaning, and a new code is a minor version.",
    from: "spec 10",
  },
  {
    sentence: "The schema version is a constant in core, apart from the package version.",
    from: "spec 6 and spec 33 item 1.5",
  },
  { sentence: "Each adapter refuses a database with an older schema version.", from: "spec 6" },
  {
    sentence: "Keep every `@authtempo` package of an app at the same version.",
    from: "spec 33 items 1.1 and 10.2",
  },
];

/** The spec sentence that gives the bump of each class in 0.x. */
const CLASS_SENTENCE =
  /^In 0\.x a break is a (major|minor|patch) with a "Breaking:" line in its changeset, a feature is a (major|minor|patch), and a fix is a (major|minor|patch)\.$/;

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

  // The rules: each bullet as written, from its source.
  const rules = sectionOrFail(VERSIONING, "The rules");
  for (const r of RULES) {
    allow(VERSIONING, "The rules", r.sentence);
    if (rules !== null && !sentencesOf(rules).includes(r.sentence))
      failures.push(
        `${VERSIONING}, section "The rules", does not state: ${r.sentence} (from ${r.from})`,
      );
  }

  // The first release: FIRST_RELEASE gives the version. check-pack and
  // check-tag refuse a release at 0.0.x where the release reads the version.
  // Each names FIRST_RELEASE in its failure message, so a rule that goes
  // takes that line with it.
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
      [PATHS.checkTag, input.checkTag],
      [PATHS.checkPack, input.checkPack],
    ] as const)
      if (!/\$\{FIRST_RELEASE\}/.test(text))
        failures.push(
          `${file} has no message with \${FIRST_RELEASE}, so no rule keeps the sentence: ${sentence}`,
        );
  }

  // The sections that hold only their allowed sentences. Some join below,
  // each while its state holds.
  const held: Held[] = [...HELD, { page: SECURITY_PAGE, section: POLICY_SECTION, pointer: false }];
  allow(SECURITY_PAGE, POLICY_SECTION, policySentence(input.repository.url));

  // The versions today: the section exists only while core is at 0.0.0.
  if (pages.has(VERSIONING)) {
    const today = section(VERSIONING, TODAY_SECTION);
    if (input.coreVersion === "0.0.0") {
      held.push({ page: VERSIONING, section: TODAY_SECTION, pointer: false });
      for (const s of sentencesOf([TODAY])) allow(VERSIONING, TODAY_SECTION, s);
      if (today === null || !sentencesOf(today).join(" ").includes(TODAY))
        failures.push(
          `${PATHS.core} is at 0.0.0, so ${VERSIONING}, section "${TODAY_SECTION}", must state: ${TODAY}`,
        );
    } else if (today !== null)
      failures.push(
        `${PATHS.core} is at ${input.coreVersion}, so ${VERSIONING} must not have the section "${TODAY_SECTION}"`,
      );
  }

  // The docs of today: the sentences hold while no versioned tree exists.
  // After that the section is not held, and it must not state them.
  const versioned = [
    ...input.docsFolders.map((f) => `${PATHS.docs}/${f}`),
    ...input.builtFolders.map((f) => `${PATHS.built}/${f}`),
  ].filter((f) => /\/v\d+\.\d+$/.test(f));
  const docs = section(VERSIONING, DOCS_SECTION);
  const statesToday = docs !== null && sentencesOf(docs).join(" ").includes(DOCS_TODAY);
  if (pages.has(VERSIONING) && versioned.length === 0) {
    held.push({ page: VERSIONING, section: DOCS_SECTION, pointer: true });
    for (const s of sentencesOf([DOCS_TODAY])) allow(VERSIONING, DOCS_SECTION, s);
    if (!statesToday)
      failures.push(
        `no folder v<major>.<minor> is in ${PATHS.docs} or ${PATHS.built}, so ${VERSIONING}, section "${DOCS_SECTION}", must state: ${DOCS_TODAY}`,
      );
  } else if (statesToday)
    failures.push(
      `${versioned[0]} exists, so ${VERSIONING}, section "${DOCS_SECTION}", must not state: ${DOCS_TODAY}`,
    );

  for (const h of held) {
    const lines = section(h.page, h.section);
    if (lines === null) continue;
    const ok = allowed.get(`${h.page}#${h.section}`) ?? new Set<string>();
    for (const s of sentencesOf(lines))
      if (!ok.has(s) && !(h.pointer && POINTER.test(s)))
        failures.push(`${h.page}, section "${h.section}", states "${s}", which no source holds`);
  }

  // The rule table: each row has a class of spec 33 item 1.2. Its In 0.x
  // cell is the bump that the spec gives that class.
  let rows = 0;
  const classLine = specSentences.find((x) => x.startsWith("In 0.x a break"));
  const bump = classLine === undefined ? null : CLASS_SENTENCE.exec(classLine);
  if (specLine !== undefined && bump === null)
    failures.push("spec 33 item 1.2 does not give the bump of a break, a feature, and a fix");
  const cell = (to: string | undefined, extra: (string | undefined)[]) =>
    [`A ${to} version`, ...extra.filter((e) => e !== undefined)].join(", ");
  const zeroCell = (row: { class: ChangeClass; with?: string }) => {
    const [b, f, x] = bump?.slice(1) ?? [];
    const to = { break: b, feature: f, fix: x }[row.class];
    const line = row.class === "break" ? "with a `Breaking:` line in its changeset" : undefined;
    return cell(to, [line, row.with]);
  };
  const table = (section(VERSIONING, "The rules") ?? []).filter((l) => l.trim().startsWith("|"));
  const header = table[0] === undefined ? [] : cellsOf(table[0]);
  const zero = header.indexOf("In 0.x");
  const stable = header.indexOf("From 1.0.0");
  if (pages.has(VERSIONING)) {
    if (zero < 0) failures.push(`${VERSIONING}: the rule table has no column "In 0.x"`);
    if (stable < 0) failures.push(`${VERSIONING}: the rule table has no column "From 1.0.0"`);
  }
  if (zero >= 0 && stable >= 0) {
    const seen = new Set<string>();
    for (const line of table.slice(2)) {
      rows++;
      const cells = cellsOf(line);
      const [change, got, from] = [cells[0] ?? "", cells[zero] ?? "", cells[stable] ?? ""];
      seen.add(change);
      const row = ROWS[change];
      if (row === undefined) {
        failures.push(
          `${VERSIONING}: the row "${change}" has no class (break, feature, or fix) in check-policy-pages`,
        );
        continue;
      }
      const want = zeroCell(row);
      if (bump !== null && got !== want)
        failures.push(
          `${VERSIONING}: the row "${change}" is a ${row.class}, so its In 0.x cell must be "${want}" (spec 33 item 1.2), not "${got}"`,
        );
      const wantStable = cell(STABLE[row.class], [row.with]);
      if (from !== wantStable)
        failures.push(
          `${VERSIONING}: the row "${change}" is a ${row.class}, so its From 1.0.0 cell must be "${wantStable}" (Semantic Versioning 2.0.0), not "${from}"`,
        );
    }
    for (const change of Object.keys(ROWS))
      if (!seen.has(change)) failures.push(`${VERSIONING}: the rule table has no row "${change}"`);
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
      counts: { pages: pages.size, ties: TIES.length, states: 4, rows, links },
      failures,
    },
    ["pages", "rows", "links"],
  );
}

/**
 * The folder names under a repository path of `root`, in name order. An
 * absent folder has none: the build output exists only after a build. Spec
 * 18 item 13 builds each earlier docs tree from the git tag of its minor. So
 * a later plan can write a tree into the build output only, and the check
 * reads both places.
 */
export function readFolders(root: string): (path: string) => string[] {
  return (path) =>
    existsSync(`${root}${path}`)
      ? readdirSync(`${root}${path}`, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
      : [];
}

/**
 * Reads the two pages and their sources by their repository paths. A file
 * that is absent is a failure, so the check never passes on a file it did
 * not read. SECURITY.md and release/repository.json come through
 * readPolicyInput, the reader of check-security-policy.
 */
export function readPolicyPagesInput(
  read: (path: string) => string | null,
  folders: (path: string) => string[] = readFolders(REPO),
): {
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
      checkTag: text(PATHS.checkTag),
      checkPack: text(PATHS.checkPack),
      docsFolders: folders(PATHS.docs),
      builtFolders: folders(PATHS.built),
    },
    failures,
  };
}
