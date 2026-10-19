import { describe, expect, it } from "vitest";
import { checkFences } from "../scripts/check-fences.ts";
import { DOCS, REPO, SITE } from "../scripts/lib/paths.ts";

const sample = `${SITE}samples/guides/a.ts`;
const exists = (p: string) => p === sample;
const noImports = () => "";
const mdx = (text: string) => ({
  path: "docs/guides/a.mdx",
  source: `---\ntitle: A\n---\n${text}\n`,
});
const include = 'import a from "../../../../../samples/guides/a.ts?raw";';

describe("checkFences", () => {
  it("passes a shell fence and an include of a sample that exists", () => {
    const r = checkFences(
      [mdx(`${include}\n\n\`\`\`sh\npnpm test\n\`\`\``)],
      [sample],
      exists,
      noImports,
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, fences: 1, includes: 1, samples: 1 });
  });

  it("refuses a ts fence and a fence with no language", () => {
    const r = checkFences(
      [mdx(`${include}\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n\`\`\`\nx\n\`\`\``)],
      [sample],
      exists,
      noImports,
    );
    expect(r.failures).toEqual([
      "docs/guides/a.mdx:6: a ts fence; a code sample is a file included with ?raw",
      "docs/guides/a.mdx:10: a fence must name one of sh, json, jsonc, http, text",
    ]);
  });

  it("refuses an include whose file does not exist", () => {
    const r = checkFences([mdx(include.replace("a.ts", "b.ts"))], [sample], exists, noImports);
    expect(r.failures).toEqual([
      `docs/guides/a.mdx: includes ${SITE}samples/guides/b.ts, which does not exist`,
      `samples/guides/a.ts: no page includes it`,
    ]);
  });

  it("refuses an include from outside samples/", () => {
    const outside = 'import a from "../../../../../scripts/check.ts?raw";';
    const r = checkFences([mdx(`${outside}\n\n${include}`)], [sample], () => true, noImports);
    expect(r.failures).toEqual([
      `docs/guides/a.mdx: includes ${SITE}scripts/check.ts, which is outside samples/ and examples/`,
    ]);
  });

  it("passes an include from the examples/ folder", () => {
    const ex = 'import a from "../../../../../../../examples/worker-d1/src/index.ts?raw";';
    const r = checkFences([mdx(`${ex}\n\n${include}`)], [sample], () => true, noImports);
    expect(r.failures).toEqual([]);
    expect(`${REPO}examples/worker-d1/src/index.ts`.startsWith(REPO)).toBe(true);
  });

  it("refuses a sample that imports the harness or a /testing entry", () => {
    const sources: Record<string, string> = {
      [sample]: [
        'import { createAuth } from "@authtempo/core";',
        'import type { SampleDeps } from "../support/harness.ts";',
        'import { FIREBASE } from "@authtempo/legacy-hashes/testing";',
      ].join("\n"),
    };
    const r = checkFences([mdx(include)], [sample], exists, (p) => sources[p] ?? "");
    expect(r.failures).toEqual([
      "docs/guides/a.mdx: includes apps/site/samples/guides/a.ts, which imports the test code ../support/harness.ts",
      "docs/guides/a.mdx: includes apps/site/samples/guides/a.ts, which imports the test code @authtempo/legacy-hashes/testing",
    ]);
  });

  it("passes a test file that imports the harness and a /testing entry", () => {
    const test = `${SITE}samples/guides/a.test.ts`;
    const both = (p: string) => p === sample || p === test;
    const read = (p: string) =>
      p === test
        ? 'import { harness } from "../support/harness.ts";\nimport { VECTORS } from "@authtempo/legacy-hashes/testing";'
        : 'import { createAuth } from "@authtempo/core";';
    const r = checkFences(
      [mdx(`${include}\n${include.replace("a from", "t from").replace("a.ts", "a.test.ts")}`)],
      [sample],
      both,
      read,
    );
    expect(r.failures).toEqual([]);
  });

  it("fails when no page includes a sample", () => {
    expect(checkFences([], [], exists, noImports).failures).toEqual([
      "read 0 pages",
      "read 0 includes",
    ]);
    expect(DOCS.startsWith(SITE)).toBe(true);
  });
});
