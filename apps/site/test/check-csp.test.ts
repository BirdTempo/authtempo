import { describe, expect, it } from "vitest";
import { checkCsp, inlineScripts } from "../scripts/check-csp.ts";
import { scriptHash } from "../scripts/check-script.ts";

const TOGGLE = "document.documentElement.dataset.theme = 'dark';";
const PROVIDER = "window.provider = 1;";
const COMMENT =
  "# style-src: 1 style elements and 2 style attributes in the build of 2026-10-19. A style cannot run code; the script rule is the boundary.";
const STYLED = '<style>a{color:red}</style><p style="margin:0"></p>';

interface Policy {
  hashes?: readonly string[];
  style?: string;
  comment?: string | null;
  replace?: [string, string];
}

/** A _headers file in the form of public/_headers.template, after write-headers. */
function headers(p: Policy = {}): string {
  const hashes = (p.hashes ?? [scriptHash(TOGGLE), scriptHash(PROVIDER)]).map((h) => `'${h}'`);
  let csp = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}; style-src ${p.style ?? "'self' 'unsafe-inline'"}; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
  if (p.replace) csp = csp.replace(p.replace[0], p.replace[1]);
  const comment = p.comment === undefined ? COMMENT : p.comment;
  return [
    ...(comment === null ? [] : [comment]),
    "/*",
    `  Content-Security-Policy: ${csp}`,
    "  X-Content-Type-Options: nosniff",
    "",
    "/docs/reference/openapi.json",
    "  Access-Control-Allow-Origin: *",
    "",
  ].join("\n");
}

const PAGES = new Map([
  ["index.html", `<html><head><script>${TOGGLE}</script></head><body>${STYLED}</body></html>`],
  [
    "docs/index.html",
    `<html><head><script>${PROVIDER}</script><script type="module">${TOGGLE}</script><script type="module" src="/_astro/a.js"></script></head><body></body></html>`,
  ],
]);

describe("inlineScripts", () => {
  it("returns the text of each inline script, and skips a file and a JSON script", () => {
    expect(
      inlineScripts(
        `<script>a()</script><script type="module">b()</script><script src="/c.js"></script><script type="application/json">{}</script><script type="application/ld+json">{}</script>`,
      ),
    ).toEqual(["a()", "b()"]);
  });
});

describe("checkCsp", () => {
  it("passes when each inline script has its hash", () => {
    const r = checkCsp(PAGES, headers());
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 2, inline_scripts: 2, hashes: 2 });
  });

  it("fails an inline script with no hash", () => {
    const r = checkCsp(PAGES, headers({ hashes: [scriptHash(PROVIDER)] }));
    expect(r.failures).toEqual([
      `index.html has an inline script with no hash: ${scriptHash(TOGGLE)}`,
    ]);
  });

  it("fails a hash that names no script", () => {
    const stale = scriptHash("window.old = 1;");
    const r = checkCsp(
      PAGES,
      headers({ hashes: [scriptHash(TOGGLE), scriptHash(PROVIDER), stale] }),
    );
    expect(r.failures).toEqual([
      `script-src holds ${stale}, which names no inline script of the build`,
    ]);
  });

  it("ignores a JSON script", () => {
    const pages = new Map(PAGES);
    pages.set("feed/index.html", '<script type="application/ld+json">{"a":1}</script>');
    expect(checkCsp(pages, headers()).failures).toEqual([]);
  });

  it("fails a policy without frame-ancestors 'none'", () => {
    const r = checkCsp(PAGES, headers({ replace: ["; frame-ancestors 'none'", ""] }));
    expect(r.failures).toEqual(["the policy lacks frame-ancestors 'none'"]);
  });

  it("fails each other directive that is missing or wider", () => {
    const r = checkCsp(
      PAGES,
      headers({ replace: ["default-src 'self'; ", "default-src *; "] }).replace(
        "object-src 'none'",
        "object-src 'self'",
      ),
    );
    expect(r.failures).toEqual([
      "the policy has default-src *, not default-src 'self'",
      "the policy has object-src 'self', not object-src 'none'",
    ]);
  });

  it("fails an img-src other than 'self' data:", () => {
    expect(
      checkCsp(PAGES, headers({ replace: ["img-src 'self' data:", "img-src 'self' data: https:"] }))
        .failures,
    ).toEqual(["the policy has img-src 'self' data: https:, not img-src 'self' data:"]);
    expect(
      checkCsp(PAGES, headers({ replace: ["img-src 'self' data:", "img-src 'self'"] })).failures,
    ).toEqual(["the policy has img-src 'self', not img-src 'self' data:"]);
    expect(checkCsp(PAGES, headers({ replace: ["img-src 'self' data:; ", ""] })).failures).toEqual([
      "the policy lacks img-src 'self' data:",
    ]);
  });

  it("fails a script source that is not 'self', 'wasm-unsafe-eval', or a hash", () => {
    const r = checkCsp(
      PAGES,
      headers({ replace: ["'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-inline'"] }),
    );
    expect(r.failures).toEqual([
      "script-src holds 'unsafe-inline'; it allows only 'self', 'wasm-unsafe-eval', and hashes",
    ]);
  });

  it("fails 'unsafe-inline' in style-src without the count comment", () => {
    const r = checkCsp(PAGES, headers({ comment: null }));
    expect(r.failures).toEqual([
      "style-src holds 'unsafe-inline' and _headers lacks the line # style-src: <n> style elements and <m> style attributes in the build of <date>.",
    ]);
  });

  it("fails 'unsafe-inline' in style-src when the build has no inline style", () => {
    const pages = new Map(PAGES);
    pages.set("index.html", `<html><head><script>${TOGGLE}</script></head><body></body></html>`);
    const r = checkCsp(pages, headers());
    expect(r.failures).toEqual([
      "style-src holds 'unsafe-inline', but the build has no style element and no style attribute",
    ]);
  });

  it("passes style-src 'self' on a build with no inline style", () => {
    const pages = new Map(PAGES);
    pages.set("index.html", `<html><head><script>${TOGGLE}</script></head><body></body></html>`);
    expect(checkCsp(pages, headers({ style: "'self'", comment: null })).failures).toEqual([]);
  });

  it("fails style-src 'self' on a build with an inline style", () => {
    const r = checkCsp(PAGES, headers({ style: "'self'", comment: null }));
    expect(r.failures).toEqual([
      "style-src is 'self', but the build has 1 style elements and 1 style attributes",
    ]);
  });

  it("fails a second Content-Security-Policy line", () => {
    const r = checkCsp(PAGES, `${headers()}/x/\n  Content-Security-Policy: default-src *\n`);
    expect(r.failures).toEqual([
      "_headers has 2 Content-Security-Policy lines; it has one, in the rule for /*",
    ]);
  });

  it("fails a line over 2,000 characters", () => {
    const long = Array.from({ length: 40 }, (_, i) => scriptHash(`window.x${i} = 1;`));
    const pages = new Map([
      ["index.html", long.map((_, i) => `<script>window.x${i} = 1;</script>`).join("")],
    ]);
    const r = checkCsp(pages, headers({ hashes: long, style: "'self'", comment: null }));
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(
      /^_headers line 2 has \d{4} characters; the platform limit is 2000$/,
    );
  });

  it("fails when _headers is missing", () => {
    expect(checkCsp(PAGES, null).failures).toEqual(["dist/_headers is missing"]);
  });

  it("fails on zero inline scripts", () => {
    const r = checkCsp(
      new Map([["index.html", "<html></html>"]]),
      headers({ hashes: [], style: "'self'", comment: null }),
    );
    expect(r.failures).toEqual(["read 0 inline_scripts"]);
  });
});
