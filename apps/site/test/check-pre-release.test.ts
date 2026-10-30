import { SCHEMA_VERSION } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { checkPreRelease, type PreReleaseInput } from "../scripts/check-pre-release.ts";
import {
  checkSecurityPolicy,
  readPolicyInput,
  type SupportRow,
} from "../scripts/check-security-policy.ts";
import { docsPages, readRepoFile } from "../scripts/lib/load.ts";
import { summaryLine } from "../scripts/lib/report.ts";
import { SITE } from "../src/data/site.ts";
import {
  PRE_RELEASE_PATTERN,
  PRE_RELEASE_SENTENCES,
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
    expect(core.version).toBe("0.0.0");
    const r = checkPreRelease(inputOf(core.version, realTexts()));
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toMatch(
      new RegExp(
        `^check-pre-release: PASS listed=${PRE_RELEASE_SENTENCES.length} files=\\d+ pages=\\d+ present=${PRE_RELEASE_SENTENCES.length} failures=0$`,
      ),
    );
  });

  it("fails each listed text that its file lacks at 0.0.0, one probe per text", () => {
    const texts = realTexts();
    for (const e of PRE_RELEASE_SENTENCES) {
      const gone = new Map(texts).set(e.file, (texts.get(e.file) ?? "").replace(e.sentence, ""));
      expect(failures(inputOf("0.0.0", gone)), e.sentence).toEqual([
        `${e.file}: core is at 0.0.0, and the file lacks the text: ${e.sentence}`,
      ]);
    }
  });

  it("fails each listed text that its file still holds above 0.0.0, one probe per text", () => {
    const texts = realTexts();
    expect(failures(inputOf("0.1.0", without(texts)))).toEqual([]);
    for (const e of PRE_RELEASE_SENTENCES)
      expect(failures(inputOf("0.1.0", without(texts, e))), e.sentence).toEqual([
        `${e.file}: core is at 0.1.0, and the file still holds the text: ${e.sentence}`,
      ]);
    expect(failures(inputOf("0.1.0", texts))).toHaveLength(PRE_RELEASE_SENTENCES.length);
  });

  it("fails a text of the pattern that the list lacks, in any case and at every version", () => {
    const texts = realTexts();
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

  it("fails a listed file that does not exist, a text listed twice, and an empty read", () => {
    const [first] = PRE_RELEASE_SENTENCES;
    if (first === undefined) throw new Error("PRE_RELEASE_SENTENCES is empty");
    const input = inputOf("0.0.0", realTexts());
    expect(
      failures({
        ...input,
        listed: [...PRE_RELEASE_SENTENCES, first, { file: "docs/gone.md", sentence: "x" }],
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
    const block = files
      .flatMap((file) => [
        file,
        ...PRE_RELEASE_SENTENCES.filter((e) => e.file === file).map((e) => `  ${e.sentence}`),
      ])
      .join("\n");
    expect(fences.map((f) => f.body)).toContain(`${block}\n`);
    expect(part).toContain("- `check-pre-release`: remove each text of `PRE_RELEASE_SENTENCES`");
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
    // SECURITY.md after the edits: the table in the place of the first text, and no other text.
    const [support, ...others] = PRE_RELEASE_SENTENCES.filter((e) => e.file === "SECURITY.md");
    if (support === undefined)
      throw new Error("PRE_RELEASE_SENTENCES names no text of SECURITY.md");
    const policy = readPolicyInput(readRepoFile);
    let text = (policy.text ?? "").replace(support.sentence, table.body.trimEnd());
    for (const e of others) text = text.replace(`${e.sentence}\n\n`, "");
    const check = (t: string, r: readonly SupportRow[]) =>
      checkSecurityPolicy({ text: t, rows: r, repository: policy.repository, origin: SITE.origin })
        .failures;
    expect(check(text, rows)).toEqual([]);
    // The quotes are evidence only while each half fails alone.
    expect(check(text, [])).not.toEqual([]);
    expect(check(policy.text ?? "", rows)).not.toEqual([]);
  });
});
