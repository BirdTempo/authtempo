import { describe, expect, it } from "vitest";
import { checkExternal } from "../scripts/check-external.ts";

const HEADERS = "/*\n  X-Content-Type-Options: nosniff\n";
const page = (body: string) => new Map([["index.html", `<html><body>${body}</body></html>`]]);

describe("checkExternal", () => {
  it("passes a page with same-origin files only", () => {
    const r = checkExternal(
      page(
        '<link rel="stylesheet" href="/_astro/a.css"><script src="/x.js"></script><img src="https://authtempo.com/og.png"><a href="/docs/">Docs</a>',
      ),
      HEADERS,
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, external_links: 0 });
  });

  it("fails a script file of another origin", () => {
    const r = checkExternal(page('<script src="https://cdn.example/x.js"></script>'), HEADERS);
    expect(r.failures).toEqual(["index.html loads https://cdn.example/x.js (script src)"]);
  });

  it("fails a style sheet, a preload, and a module preload of another origin", () => {
    const r = checkExternal(
      page(
        '<link rel="stylesheet" href="//cdn.example/a.css"><link rel="preload" href="https://cdn.example/f.woff2"><link rel="modulepreload" href="http://authtempo.com/m.js">',
      ),
      HEADERS,
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
    );
    expect(r.failures).toEqual(["index.html loads https://img.example/a.png (style url)"]);
  });

  it("fails a url() of another origin in a style attribute", () => {
    const r = checkExternal(
      page(`<div style="background:url('//img.example/a.png')"></div>`),
      HEADERS,
    );
    expect(r.failures).toEqual(["index.html loads //img.example/a.png (style url)"]);
  });

  it("fails an @import of another origin in a style element", () => {
    const r = checkExternal(page('<style>@import "https://fonts.example/a.css";</style>'), HEADERS);
    expect(r.failures).toEqual(["index.html loads https://fonts.example/a.css (style @import)"]);
  });

  it("passes a data: url and a same-origin url() in a style", () => {
    const r = checkExternal(
      page(
        `<style>a{mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E")}</style><div style="background:url(/a.png)"></div>`,
      ),
      HEADERS,
    );
    expect(r.failures).toEqual([]);
  });

  it("counts an external link and passes it", () => {
    const r = checkExternal(
      page('<a href="https://github.com/x">Code</a><a href="https://authtempo.com/docs/">Docs</a>'),
      HEADERS,
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, external_links: 1 });
  });

  it("fails a Set-Cookie line in _headers", () => {
    const r = checkExternal(page(""), `${HEADERS}  Set-Cookie: a=b\n`);
    expect(r.failures).toEqual(["_headers sets a cookie: Set-Cookie: a=b"]);
  });

  it("fails when _headers is missing", () => {
    const r = checkExternal(page(""), null);
    expect(r.failures).toEqual(["dist/_headers is missing"]);
  });

  it("fails on zero pages", () => {
    expect(checkExternal(new Map(), HEADERS).failures).toEqual(["read 0 pages"]);
  });
});
