import { describe, expect, it } from "vitest";
import { checkSentences } from "../scripts/check-sentences.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const page = (text: string) => ({ path: "docs/a.md", source: `---\ntitle: A\n---\n${text}\n` });

describe("checkSentences", () => {
  it("passes 25 words in a sentence and 20 in a numbered step", () => {
    const r = checkSentences([page(`${words(25)}.\n\n1. ${words(20)}.`)]);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, sentences: 2 });
  });

  it("refuses 26 words in a sentence and 21 in a numbered step", () => {
    const r = checkSentences([page(`${words(26)}.\n\n1. ${words(21)}.`)]);
    expect(r.failures).toEqual([
      'docs/a.md:4: 26 words in a sentence (at most 25): "w0 w1 w2 w3 w4 w5 w6 w7 …"',
      'docs/a.md:6: 21 words in a numbered step (at most 20): "w0 w1 w2 w3 w4 w5 w6 w7 …"',
    ]);
  });

  it("counts a code span as one word and skips tables, headings, and fences", () => {
    const r = checkSentences([
      page(
        `${words(24)} \`one two three\`.\n\n| ${words(40)} |\n\n## ${words(30)}\n\n\`\`\`text\n${words(40)}.\n\`\`\``,
      ),
    ]);
    expect(r.failures).toEqual([]);
    expect(r.counts.sentences).toBe(1);
  });

  it("fails when it reads no sentence", () => {
    expect(checkSentences([]).failures).toEqual(["read 0 pages", "read 0 sentences"]);
  });
});
