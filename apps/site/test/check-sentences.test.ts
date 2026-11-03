import { describe, expect, it } from "vitest";
import { checkSentences } from "../scripts/check-sentences.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const page = (text: string) => ({ path: "docs/a.md", source: `---\ntitle: A\n---\n${text}\n` });

describe("checkSentences", () => {
  it("passes 25 words in a sentence and 20 in a numbered step", () => {
    const r = checkSentences([page(`${words(25)}.\n\n1. ${words(20)}.`)]);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, sentences: 2, lists: 0 });
  });

  it("refuses 26 words in a sentence and 21 in a numbered step", () => {
    const r = checkSentences([page(`${words(26)}.\n\n1. ${words(21)}.`)]);
    expect(r.failures).toEqual([
      'docs/a.md:4: 26 words in a sentence (at most 25): "w0 w1 w2 w3 w4 w5 w6 w7 …"',
      'docs/a.md:6: 21 words in a numbered step (at most 20): "w0 w1 w2 w3 w4 w5 w6 w7 …"',
    ]);
  });

  it("counts a code span as one word and skips table headers, headings, and fences", () => {
    const r = checkSentences([
      page(
        `${words(24)} \`one two three\`.\n\n| ${words(40)} |\n| --- |\n\n## ${words(30)}\n\n\`\`\`text\n${words(40)}.\n\`\`\``,
      ),
    ]);
    expect(r.failures).toEqual([]);
    expect(r.counts.sentences).toBe(1);
  });

  // Plan 12n, decision 5: a table cell is a description, so its sentences have the limit 25.
  const table = (cell: string) => page(`| Name | Meaning |\n| --- | --- |\n| \`x\` | ${cell} |`);
  const spans = (n: number) => Array.from({ length: n }, (_, i) => `\`c${i}\``);

  it("passes 25 words in a sentence of a table cell", () => {
    const r = checkSentences([table(`${words(25)}. ${words(3)}.`)]);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, sentences: 3, lists: 0 });
  });

  it("refuses 26 words of prose in a sentence of a table cell, and names its line", () => {
    const r = checkSentences([table(`${words(3)}. ${words(26)}.`)]);
    expect(r.failures).toEqual([
      'docs/a.md:6: 26 words in a table cell (at most 25): "w0 w1 w2 w3 w4 w5 w6 w7 …"',
    ]);
  });

  it("passes a list of 30 code spans in a cell and reports it as exempt", () => {
    const list = `${spans(29).join(", ")}, and \`c29\`.`;
    const r = checkSentences([table(list), table(`[\`c0\`](#c0), ${spans(29).join(" or ")}`)]);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 2, sentences: 4, lists: 2 });
    expect(r.exempt).toEqual([
      "docs/a.md:6: a list of 30 code spans in a table cell",
      "docs/a.md:6: a list of 30 code spans in a table cell",
    ]);
  });

  it("refuses a cell sentence of code spans with one prose word", () => {
    const r = checkSentences([table(`${spans(30).join(", ")} answer.`)]);
    expect(r.failures).toEqual([
      'docs/a.md:6: 31 words in a table cell (at most 25): "CODE, CODE, CODE, CODE, CODE, CODE, CODE, CODE, …"',
    ]);
    expect(r.counts.lists).toBe(0);
  });

  it("reads each cell apart, and an escaped pipe stays in its cell", () => {
    const r = checkSentences([
      page(`| A | B |\n| --- | --- |\n| ${words(20)} | ${words(20)} \\| ${words(10)} |`),
    ]);
    expect(r.failures).toEqual([
      'docs/a.md:6: 30 words in a table cell (at most 25): "w0 w1 w2 w3 w4 w5 w6 w7 …"',
    ]);
    expect(r.counts.sentences).toBe(2);
  });

  it("fails when it reads no sentence", () => {
    expect(checkSentences([]).failures).toEqual(["read 0 pages", "read 0 sentences"]);
  });
});
