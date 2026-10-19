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

  it("refuses an internal page link with no trailing slash and names the rule", () => {
    const r = checkLinks(
      ...tree({ "docs/index.html": `<a href="/docs/start">x</a>`, "docs/start/index.html": "" }),
    );
    expect(r.failures).toEqual([
      "docs/index.html: /docs/start is a page link with no trailing /; every internal page link ends with /",
    ]);
  });

  it("checks a fragment of an SVG file against its ids", () => {
    const pages = new Map([
      [
        "index.html",
        '<svg><use href="/icons.svg#sun"></use><use href="/icons.svg#sunn"></use></svg>',
      ],
      ["icons.svg", '<svg><symbol id="sun"></symbol></svg>'],
    ]);
    expect(checkLinks(pages, new Set(["index.html", "icons.svg"])).failures).toEqual([
      "index.html: /icons.svg#sunn has no element with id sunn in icons.svg",
    ]);
  });

  it("fails when it reads no page and no link", () => {
    expect(checkLinks(new Map(), new Set()).failures).toEqual(["read 0 pages", "read 0 links"]);
  });
});
