import { describe, expect, it } from "vitest";
import {
  checkSecurityPolicy,
  readPolicyInput,
  SECURITY_SECTIONS,
  type SupportRow,
} from "../scripts/check-security-policy.ts";
import { readRepoFile } from "../scripts/lib/load.ts";
import { summaryLine } from "../scripts/lib/report.ts";
import { SITE } from "../src/data/site.ts";

// The real files of the tree: SECURITY.md, release/support.json, and
// release/repository.json (plan 12j Task 12, spec 33 item 7).
const real = readPolicyInput(readRepoFile);
const TEXT = real.text ?? "";
const REPOSITORY = {
  url: "https://github.com/authtempo/authtempo",
  owner: "authtempo",
  name: "authtempo",
};
/** The origin of the site. check.ts passes SITE.origin; the test types the value. */
const ORIGIN = "https://authtempo.com";

const check = (text: string, rows: readonly SupportRow[] = []) =>
  checkSecurityPolicy({ text, rows, repository: REPOSITORY, origin: ORIGIN });

/** The real text with one part replaced. Each break replaces one whole part, as a person would. */
const textWith = (from: string, to: string) => {
  expect(TEXT).toContain(from);
  return TEXT.replace(from, to);
};

/** The text of one `## ` section of the real file, with its heading. */
const sectionText = (heading: string) => {
  const start = TEXT.indexOf(`## ${heading}\n`);
  expect(start).toBeGreaterThan(-1);
  const end = TEXT.indexOf("\n## ", start + 1);
  return TEXT.slice(start, end === -1 ? undefined : end + 1);
};

describe("check-security-policy", () => {
  it("passes the real file", () => {
    expect(SECURITY_SECTIONS).toEqual([
      "Supported versions",
      "How to report",
      "The answer time",
      "The disclosure window",
      "The advisory format",
      "Supplier advisories",
      "Out of scope",
    ]);
    expect(real.failures).toEqual([]);
    expect(real.repository).toEqual(REPOSITORY);
    expect(real.rows).toEqual([]);
    const r = checkSecurityPolicy({
      text: TEXT,
      rows: real.rows,
      repository: real.repository,
      origin: SITE.origin,
    });
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe(
      "check-security-policy: PASS sections=7 rows=0 channels=2 failures=0",
    );
  });

  it("fails a missing section", () => {
    const r = check(textWith(sectionText("The disclosure window"), ""));
    expect(r.failures).toEqual([
      'the section "The disclosure window" is missing',
      'the section "The disclosure window" does not state "90 days" (owner decision 4)',
    ]);
    expect(summaryLine(r)).toBe(
      "check-security-policy: FAIL sections=6 rows=0 channels=2 failures=2",
    );
    expect(check(textWith("## Out of scope\n", "## Not ours\n")).failures).toEqual([
      'the section "Out of scope" is missing',
      'the section "Not ours" is not a section of the policy',
    ]);
  });

  it("fails a text that it reads nothing in", () => {
    expect(summaryLine(check(""))).toBe(
      "check-security-policy: FAIL sections=0 rows=0 channels=0 failures=18",
    );
    expect(check("").failures.slice(-2)).toEqual(["read 0 sections", "read 0 channels"]);
  });

  it("fails a file that it could not read", () => {
    const files: Record<string, string> = {
      "release/support.json": "{",
      "release/repository.json": '{"url":"https://github.com/authtempo/authtempo"}',
    };
    const input = readPolicyInput((path) => files[path] ?? null);
    expect(input.text).toBeNull();
    expect(input.failures).toEqual([
      "SECURITY.md is missing",
      "release/support.json is not JSON",
      "release/repository.json needs url, owner, and name",
    ]);
    files["release/support.json"] = "{}";
    delete files["release/repository.json"];
    expect(readPolicyInput((path) => files[path] ?? null).failures).toEqual([
      "SECURITY.md is missing",
      "release/support.json is not an array",
      "release/repository.json is missing",
    ]);
  });

  it("fails sections out of order", () => {
    const answer = sectionText("The answer time");
    const disclosure = sectionText("The disclosure window");
    const swapped = textWith(`${answer}${disclosure}`, `${disclosure}${answer}`);
    expect(check(swapped).failures).toEqual([
      "the sections are out of order: Supported versions, How to report, The disclosure window, The answer time, The advisory format, Supplier advisories, Out of scope",
    ]);
  });

  it("fails a support table that differs from support.json", () => {
    const rowLine = "| 0.1 | current | 2026-11-02 | none | 11 |";
    const table = `| Minor | Status | Released | Security fixes until | Schema versions |\n| --- | --- | --- | --- | --- |\n${rowLine}\n`;
    const noRelease =
      "No release exists yet. The first minor is the current minor at its release.\n";
    // A table row while release/support.json is [].
    expect(check(textWith(noRelease, `${table}`)).failures).toEqual([
      "the support table differs from release/support.json: it has 1 row and release/support.json has 0",
      'release/support.json is [], so the section "Supported versions" must state: No release exists yet. The first minor is the current minor at its release.',
    ]);
    // The table of a release, against a support.json with one row.
    const row: SupportRow = {
      minor: "0.1",
      status: "current",
      released: "2026-11-02",
      schemaFrom: [11],
    };
    const closed =
      "Until the first release, the two channels are not open, and the times of this policy do not apply.\n\n";
    const released = textWith(noRelease, table).replace(closed, "");
    expect(check(released, [row]).failures).toEqual([]);
    expect(check(released, [{ ...row, schemaFrom: [10, 11] }]).failures).toEqual([
      "the support table differs from release/support.json: row 1 is | 0.1 | current | 2026-11-02 | none | 11 |; release/support.json gives | 0.1 | current | 2026-11-02 | none | 10, 11 |",
    ]);
    // The statement of the empty table stays only while no release exists.
    expect(check(released.replace(table, `${table}\n${noRelease}`), [row]).failures).toEqual([
      'release/support.json has 1 row, so the section "Supported versions" must not state: No release exists yet. The first minor is the current minor at its release.',
    ]);
  });

  it("states that the channels are not open before the first release, and only then", () => {
    const closed =
      "Until the first release, the two channels are not open, and the times of this policy do not apply.\n\n";
    expect(check(textWith(closed, "")).failures).toEqual([
      'release/support.json is [], so the section "How to report" must state: Until the first release, the two channels are not open, and the times of this policy do not apply.',
    ]);
    const rowLine = "| 0.1 | current | 2026-11-02 | none | 11 |";
    const table = `| Minor | Status | Released | Security fixes until | Schema versions |\n| --- | --- | --- | --- | --- |\n${rowLine}\n`;
    const released = textWith(
      "No release exists yet. The first minor is the current minor at its release.\n",
      table,
    );
    const row: SupportRow = {
      minor: "0.1",
      status: "current",
      released: "2026-11-02",
      schemaFrom: [11],
    };
    expect(check(released, [row]).failures).toEqual([
      'release/support.json has 1 row, so the section "How to report" must not state: Until the first release, the two channels are not open, and the times of this policy do not apply.',
    ]);
  });

  it("fails a placeholder channel", () => {
    const advisory = "https://github.com/authtempo/authtempo/security/advisories/new";
    const mail = "mailto:security@authtempo.com";
    expect(check(textWith(mail, "mailto:security@example.com")).failures).toEqual([
      'SECURITY.md holds the placeholder "example.com"',
      "the second channel is mailto:security@example.com; it must be mailto:security@authtempo.com, at the host of https://authtempo.com",
    ]);
    expect(
      check(textWith("Do not open a public issue", "TODO: Do not open a public issue")).failures,
    ).toEqual(['SECURITY.md holds the placeholder "TODO"']);
    expect(
      check(textWith(advisory, "https://github.com/<owner>/<name>/security/advisories/new"))
        .failures,
    ).toEqual([
      'SECURITY.md holds the placeholder "<"',
      "SECURITY.md links the repository <owner>/<name>; release/repository.json names authtempo/authtempo",
      "the first channel is https://github.com/<owner>/<name>/security/advisories/new; it must be https://github.com/authtempo/authtempo/security/advisories/new, from release/repository.json",
    ]);
    expect(
      check(textWith(advisory, "https://github.com/someone/fork/security/advisories/new")).failures,
    ).toEqual([
      "SECURITY.md links the repository someone/fork; release/repository.json names authtempo/authtempo",
      "the first channel is https://github.com/someone/fork/security/advisories/new; it must be https://github.com/authtempo/authtempo/security/advisories/new, from release/repository.json",
    ]);
    // The same owner with another name is another repository.
    expect(
      check(textWith(advisory, "https://github.com/authtempo/other/security/advisories/new"))
        .failures,
    ).toEqual([
      "SECURITY.md links the repository authtempo/other; release/repository.json names authtempo/authtempo",
      "the first channel is https://github.com/authtempo/other/security/advisories/new; it must be https://github.com/authtempo/authtempo/security/advisories/new, from release/repository.json",
    ]);
    // A third channel, or one channel only.
    expect(
      check(textWith(`(${mail})`, `(${mail}) or [the chat](https://chat.authtempo.com/)`)).failures,
    ).toEqual(['the section "How to report" names 3 channels; it must name 2']);
  });

  it("takes the host of the mailbox from the origin of the site", () => {
    const other = (text: string) =>
      checkSecurityPolicy({
        text,
        rows: [],
        repository: REPOSITORY,
        origin: "https://auth.example.org",
      });
    // The real file names the mailbox of authtempo.com, so another origin fails it.
    expect(other(TEXT).failures).toEqual([
      "the second channel is mailto:security@authtempo.com; it must be mailto:security@auth.example.org, at the host of https://auth.example.org",
    ]);
    const moved = textWith(
      "[security@authtempo.com](mailto:security@authtempo.com)",
      "[security@auth.example.org](mailto:security@auth.example.org)",
    );
    expect(other(moved).failures).toEqual([]);
  });

  it("states the times of decision 4", () => {
    for (const text of ["72 hours", "7 days", "90 days"]) expect(TEXT).toContain(text);
    expect(check(textWith("within 72 hours", "within 96 hours")).failures).toEqual([
      'the section "The answer time" does not state "72 hours" (owner decision 4)',
    ]);
    expect(check(textWith("within 7 days", "within 10 days")).failures).toEqual([
      'the section "The answer time" does not state "7 days" (spec 33 item 7)',
    ]);
    expect(check(textWith("within 14 days", "within 30 days")).failures).toEqual([
      'the section "The answer time" does not state "14 days" (spec 33 item 7)',
    ]);
    expect(check(textWith("severity by CVSS 4.0.", "severity.")).failures).toEqual([
      'the section "The answer time" does not state "CVSS 4.0" (spec 33 item 7)',
    ]);
    expect(check(textWith("90 days after", "120 days after")).failures).toEqual([
      'the section "The disclosure window" does not state "90 days" (owner decision 4)',
    ]);
  });

  it("links the advisory record of the repository", () => {
    const link = "https://github.com/authtempo/authtempo/blob/main/docs/security/advisories.md";
    expect(
      check(textWith(link, "https://github.com/authtempo/authtempo/blob/main/docs/advisories.md"))
        .failures,
    ).toEqual([`the section "Supplier advisories" does not link ${link}`]);
  });
});
