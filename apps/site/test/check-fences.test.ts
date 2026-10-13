import { describe, expect, it } from "vitest";
import { checkFences } from "../scripts/check-fences.ts";
import { DOCS, SITE } from "../scripts/lib/paths.ts";

const sample = `${SITE}samples/guides/a.ts`;
const exists = (p: string) => p === sample;
const mdx = (text: string) => ({
  path: "docs/guides/a.mdx",
  source: `---\ntitle: A\n---\n${text}\n`,
});
const include = 'import a from "../../../../../samples/guides/a.ts?raw";';

describe("checkFences", () => {
  it("passes a shell fence and an include of a sample that exists", () => {
    const r = checkFences([mdx(`${include}\n\n\`\`\`sh\npnpm test\n\`\`\``)], [sample], exists);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, fences: 1, includes: 1, samples: 1 });
  });

  it("refuses a ts fence and a fence with no language", () => {
    const r = checkFences(
      [mdx(`${include}\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n\`\`\`\nx\n\`\`\``)],
      [sample],
      exists,
    );
    expect(r.failures).toEqual([
      "docs/guides/a.mdx:6: a ts fence; a code sample is a file included with ?raw",
      "docs/guides/a.mdx:10: a fence must name one of sh, json, jsonc, http, text",
    ]);
  });

  it("refuses an include whose file does not exist", () => {
    const r = checkFences([mdx(include.replace("a.ts", "b.ts"))], [sample], exists);
    expect(r.failures).toEqual([
      `docs/guides/a.mdx: includes ${SITE}samples/guides/b.ts, which does not exist`,
      `samples/guides/a.ts: no page includes it`,
    ]);
  });

  it("fails when no page includes a sample", () => {
    expect(checkFences([], [], exists).failures).toEqual(["read 0 pages", "read 0 includes"]);
    expect(DOCS.startsWith(SITE)).toBe(true);
  });
});
