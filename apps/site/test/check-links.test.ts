import { describe, expect, it } from "vitest";
import { checkLinks } from "../scripts/check-links.ts";

function tree(pages: Record<string, string>, extra: string[] = []) {
  return [new Map(Object.entries(pages)), new Set([...Object.keys(pages), ...extra])] as const;
}

describe("checkLinks", () => {
  it("passes links to pages, folders, files, and anchors that exist", () => {
    const r = checkLinks(
      ...tree(
        {
          "index.html": `<a href="/docs/">docs</a>`,
          "docs/index.html": `<h2 id="sections">S</h2><a href="/docs/start/#steps">a</a><a href="#sections">b</a><link rel="icon" href="/favicon.svg"><a href="https://example.com/">e</a>`,
          "docs/start/index.html": `<h2 id="steps">Steps</h2><a href="../">up</a>`,
        },
        ["favicon.svg"],
      ),
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 3, links: 5, anchors: 2, external: 1 });
  });

  it("refuses a link to a missing page and names the page and the href", () => {
    const r = checkLinks(...tree({ "docs/index.html": `<a href="/docs/gone/">x</a>` }));
    expect(r.failures).toEqual(["docs/index.html: /docs/gone/ has no file docs/gone/index.html"]);
  });

  it("refuses an anchor that the target page lacks", () => {
    const r = checkLinks(
      ...tree({
        "docs/index.html": `<a href="/docs/start/#nope">x</a>`,
        "docs/start/index.html": `<h2 id="steps">Steps</h2>`,
      }),
    );
    expect(r.failures).toEqual([
      "docs/index.html: /docs/start/#nope has no element with id nope in docs/start/index.html",
    ]);
  });

  it("fails when it reads no page and no link", () => {
    expect(checkLinks(new Map(), new Set()).failures).toEqual(["read 0 pages", "read 0 links"]);
  });
});
