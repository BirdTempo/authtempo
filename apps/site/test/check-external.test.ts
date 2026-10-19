import { describe, expect, it } from "vitest";
import { checkExternal } from "../scripts/check-external.ts";

const HEADERS = "/*\n  X-Content-Type-Options: nosniff\n";
/** One built style sheet with same-origin and data: urls only. */
const CSS = new Map([
  ["_astro/a.css", 'a{background:url(/a.png)}b{mask:url("data:image/svg+xml,%3Csvg/%3E")}'],
]);
const page = (body: string) => new Map([["index.html", `<html><body>${body}</body></html>`]]);

describe("checkExternal", () => {
  it("passes a page with same-origin files only", () => {
    const r = checkExternal(
      page(
        '<link rel="stylesheet" href="/_astro/a.css"><script src="/x.js"></script><img src="https://authtempo.com/og.png"><a href="/docs/">Docs</a>',
      ),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, styles: 1, external_links: 0 });
  });

  it("fails a script file of another origin", () => {
    const r = checkExternal(page('<script src="https://cdn.example/x.js"></script>'), HEADERS, CSS);
    expect(r.failures).toEqual(["index.html loads https://cdn.example/x.js (script src)"]);
  });

  it("fails a style sheet, a preload, and a module preload of another origin", () => {
    const r = checkExternal(
      page(
        '<link rel="stylesheet" href="//cdn.example/a.css"><link rel="preload" href="https://cdn.example/f.woff2"><link rel="modulepreload" href="http://authtempo.com/m.js">',
      ),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual([
      "index.html loads //cdn.example/a.css (link stylesheet)",
      "index.html loads https://cdn.example/f.woff2 (link preload)",
      "index.html loads http://authtempo.com/m.js (link modulepreload)",
    ]);
  });

  it("fails an image of another origin, in src and in srcset", () => {
    const r = checkExternal(
      page(
        '<img src="https://img.example/a.png"><img srcset="/a.png 1x, https://img.example/b.png 2x">',
      ),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual([
      "index.html loads https://img.example/a.png (img src)",
      "index.html loads https://img.example/b.png (img srcset)",
    ]);
  });

  it("fails a source, a frame, a video, and an audio of another origin", () => {
    const r = checkExternal(
      page(
        '<source src="https://m.example/a.mp4"><iframe src="https://m.example/f"></iframe><video src="https://m.example/v.mp4"></video><audio src="https://m.example/a.mp3"></audio>',
      ),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual([
      "index.html loads https://m.example/a.mp4 (source src)",
      "index.html loads https://m.example/f (iframe src)",
      "index.html loads https://m.example/v.mp4 (video src)",
      "index.html loads https://m.example/a.mp3 (audio src)",
    ]);
  });

  it("fails a url() of another origin in a style element", () => {
    const r = checkExternal(
      page("<style>a{background:url(https://img.example/a.png)}</style>"),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual(["index.html loads https://img.example/a.png (style url)"]);
  });

  it("fails a url() of another origin in a style attribute", () => {
    const r = checkExternal(
      page(`<div style="background:url('//img.example/a.png')"></div>`),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual(["index.html loads //img.example/a.png (style url)"]);
  });

  it("fails an @import of another origin in a style element", () => {
    const r = checkExternal(
      page('<style>@import "https://fonts.example/a.css";</style>'),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual(["index.html loads https://fonts.example/a.css (style @import)"]);
  });

  it("passes a data: url and a same-origin url() in a style", () => {
    const r = checkExternal(
      page(
        `<style>a{mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E")}</style><div style="background:url(/a.png)"></div>`,
      ),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual([]);
  });

  it("fails each other link kind that fetches or connects to another origin", () => {
    const r = checkExternal(
      page(
        '<link rel="shortcut icon" href="https://i.example/f.ico"><link rel="apple-touch-icon" href="https://i.example/t.png"><link rel="manifest" href="https://i.example/m.json"><link rel="preconnect" href="https://i.example"><link rel="prefetch" href="https://i.example/p.html">',
      ),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual([
      "index.html loads https://i.example/f.ico (link icon)",
      "index.html loads https://i.example/t.png (link apple-touch-icon)",
      "index.html loads https://i.example/m.json (link manifest)",
      "index.html loads https://i.example (link preconnect)",
      "index.html loads https://i.example/p.html (link prefetch)",
    ]);
  });

  it("fails a video poster, an object, and an embed of another origin", () => {
    const r = checkExternal(
      page(
        '<video src="/v.mp4" poster="https://m.example/p.png"></video><object data="https://m.example/o.pdf"></object><embed src="https://m.example/e.svg">',
      ),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual([
      "index.html loads https://m.example/p.png (video poster)",
      "index.html loads https://m.example/o.pdf (object data)",
      "index.html loads https://m.example/e.svg (embed src)",
    ]);
  });

  it("fails a url() and an @import of another origin in a built style sheet", () => {
    const css = new Map([
      [
        "_astro/b.css",
        '@import url("https://fonts.example/a.css");a{background:url(//img.example/a.png)}',
      ],
    ]);
    expect(checkExternal(page(""), HEADERS, css).failures).toEqual([
      "_astro/b.css loads https://fonts.example/a.css (css @import)",
      "_astro/b.css loads //img.example/a.png (css url)",
    ]);
  });

  it("fails an absolute URL that does not parse", () => {
    expect(
      checkExternal(page('<script src="https://[x/a.js"></script>'), HEADERS, CSS).failures,
    ).toEqual(["index.html loads https://[x/a.js (script src)"]);
  });

  it("counts an external link and passes it", () => {
    const r = checkExternal(
      page('<a href="https://github.com/x">Code</a><a href="https://authtempo.com/docs/">Docs</a>'),
      HEADERS,
      CSS,
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, styles: 1, external_links: 1 });
  });

  it("fails a Set-Cookie line in _headers", () => {
    const r = checkExternal(page(""), `${HEADERS}  Set-Cookie: a=b\n`, CSS);
    expect(r.failures).toEqual(["_headers sets a cookie: Set-Cookie: a=b"]);
  });

  it("fails when _headers is missing", () => {
    const r = checkExternal(page(""), null, CSS);
    expect(r.failures).toEqual(["dist/_headers is missing"]);
  });

  it("fails on zero pages", () => {
    expect(checkExternal(new Map(), HEADERS, CSS).failures).toEqual(["read 0 pages"]);
    expect(checkExternal(page(""), HEADERS, new Map()).failures).toEqual(["read 0 styles"]);
  });
});
