import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// docs/security/advisories.md names the tests that hold each answer. Ruling
// 46 of plan 12j renamed two of them, and the record kept the old names
// with no check that saw it (ruling 64 of plan 12j, Minor 2). This test
// holds each cited name to a test title of its file. The record is
// append-only, so a rename passes only through a later entry that names it.
const ROOT = new URL("../../../", import.meta.url);
const RECORD = "docs/security/advisories.md";

/** One bullet of an entry with its indented lines. */
interface Block {
  entry: number;
  lines: string[];
}

/** The top-level bullets of each `## ` entry, each with its indented lines. */
function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let entry = -1;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) entry++;
    else if (entry >= 0 && line.startsWith("- ")) blocks.push({ entry, lines: [line] });
    else if (entry >= 0 && /^\s+\S/.test(line) && blocks.length > 0)
      blocks[blocks.length - 1]?.lines.push(line);
  }
  return blocks;
}

/** The test files that a block names: a full path, or a folder and a file name. */
function filesOf(block: Block): string[] {
  const spans = block.lines.flatMap((l) => [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));
  const folder = spans.find((s) => s.endsWith("/test/")) ?? "";
  return spans
    .filter((s) => s.endsWith(".test.ts"))
    .map((s) => (s.includes("/") ? s : `${folder}${s}`));
}

/** A block that cites the tests of an answer. */
const CITES = /^- The tests? that holds? the answer\b/;
/** A block of a correction that names a renamed test. */
const RENAMES = /^- The renamed tests\b/;
/** One renamed test: its old name and its name now. */
const RENAME = /^\s+- "(.+)" is now "(.+)"\.$/;

/**
 * The fault of each cited test name: a file that does not exist, or a name
 * that no named file holds as a string, with no rename in a later entry.
 * `read` gives the text of a file, or null when it does not exist.
 */
function citeFaults(text: string, read: (path: string) => string | null): string[] {
  const faults: string[] = [];
  const blocks = blocksOf(text);
  const holds = (files: string[], name: string) =>
    files.some((f) => {
      const source = read(f);
      return (
        source !== null && [`"${name}"`, `'${name}'`, `\`${name}\``].some((q) => source.includes(q))
      );
    });
  const renames = blocks
    .filter((b) => RENAMES.test(b.lines[0] ?? ""))
    .flatMap((b) =>
      b.lines.flatMap((l) => {
        const m = RENAME.exec(l);
        return m === null
          ? []
          : [{ entry: b.entry, from: m[1] ?? "", to: m[2] ?? "", files: filesOf(b) }];
      }),
    );
  for (const r of renames)
    if (!holds(r.files, r.to))
      faults.push(`entry ${r.entry + 1}: no file holds the test "${r.to}"`);
  let cited = 0;
  for (const block of blocks.filter((b) => CITES.test(b.lines[0] ?? ""))) {
    const files = filesOf(block);
    if (files.length === 0)
      faults.push(`entry ${block.entry + 1}: a block cites tests and names no test file`);
    for (const f of files)
      if (read(f) === null) faults.push(`entry ${block.entry + 1}: ${f} does not exist`);
    const names = block.lines.flatMap((l) => [...l.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""));
    for (const name of names) {
      cited++;
      if (holds(files, name)) continue;
      if (renames.some((r) => r.from === name && r.entry > block.entry && holds(r.files, r.to)))
        continue;
      faults.push(
        `entry ${block.entry + 1}: no named file holds the test "${name}", and no later entry renames it`,
      );
    }
  }
  if (cited === 0) faults.push("read 0 cited test names");
  return faults;
}

const readRepo = (path: string): string | null => {
  const url = new URL(path, ROOT);
  return existsSync(url) ? readFileSync(url, "utf8") : null;
};

describe(RECORD, () => {
  it("cites only test names that a test file holds, or that a later entry renames", () => {
    const text = readFileSync(new URL(RECORD, ROOT), "utf8");
    expect(citeFaults(text, readRepo)).toEqual([]);
    // The record cites the tests of four entries.
    const cites = blocksOf(text).filter((b) =>
      /^- The tests? that holds? the answer\b/.test(b.lines[0] ?? ""),
    );
    expect(new Set(cites.map((b) => b.entry)).size).toBe(4);
  });

  it("fails a cited name that no file holds, and a rename in an earlier entry", () => {
    const file = "packages/x/test/a.test.ts";
    const read = (p: string) => (p === file ? 'it("now", () => {});\n' : null);
    const cite = `## 1\n\n- The test that holds the answer: "old" in \`${file}\`.\n`;
    expect(citeFaults(cite, read)).toEqual([
      'entry 1: no named file holds the test "old", and no later entry renames it',
    ]);
    const rename = `## 2\n\n- The renamed tests, in \`${file}\`:\n  - "old" is now "now".\n`;
    expect(citeFaults(`${cite}\n${rename}`, read)).toEqual([]);
    // A rename before the cite does not cover it, and a rename to a name that no file holds fails.
    expect(
      citeFaults(`${rename.replace("## 2", "## 0")}\n${cite.replace("## 1", "## 1b")}`, read),
    ).toEqual(['entry 2: no named file holds the test "old", and no later entry renames it']);
    expect(citeFaults(`${cite}\n${rename.replace('"now"', '"gone"')}`, read)).toEqual([
      'entry 2: no file holds the test "gone"',
      'entry 1: no named file holds the test "old", and no later entry renames it',
    ]);
    expect(citeFaults("## 1\n\n- The test that holds the answer: none.\n", read)).toEqual([
      "entry 1: a block cites tests and names no test file",
      "read 0 cited test names",
    ]);
  });
});
