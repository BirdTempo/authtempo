import { describe, expect, it } from "vitest";
import {
  checkPolicyPages,
  type PolicyPagesInput,
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

describe("check-policy-pages", () => {
  it("passes the real pages", () => {
    expect(real.failures).toEqual([]);
    expect(REAL.coreVersion).toBe("0.0.0");
    expect(REAL.repository.url).toBe("https://github.com/authtempo/authtempo");
    const r = checkPolicyPages(REAL);
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe(
      "check-policy-pages: PASS pages=2 ties=18 states=3 rows=5 links=3 failures=0",
    );
  });

  it("fails a copy that differs from SECURITY.md", () => {
    const input = withText("versioning", "for 3 months after", "for 6 months after");
    expect(failures(input)).toEqual([
      'docs/versioning.md, section "The support window", does not state: The previous minor gets security fixes for 3 months after the next minor ships. (from SECURITY.md, section "Supported versions")',
      'docs/versioning.md, section "The support window", states "The previous minor gets security fixes for 6 months after the next minor ships.", which no source holds',
    ]);
    expect(summaryLine(checkPolicyPages(input))).toBe(
      "check-policy-pages: FAIL pages=2 ties=18 states=3 rows=5 links=3 failures=2",
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

  it("holds the closed channels to SECURITY.md both ways", () => {
    const closed =
      "Until the first release, the two channels are not open, and the times of this policy do not apply.";
    // The page drops the sentence while SECURITY.md keeps it.
    expect(failures(withText("securityPage", `${closed}\n`, ""))).toEqual([
      `docs/reference/security-policy.md, section "How to report", does not state: ${closed} (from SECURITY.md, section "How to report")`,
    ]);
    // SECURITY.md drops the sentence at the first release, and the page keeps it.
    expect(failures(withText("security", `${closed}\n`, ""))).toEqual([
      `docs/reference/security-policy.md, section "How to report", states "${closed}", which no source holds`,
    ]);
  });

  it("holds the support window state to SECURITY.md both ways", () => {
    const none = "No release exists yet. The first minor is the current minor at its release.";
    expect(failures(withText("security", `${none}\n`, ""))).toEqual([
      'docs/versioning.md, section "The support window", states "No release exists yet.", which no source holds',
      'docs/versioning.md, section "The support window", states "The first minor is the current minor at its release.", which no source holds',
    ]);
    expect(failures(withText("versioning", `${none}\n`, ""))).toEqual([
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
    expect(failures({ ...REAL, coreVersion: "0.1.0" })).toEqual([
      'packages/core/package.json is at 0.1.0, so docs/versioning.md must not have the section "The versions today"',
    ]);
    const today =
      "## The versions today\n\nEvery package is private and at version `0.0.0`. No release exists, and the owner decides when the packages publish.\n\n";
    expect(failures(withText("versioning", today, ""))).toEqual([
      'packages/core/package.json is at 0.0.0, so docs/versioning.md, section "The versions today", must state: Every package is private and at version `0.0.0`. No release exists, and the owner decides when the packages publish.',
    ]);
    // The heading stays and the text changes.
    const changed = withText(
      "versioning",
      "Every package is private and at",
      "Every package is at",
    );
    expect(failures(changed)).toEqual([
      'packages/core/package.json is at 0.0.0, so docs/versioning.md, section "The versions today", must state: Every package is private and at version `0.0.0`. No release exists, and the owner decides when the packages publish.',
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
      ["checkChangesets", "scripts/release/src/check-changesets.ts"],
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

  it("holds the In 0.x column to the From 1.0.0 column", () => {
    const input = withText(
      "versioning",
      "| A new error code | A minor version | A minor version |",
      "| A new error code | A patch version | A minor version |",
    );
    expect(failures(input)).toEqual([
      'docs/versioning.md: the row "A new error code" gives "A patch version" in 0.x; from 1.0.0 it gives "A minor version", so in 0.x it must give "A minor version"',
    ]);
    const major = withText(
      "versioning",
      "| A minor version, with a `Breaking:` line in its changeset | A major version |",
      "| A major version | A major version |",
    );
    expect(failures(major)).toEqual([
      'docs/versioning.md: the row "A change that breaks a caller: a removed export, a changed answer, a removed route" gives "A major version" in 0.x; from 1.0.0 it gives "A major version", so in 0.x it must give "A minor version, with a `Breaking:` line in its changeset"',
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

  it("fails a missing link", () => {
    expect(failures(withText("securityPage", "](/security/)", "](/docs/)"))).toEqual([
      'docs/reference/security-policy.md, section "The policy", does not link /security/',
    ]);
    const other = withText(
      "securityPage",
      "](https://github.com/authtempo/authtempo/blob/main/SECURITY.md)",
      "](https://github.com/someone/authtempo/blob/main/SECURITY.md)",
    );
    expect(failures(other)).toEqual([
      'docs/reference/security-policy.md, section "The policy", does not link https://github.com/authtempo/authtempo/blob/main/SECURITY.md',
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
