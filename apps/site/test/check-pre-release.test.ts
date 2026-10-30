import { readFileSync } from "node:fs";
import { SCHEMA_VERSION } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { checkPreRelease, type PreReleaseInput } from "../scripts/check-pre-release.ts";
import {
  checkSecurityPolicy,
  readPolicyInput,
  type SupportRow,
  supportTable,
} from "../scripts/check-security-policy.ts";
import { docsPages, readRepoFile } from "../scripts/lib/load.ts";
import { SITE as SITE_DIR } from "../scripts/lib/paths.ts";
import { summaryLine } from "../scripts/lib/report.ts";
import { SITE } from "../src/data/site.ts";
import {
  PRE_RELEASE_EXEMPT,
  PRE_RELEASE_PATTERN,
  PRE_RELEASE_SENTENCES,
  type PreReleaseExempt,
  type PreReleaseSentence,
} from "../src/data/unpublished.ts";

const DOCS_DIR = "apps/site/src/content/docs/";
const core = JSON.parse(readRepoFile("packages/core/package.json") ?? "{}") as { version: string };

/** The real texts: each docs page and each listed file, by its repository path. */
function realTexts(): Map<string, string> {
  const texts = new Map(docsPages().map((p) => [`${DOCS_DIR}${p.path}`, p.source]));
  for (const { file } of PRE_RELEASE_SENTENCES) {
    const text = readRepoFile(file);
    if (text === null) throw new Error(`${file} does not exist`);
    texts.set(file, text);
  }
  return texts;
}

/**
 * A tree before the first release, for the probes: each listed file holds its
 * listed texts, one paragraph each, and nothing else. The version branch
 * removes each text from the real tree, so a probe on it fails there (ruling
 * 65 of plan 12j, C1). The first test holds the real tree at its version.
 */
function fixtureTexts(): Map<string, string> {
  const texts = new Map<string, string>();
  for (const { file, sentence } of PRE_RELEASE_SENTENCES)
    texts.set(file, `${texts.get(file) ?? "# A fixture\n"}\n${sentence}\n`);
  return texts;
}

/** The input of a version over some texts. */
function inputOf(version: string, texts: ReadonlyMap<string, string>): PreReleaseInput {
  return {
    version,
    listed: PRE_RELEASE_SENTENCES,
    read: (path) => texts.get(path) ?? null,
    pages: [...texts]
      .filter(([path]) => path.startsWith(DOCS_DIR))
      .map(([path, source]) => ({ path: path.slice(DOCS_DIR.length), source })),
    pattern: PRE_RELEASE_PATTERN,
    exempt: PRE_RELEASE_EXEMPT,
  };
}

/** The texts with each listed text removed, but `keep`. */
function without(
  texts: ReadonlyMap<string, string>,
  keep?: PreReleaseSentence,
): Map<string, string> {
  const out = new Map(texts);
  for (const e of PRE_RELEASE_SENTENCES)
    if (e !== keep) out.set(e.file, (out.get(e.file) ?? "").replace(e.sentence, ""));
  return out;
}

const failures = (input: PreReleaseInput) => checkPreRelease(input).failures;

describe("check-pre-release", () => {
  it("passes the real tree at the version of core", () => {
    const r = checkPreRelease(inputOf(core.version, realTexts()));
    expect(r.failures).toEqual([]);
    // Each listed text is present at 0.0.0, and none is above it.
    const present = core.version === "0.0.0" ? PRE_RELEASE_SENTENCES.length : 0;
    expect(summaryLine(r)).toMatch(
      new RegExp(
        `^check-pre-release: PASS listed=${PRE_RELEASE_SENTENCES.length} files=\\d+ pages=\\d+ present=${present} exempt=${PRE_RELEASE_EXEMPT.length} failures=0$`,
      ),
    );
  });

  it("passes the fixture tree at 0.0.0, and fails each of its texts above 0.0.0", () => {
    const texts = fixtureTexts();
    expect(failures(inputOf("0.0.0", texts))).toEqual([]);
    expect(failures(inputOf("0.1.0", texts))).toHaveLength(PRE_RELEASE_SENTENCES.length);
  });

  it("fails each listed text that its file lacks at 0.0.0, one probe per text", () => {
    const texts = fixtureTexts();
    for (const e of PRE_RELEASE_SENTENCES) {
      const gone = new Map(texts).set(e.file, (texts.get(e.file) ?? "").replace(e.sentence, ""));
      expect(failures(inputOf("0.0.0", gone)), e.sentence).toEqual([
        `${e.file}: core is at 0.0.0, and the file lacks the text: ${e.sentence}`,
      ]);
    }
  });

  it("fails each listed text that its file still holds above 0.0.0, one probe per text", () => {
    const texts = fixtureTexts();
    expect(failures(inputOf("0.1.0", without(texts)))).toEqual([]);
    for (const e of PRE_RELEASE_SENTENCES)
      expect(failures(inputOf("0.1.0", without(texts, e))), e.sentence).toEqual([
        `${e.file}: core is at 0.1.0, and the file still holds the text: ${e.sentence}`,
      ]);
    expect(failures(inputOf("0.1.0", texts))).toHaveLength(PRE_RELEASE_SENTENCES.length);
  });

  it("fails a text of the pattern that the list lacks, in any case and at every version", () => {
    const texts = fixtureTexts();
    const page = `${DOCS_DIR}docs/resources.md`;
    const added = new Map(texts).set(
      page,
      `${texts.get(page)}\nUNTIL THE FIRST RELEASE, read the repo.\n`,
    );
    const line = (added.get(page) ?? "").split("\n").length - 1;
    const want = `${page}:${line}: holds "UNTIL THE FIRST RELEASE", and PRE_RELEASE_SENTENCES lacks its text: UNTIL THE FIRST RELEASE, read the repo.`;
    expect(failures(inputOf("0.0.0", added))).toEqual([want]);
    expect(failures(inputOf("0.1.0", without(added)))).toEqual([want]);
    // A listed file that is not a docs page counts too.
    const data = "apps/site/src/data/compare.ts";
    const more = new Map(texts).set(data, `${texts.get(data)}\n// No release date.\n`);
    expect(failures(inputOf("0.0.0", more))).toEqual([
      `${data}:${(more.get(data) ?? "").split("\n").length - 1}: holds "No release", and PRE_RELEASE_SENTENCES lacks its text: // No release date.`,
    ]);
  });

  // Ruling 58 of plan 12j, item 5: the words of the README install line and of the owner check.
  it("fails a text with before or after the first release that the list lacks", () => {
    const texts = fixtureTexts();
    const page = `${DOCS_DIR}docs/resources.md`;
    for (const words of ["Before the first release", "AFTER THE FIRST RELEASE"]) {
      const added = new Map(texts).set(page, `${texts.get(page)}\n${words}, read the repo.\n`);
      const line = (added.get(page) ?? "").split("\n").length - 1;
      const want = `${page}:${line}: holds "${words}", and PRE_RELEASE_SENTENCES lacks its text: ${words}, read the repo.`;
      expect(failures(inputOf("0.0.0", added)), words).toEqual([want]);
      expect(failures(inputOf("0.1.0", without(added))), words).toEqual([want]);
    }
  });

  it("passes a text of PRE_RELEASE_EXEMPT at every version, and holds each entry", () => {
    const texts = fixtureTexts();
    const page = `${DOCS_DIR}docs/resources.md`;
    const text = "The upgrade command works after the first release.";
    const added = new Map(texts).set(page, `${texts.get(page)}\n${text}\n`);
    const entry: PreReleaseExempt = { file: page, text, reason: "true at every version" };
    const withEntry = (
      version: string,
      map: ReadonlyMap<string, string>,
      ...exempt: PreReleaseExempt[]
    ) => failures({ ...inputOf(version, map), exempt });
    expect(withEntry("0.0.0", added, entry)).toEqual([]);
    expect(withEntry("0.1.0", without(added), entry)).toEqual([]);
    expect(withEntry("0.0.0", added)).toHaveLength(1);
    expect(
      withEntry(
        "0.0.0",
        texts,
        entry,
        entry,
        { ...entry, text: "A plain line with no match.", reason: " " },
        { file: "SECURITY.md", text: PRE_RELEASE_SENTENCES[1]?.sentence ?? "", reason: "x" },
      ),
    ).toEqual([
      `PRE_RELEASE_EXEMPT names ${page}, which lacks the text: ${text}`,
      `PRE_RELEASE_EXEMPT lists twice, in ${page}: ${text}`,
      `PRE_RELEASE_EXEMPT names ${page}, which lacks the text: ${text}`,
      `PRE_RELEASE_EXEMPT names ${page}, which lacks the text: A plain line with no match.`,
      `PRE_RELEASE_EXEMPT: the text of ${page} has no reason: A plain line with no match.`,
      `PRE_RELEASE_EXEMPT: the text of ${page} does not hold the pattern, so it needs no entry: A plain line with no match.`,
      `SECURITY.md: PRE_RELEASE_SENTENCES and PRE_RELEASE_EXEMPT both list the text: ${PRE_RELEASE_SENTENCES[1]?.sentence}`,
    ]);
  });

  it("fails an exempt entry with an empty text, and ends (rr-r57 of plan 12j)", () => {
    const page = `${DOCS_DIR}docs/resources.md`;
    const input = inputOf("0.0.0", fixtureTexts());
    expect(
      failures({ ...input, exempt: [{ file: page, text: "", reason: "an empty text" }] }),
    ).toEqual([`PRE_RELEASE_EXEMPT: an entry of ${page} has an empty text`]);
  });

  it("fails a listed file that does not exist, a text listed twice, and an empty read", () => {
    const [first] = PRE_RELEASE_SENTENCES;
    if (first === undefined) throw new Error("PRE_RELEASE_SENTENCES is empty");
    const input = inputOf("0.0.0", fixtureTexts());
    expect(
      failures({
        ...input,
        listed: [
          ...PRE_RELEASE_SENTENCES,
          first,
          { file: "docs/gone.md", sentence: "x", published: "" },
        ],
      }),
    ).toEqual([
      "PRE_RELEASE_SENTENCES names docs/gone.md, which does not exist",
      `PRE_RELEASE_SENTENCES lists twice, in ${first.file}: ${first.sentence}`,
    ]);
    expect(failures({ ...input, listed: [], pages: [] })).toEqual([
      "read 0 listed",
      "read 0 pages",
    ]);
  });
});

describe("the quotes of docs/release/RUNBOOK.md", () => {
  const runbook = readRepoFile("docs/release/RUNBOOK.md") ?? "";
  const start = runbook.indexOf("\n### The first release\n");
  const part = runbook.slice(start, runbook.indexOf("\n### ", start + 1));
  /** The fenced blocks of the section "The first release", each with its language. */
  const fences = [...part.matchAll(/^```(\w+)\n([\s\S]*?)^```$/gm)].map((m) => ({
    lang: m[1] ?? "",
    body: m[2] ?? "",
  }));

  it("quotes each text of PRE_RELEASE_SENTENCES under its file, in the order of the list", () => {
    expect(start).toBeGreaterThan(-1);
    const files = [...new Set(PRE_RELEASE_SENTENCES.map((e) => e.file))];
    // Each line of a text, such as a line of a code sample, gets the indent.
    // An empty line, such as one between a paragraph and a list, stays empty.
    const block = files
      .flatMap((file) => [
        file,
        ...PRE_RELEASE_SENTENCES.filter((e) => e.file === file).flatMap((e) =>
          e.sentence.split("\n").map((line) => (line === "" ? "" : `  ${line}`)),
        ),
      ])
      .join("\n");
    expect(fences.map((f) => f.body)).toContain(`${block}\n`);
    // The rewrite script of the release package writes each text with a published form.
    expect(part).toContain("- Run `node scripts/release/src/rewrite-unpublished.ts`.");
    expect(part).toContain("each text of `PRE_RELEASE_SENTENCES` with its published text");
  });

  it("quotes a support row and a table that check-security-policy takes after the edits", () => {
    const json = fences.find((f) => f.lang === "json");
    const table = fences.find((f) => f.lang === "text" && f.body.startsWith("| Minor |"));
    if (json === undefined || table === undefined)
      throw new Error("the runbook lacks the row or the table");
    const rows = JSON.parse(json.body) as SupportRow[];
    const [row] = rows;
    expect(rows).toHaveLength(1);
    // The minor of FIRST_RELEASE, current, from the schema version of core.
    const facts = readRepoFile("scripts/release/src/lib/release-facts.ts") ?? "";
    const first = /^export const FIRST_RELEASE = "(\d+\.\d+)\.\d+";$/m.exec(facts)?.[1];
    expect(row?.minor).toBe(first);
    expect(row?.status).toBe("current");
    expect(row?.schemaFrom).toEqual([SCHEMA_VERSION]);
    // The table is the form that the rehearsal writes from the row (ruling 65 of plan 12j).
    expect(table.body.trimEnd()).toBe(supportTable(rows));
    // SECURITY.md after the edits: the table in the place of the first text, and no other text.
    // The base is SECURITY.md before the first release, a fixture (ruling 65 of plan 12j, C1).
    const [support, ...others] = PRE_RELEASE_SENTENCES.filter((e) => e.file === "SECURITY.md");
    if (support === undefined)
      throw new Error("PRE_RELEASE_SENTENCES names no text of SECURITY.md");
    const policy = {
      ...readPolicyInput(readRepoFile),
      text: readFileSync(`${SITE_DIR}test/fixtures/site/pre-release/SECURITY.md`, "utf8"),
    };
    let text = policy.text.replace(support.sentence, table.body.trimEnd());
    for (const e of others) text = text.replace(`${e.sentence}\n\n`, "");
    const check = (t: string, r: readonly SupportRow[]) =>
      checkSecurityPolicy({ text: t, rows: r, repository: policy.repository, origin: SITE.origin })
        .failures;
    expect(check(text, rows)).toEqual([]);
    // The quotes are evidence only while each half fails alone.
    expect(check(text, [])).not.toEqual([]);
    expect(check(policy.text, rows)).not.toEqual([]);
  });
});
