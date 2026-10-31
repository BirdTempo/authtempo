import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPolicyPages,
  type PolicyPagesInput,
  readFolders,
  readPolicyPagesInput,
} from "../scripts/check-policy-pages.ts";
import { readRepoFile } from "../scripts/lib/load.ts";
import { summaryLine } from "../scripts/lib/report.ts";

// The real files of the tree: the two pages, SECURITY.md, spec 33, the
// Changesets config, core's package.json, and release/repository.json
// (plan 12j Task 13a).
const real = readPolicyPagesInput(readRepoFile);
const REAL = real.input;

/** The input with one file text changed. Each break replaces one whole part, as a person would. */
function withText(
  key: "versioning" | "securityPage" | "security" | "spec",
  from: string,
  to: string,
) {
  expect(REAL[key]).toContain(from);
  return { ...REAL, [key]: REAL[key].replace(from, to) } satisfies PolicyPagesInput;
}

const failures = (input: PolicyPagesInput) => checkPolicyPages(input).failures;

/**
 * The group version of the tree: check-packages holds every released package,
 * core too, at one version. At 0.0.0 no release exists. The version pull
 * request moves it, and the tests then hold the state of the release day.
 */
const UNRELEASED = REAL.coreVersion === "0.0.0";

/** The sentence of SECURITY.md and of the security page before the first release. */
const CLOSED =
  "Until the first release, the two channels are not open, and the times of this policy do not apply.";
/** The sentences of SECURITY.md and of the versioning page before the first release. */
const NONE = "No release exists yet. The first minor is the current minor at its release.";
/** The section of the versioning page before the first release. */
const TODAY_TEXT =
  "Every package is private and at version `0.0.0`. No release exists, and the owner decides when the packages publish.";

/**
 * One file text with the paragraph `line` as the first paragraph under
 * `heading`, and the same text without it. The real text is one of the two,
 * so each test holds both states at any group version.
 */
function both(
  key: "versioning" | "securityPage" | "security",
  heading: string,
  line: string,
): { on: string; off: string } {
  const text = REAL[key];
  expect(text).toContain(`${heading}\n\n`);
  const on = text.includes(`${heading}\n\n${line}\n\n`)
    ? text
    : text.replace(`${heading}\n\n`, `${heading}\n\n${line}\n\n`);
  return { on, off: on.replace(`${heading}\n\n${line}\n\n`, `${heading}\n\n`) };
}

/** The versioning page with and without the section The versions today, above One version. */
function todayStates(): { on: string; off: string } {
  const section = `## The versions today\n\n${TODAY_TEXT}\n\n`;
  const text = REAL.versioning;
  const on = text.includes(section)
    ? text
    : text.replace("## One version\n", `${section}## One version\n`);
  return { on, off: on.replace(section, "") };
}
const TODAY = todayStates();
/** A version of the release day, for the state after the first release. */
const RELEASED = UNRELEASED ? "0.1.0" : REAL.coreVersion;

describe("check-policy-pages", () => {
  it("passes the real pages", () => {
    expect(real.failures).toEqual([]);
    expect(REAL.coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // The real tree holds the state of its group version.
    expect(REAL.versioning.includes("## The versions today\n")).toBe(UNRELEASED);
    expect(REAL.security.includes(CLOSED)).toBe(UNRELEASED);
    expect(REAL.security.includes(NONE)).toBe(UNRELEASED);
    expect(REAL.repository.url).toBe("https://github.com/BirdTempo/authtempo");
    const r = checkPolicyPages(REAL);
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe(
      "check-policy-pages: PASS pages=2 ties=18 states=4 rows=5 links=3 failures=0",
    );
  });

  it("fails a copy that differs from SECURITY.md", () => {
    const input = withText("versioning", "for 3 months after", "for 6 months after");
    expect(failures(input)).toEqual([
      'docs/versioning.md, section "The support window", does not state: The previous minor gets security fixes for 3 months after the next minor ships. (from SECURITY.md, section "Supported versions")',
      'docs/versioning.md, section "The support window", states "The previous minor gets security fixes for 6 months after the next minor ships.", which no source holds',
    ]);
    expect(summaryLine(checkPolicyPages(input))).toBe(
      "check-policy-pages: FAIL pages=2 ties=18 states=4 rows=5 links=3 failures=2",
    );
  });

  it("fails when SECURITY.md changes a time and the page keeps the old one", () => {
    const input = withText("security", "within 72 hours after", "within 48 hours after");
    expect(failures(input)).toEqual([
      'docs/reference/security-policy.md, section "The times", does not state: The first answer comes within 48 hours after the report. (from SECURITY.md, section "The answer time")',
      'docs/reference/security-policy.md, section "The times", states "The first answer comes within 72 hours after the report.", which no source holds',
    ]);
  });

  it("fails when the source no longer holds a sentence that the page copies", () => {
    const input = withText(
      "security",
      "The triage result comes within 7 days after the report. ",
      "",
    );
    expect(failures(input)).toEqual([
      'SECURITY.md, section "The answer time", holds no sentence that starts "The triage result comes"; docs/reference/security-policy.md copies it',
      'docs/reference/security-policy.md, section "The times", states "The triage result comes within 7 days after the report.", which no source holds',
    ]);
  });

  it("fails a sentence in a held section that no source holds", () => {
    const input = withText(
      "securityPage",
      "- The first answer comes",
      "- A Critical fault gets a fix within 1 day.\n- The first answer comes",
    );
    expect(failures(input)).toEqual([
      'docs/reference/security-policy.md, section "The times", states "A Critical fault gets a fix within 1 day.", which no source holds',
    ]);
  });

  it("takes a pointer sentence in a held section only in the link-only form", () => {
    const input = withText(
      "versioning",
      "Read [Security policy](/docs/reference/security-policy/).\n",
      "Read [Security policy](/docs/reference/security-policy/).\n\nRead this: each fault gets a fix in 1 day.\n",
    );
    expect(failures(input)).toEqual([
      'docs/versioning.md, section "The support window", states "Read this: each fault gets a fix in 1 day.", which no source holds',
    ]);
    // A link with more text after it is not a pointer.
    const tail = withText(
      "versioning",
      "Read [Security policy](/docs/reference/security-policy/).",
      "Read [Security policy](/docs/reference/security-policy/) for a fix in 1 day.",
    );
    expect(failures(tail)).toEqual([
      'docs/versioning.md, section "The support window", states "Read [Security policy](/docs/reference/security-policy/) for a fix in 1 day.", which no source holds',
    ]);
  });

  it("holds the closed channels to SECURITY.md both ways", () => {
    const page = both("securityPage", "## How to report", CLOSED);
    const file = both("security", "## How to report", CLOSED);
    // Before the first release, and on the release day: each passes.
    expect(failures({ ...REAL, securityPage: page.on, security: file.on })).toEqual([]);
    expect(failures({ ...REAL, securityPage: page.off, security: file.off })).toEqual([]);
    // The page drops the sentence while SECURITY.md keeps it.
    expect(failures({ ...REAL, securityPage: page.off, security: file.on })).toEqual([
      `docs/reference/security-policy.md, section "How to report", does not state: ${CLOSED} (from SECURITY.md, section "How to report")`,
    ]);
    // SECURITY.md drops the sentence at the first release, and the page keeps it.
    expect(failures({ ...REAL, securityPage: page.on, security: file.off })).toEqual([
      `docs/reference/security-policy.md, section "How to report", states "${CLOSED}", which no source holds`,
    ]);
  });

  it("holds the support window state to SECURITY.md both ways", () => {
    const page = both("versioning", "## The support window", NONE);
    const file = both("security", "## Supported versions", NONE);
    expect(failures({ ...REAL, versioning: page.on, security: file.on })).toEqual([]);
    expect(failures({ ...REAL, versioning: page.off, security: file.off })).toEqual([]);
    expect(failures({ ...REAL, versioning: page.on, security: file.off })).toEqual([
      'docs/versioning.md, section "The support window", states "No release exists yet.", which no source holds',
      'docs/versioning.md, section "The support window", states "The first minor is the current minor at its release.", which no source holds',
    ]);
    expect(failures({ ...REAL, versioning: page.off, security: file.on })).toEqual([
      'docs/versioning.md, section "The support window", does not state: No release exists yet. (from SECURITY.md, section "Supported versions")',
      'docs/versioning.md, section "The support window", does not state: The first minor is the current minor at its release. (from SECURITY.md, section "Supported versions")',
    ]);
  });

  it("holds the version sentences to spec 33 item 1.2", () => {
    const input = withText(
      "versioning",
      "The first release is `0.1.0`.",
      "The first release is `1.0.0`.",
    );
    expect(failures(input)).toEqual([
      'docs/versioning.md, section "One version", does not state: The first release is `0.1.0`. (from spec 33 item 1.2)',
      'docs/versioning.md, section "One version", does not state: The first release is `0.1.0`. (from scripts/release/src/lib/release-facts.ts, FIRST_RELEASE)',
      'docs/versioning.md, section "One version", states "The first release is `1.0.0`.", which no source holds',
    ]);
  });

  it("holds the versions today to the version of core both ways", () => {
    expect(failures({ ...REAL, versioning: TODAY.on, coreVersion: "0.0.0" })).toEqual([]);
    expect(failures({ ...REAL, versioning: TODAY.off, coreVersion: RELEASED })).toEqual([]);
    expect(failures({ ...REAL, versioning: TODAY.on, coreVersion: RELEASED })).toEqual([
      `packages/core/package.json is at ${RELEASED}, so docs/versioning.md must not have the section "The versions today"`,
    ]);
    expect(failures({ ...REAL, versioning: TODAY.off, coreVersion: "0.0.0" })).toEqual([
      `packages/core/package.json is at 0.0.0, so docs/versioning.md, section "The versions today", must state: ${TODAY_TEXT}`,
    ]);
    // The heading stays and the text changes.
    const changed = TODAY.on.replace("Every package is private and at", "Every package is at");
    expect(failures({ ...REAL, versioning: changed, coreVersion: "0.0.0" })).toEqual([
      `packages/core/package.json is at 0.0.0, so docs/versioning.md, section "The versions today", must state: ${TODAY_TEXT}`,
      'docs/versioning.md, section "The versions today", states "Every package is at version `0.0.0`.", which no source holds',
    ]);
  });

  it("holds the one version sentence to the fixed group", () => {
    const two = JSON.stringify({ fixed: [["@authtempo/core"], ["@authtempo/client"]] });
    expect(failures({ ...REAL, changesetConfig: two })).toEqual([
      'docs/versioning.md, section "One version", states "Every released package has the same version.", which no source holds',
    ]);
    const input = withText("versioning", "Every released package has the same version. ", "");
    expect(failures(input)).toEqual([
      'docs/versioning.md, section "One version", does not state: Every released package has the same version. (from .changeset/config.json, which has 1 fixed group)',
    ]);
  });

  it("holds the first release sentence to FIRST_RELEASE and its two rules", () => {
    const facts = REAL.releaseFacts;
    expect(facts).toContain('export const FIRST_RELEASE = "0.1.0";');
    expect(failures({ ...REAL, releaseFacts: facts.replace('= "0.1.0";', '= "0.2.0";') })).toEqual([
      'docs/versioning.md, section "One version", does not state: The first release is `0.2.0`. (from scripts/release/src/lib/release-facts.ts, FIRST_RELEASE)',
    ]);
    expect(
      failures({
        ...REAL,
        releaseFacts: facts.replace("export const FIRST_RELEASE", "const FIRST"),
      }),
    ).toEqual(["scripts/release/src/lib/release-facts.ts has no export const FIRST_RELEASE"]);
    // A rule that no longer names FIRST_RELEASE no longer keeps the sentence.
    for (const [key, file] of [
      ["checkTag", "scripts/release/src/check-tag.ts"],
      ["checkPack", "scripts/release/src/check-pack.ts"],
    ] as const) {
      const text = REAL[key]
        .split("\n")
        .filter((l) => !l.includes("{FIRST_RELEASE}"))
        .join("\n");
      expect(failures({ ...REAL, [key]: text })).toEqual([
        `${file} has no message with \${FIRST_RELEASE}, so no rule keeps the sentence: The first release is \`0.1.0\`.`,
      ]);
    }
  });

  it("holds the docs today to the absence of a versioned docs tree, both ways", () => {
    const today =
      "The site shows the docs of the current main only, at `/docs/`. A later plan adds a docs tree for each earlier minor.";
    expect(REAL.docsFolders).not.toContain("v0.1");
    expect(REAL.builtFolders).not.toContain("v0.1");
    // A versioned tree exists, and the page still says that none exists.
    expect(failures({ ...REAL, docsFolders: [...REAL.docsFolders, "v0.1"] })).toEqual([
      `apps/site/src/content/docs/docs/v0.1 exists, so docs/versioning.md, section "The docs", must not state: ${today}`,
    ]);
    // No versioned tree exists, and the page promises one.
    const promise = withText(
      "versioning",
      "A later plan adds a docs tree for each earlier minor.",
      "Each earlier minor has its own docs tree.",
    );
    expect(failures(promise)).toEqual([
      `no folder v<major>.<minor> is in apps/site/src/content/docs/docs or apps/site/dist/docs, so docs/versioning.md, section "The docs", must state: ${today}`,
      'docs/versioning.md, section "The docs", states "Each earlier minor has its own docs tree.", which no source holds',
    ]);
  });

  it("reads a versioned tree from the source folders and from the build", () => {
    const today =
      "The site shows the docs of the current main only, at `/docs/`. A later plan adds a docs tree for each earlier minor.";
    const root = mkdtempSync(join(tmpdir(), "plan-12j-policy-pages-"));
    try {
      mkdirSync(join(root, "apps/site/src/content/docs/docs/guides"), { recursive: true });
      const folders = readFolders(`${root}/`);
      // No build exists yet, so the build has no folder.
      expect(folders("apps/site/dist/docs")).toEqual([]);
      // Spec 18 item 13 builds an earlier tree from its git tag, so it can exist in the build only.
      mkdirSync(join(root, "apps/site/dist/docs/v0.1"), { recursive: true });
      mkdirSync(join(root, "apps/site/dist/docs/concepts"));
      writeFileSync(join(root, "apps/site/dist/docs/v0.2"), "a file, not a tree\n");
      const read = readPolicyPagesInput(readRepoFile, folders);
      expect(read.input.docsFolders).toEqual(["guides"]);
      expect(read.input.builtFolders).toEqual(["concepts", "v0.1"]);
      expect(failures(read.input)).toEqual([
        `apps/site/dist/docs/v0.1 exists, so docs/versioning.md, section "The docs", must not state: ${today}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds each In 0.x cell to its class in spec 33 item 1.2", () => {
    // A new error code is a feature, so a patch cell fails in both columns.
    const patch = withText(
      "versioning",
      "| A new error code | A minor version | A minor version |",
      "| A new error code | A patch version | A patch version |",
    );
    expect(failures(patch)).toEqual([
      'docs/versioning.md: the row "A new error code" is a feature, so its In 0.x cell must be "A minor version" (spec 33 item 1.2), not "A patch version"',
      'docs/versioning.md: the row "A new error code" is a feature, so its From 1.0.0 cell must be "A minor version" (Semantic Versioning 2.0.0), not "A patch version"',
    ]);
    const major = withText(
      "versioning",
      "| A minor version, with a `Breaking:` line in its changeset | A major version |",
      "| A major version | A major version |",
    );
    expect(failures(major)).toEqual([
      'docs/versioning.md: the row "A change that breaks a caller: a removed export, a changed answer, a removed route" is a break, so its In 0.x cell must be "A minor version, with a `Breaking:` line in its changeset" (spec 33 item 1.2), not "A major version"',
    ]);
    // The spec gives the bump of each class, so a new bump in the spec moves the cells.
    const spec = withText("spec", "a feature is a minor, and", "a feature is a patch, and");
    expect(failures(spec)).toEqual([
      'docs/versioning.md, section "One version", does not state: In 0.x a break is a minor with a "Breaking:" line in its changeset, a feature is a patch, and a fix is a patch. (from spec 33 item 1.2)',
      'docs/versioning.md, section "One version", states "In 0.x a break is a minor with a "Breaking:" line in its changeset, a feature is a minor, and a fix is a patch.", which no source holds',
      'docs/versioning.md: the row "A new error code" is a feature, so its In 0.x cell must be "A patch version" (spec 33 item 1.2), not "A minor version"',
      'docs/versioning.md: the row "A new route, a new config key, a new export" is a feature, so its In 0.x cell must be "A patch version" (spec 33 item 1.2), not "A minor version"',
      'docs/versioning.md: the row "A new schema version" is a feature, so its In 0.x cell must be "A patch version, with its migration in each adapter" (spec 33 item 1.2), not "A minor version, with its migration in each adapter"',
    ]);
    const unread = withText("spec", "a fix is a patch.", "a fix is small.");
    expect(failures(unread)).toContain(
      "spec 33 item 1.2 does not give the bump of a break, a feature, and a fix",
    );
    // A row with no class, and a class row that the table lost.
    const extra = withText(
      "versioning",
      "| A new error code |",
      "| A new page | A minor version | A minor version |\n| A new error code |",
    );
    expect(failures(extra)).toEqual([
      'docs/versioning.md: the row "A new page" has no class (break, feature, or fix) in check-policy-pages',
    ]);
    const lost = withText(
      "versioning",
      "| A new error code | A minor version | A minor version |\n",
      "",
    );
    expect(failures(lost)).toEqual([
      'docs/versioning.md: the rule table has no row "A new error code"',
    ]);
    const noColumn = withText(
      "versioning",
      "| Change | In 0.x | From 1.0.0 |",
      "| Change | Now | From 1.0.0 |",
    );
    expect(failures(noColumn)).toEqual([
      'docs/versioning.md: the rule table has no column "In 0.x"',
      "read 0 rows",
    ]);
  });

  it("holds each From 1.0.0 cell to its class, and The rules to their fixed text", () => {
    const fix = withText(
      "versioning",
      "| A fix that changes no answer that a caller reads | A patch version | A patch version |",
      "| A fix that changes no answer that a caller reads | A patch version | A minor version |",
    );
    expect(failures(fix)).toEqual([
      'docs/versioning.md: the row "A fix that changes no answer that a caller reads" is a fix, so its From 1.0.0 cell must be "A patch version" (Semantic Versioning 2.0.0), not "A minor version"',
    ]);
    const mix = withText(
      "versioning",
      "Keep every `@authtempo` package of an app at the same version.",
      "Each package keeps its own version, so mix versions as you like.",
    );
    expect(failures(mix)).toEqual([
      'docs/versioning.md, section "The rules", does not state: Keep every `@authtempo` package of an app at the same version. (from spec 33 items 1.1 and 10.2)',
      'docs/versioning.md, section "The rules", states "Each package keeps its own version, so mix versions as you like.", which no source holds',
    ]);
    const lost = withText(
      "versioning",
      "- Keep every `@authtempo` package of an app at the same version.\n",
      "",
    );
    expect(failures(lost)).toEqual([
      'docs/versioning.md, section "The rules", does not state: Keep every `@authtempo` package of an app at the same version. (from spec 33 items 1.1 and 10.2)',
    ]);
  });

  it("holds The versions today and The policy to their one text", () => {
    const date = TODAY.on.replace(
      "the owner decides when the packages publish.",
      "the owner decides when the packages publish. The first release ships on 2026-11-01 with a 12-month support window.",
    );
    expect(failures({ ...REAL, versioning: date, coreVersion: "0.0.0" })).toEqual([
      'docs/versioning.md, section "The versions today", states "The first release ships on 2026-11-01 with a 12-month support window.", which no source holds',
    ]);
    const bounty = withText(
      "securityPage",
      "at the repository root.",
      "at the repository root. The owner pays a bounty for each Critical fault.",
    );
    expect(failures(bounty)).toEqual([
      'docs/reference/security-policy.md, section "The policy", states "The owner pays a bounty for each Critical fault.", which no source holds',
    ]);
    // Neither section takes a pointer sentence.
    const pointer = withText(
      "securityPage",
      "at the repository root.",
      "at the repository root. Read [Versioning policy](/docs/versioning/).",
    );
    expect(failures(pointer)).toEqual([
      'docs/reference/security-policy.md, section "The policy", states "Read [Versioning policy](/docs/versioning/).", which no source holds',
    ]);
  });

  it("fails a missing link", () => {
    expect(failures(withText("securityPage", "](/security/)", "](/docs/)"))).toEqual([
      'docs/reference/security-policy.md, section "The policy", states "The full policy is on the [security page](/docs/) of this site, and in [SECURITY.md](https://github.com/BirdTempo/authtempo/blob/main/SECURITY.md) at the repository root.", which no source holds',
      'docs/reference/security-policy.md, section "The policy", does not link /security/',
    ]);
    const other = withText(
      "securityPage",
      "](https://github.com/BirdTempo/authtempo/blob/main/SECURITY.md)",
      "](https://github.com/someone/authtempo/blob/main/SECURITY.md)",
    );
    expect(failures(other)).toEqual([
      'docs/reference/security-policy.md, section "The policy", states "The full policy is on the [security page](/security/) of this site, and in [SECURITY.md](https://github.com/someone/authtempo/blob/main/SECURITY.md) at the repository root.", which no source holds',
      'docs/reference/security-policy.md, section "The policy", does not link https://github.com/BirdTempo/authtempo/blob/main/SECURITY.md',
    ]);
    expect(
      failures(
        withText(
          "versioning",
          "Read [Security policy](/docs/reference/security-policy/).\n",
          "Read [Security policy](/security/).\n",
        ),
      ),
    ).toEqual([
      'docs/versioning.md, section "The support window", does not link /docs/reference/security-policy/',
    ]);
  });

  it("fails when a file is missing or a section is gone", () => {
    const empty = readPolicyPagesInput((path) =>
      path.endsWith("versioning.md") ? null : readRepoFile(path),
    );
    expect(empty.failures).toEqual(["apps/site/src/content/docs/docs/versioning.md is missing"]);
    const r = checkPolicyPages(empty.input);
    expect(summaryLine(r)).toMatch(/^check-policy-pages: FAIL pages=1 /);
    const gone = withText("securityPage", "## The times\n", "## Times\n");
    expect(failures(gone)).toContain(
      'docs/reference/security-policy.md has no section "The times"',
    );
  });
});
