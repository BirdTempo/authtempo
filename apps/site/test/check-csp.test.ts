import { describe, expect, it } from "vitest";
import { checkCsp, inlineScripts } from "../scripts/check-csp.ts";
import { scriptHash } from "../scripts/check-script.ts";

const TOGGLE = "document.documentElement.dataset.theme = 'dark';";
const PROVIDER = "window.provider = 1;";
const COMMENT = "# style-src counts in this build: style elements 1, style attributes 1.";
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
    "  Referrer-Policy: no-referrer",
    "  X-Content-Type-Options: nosniff",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
    "",
    "/docs/reference/openapi.json",
    "  Access-Control-Allow-Origin: *",
    "",
  ].join("\n");
}

/** The files of a dist with the written _headers and no template. */
const FILES: ReadonlySet<string> = new Set(["_headers", "index.html", "docs/index.html"]);
const check = (pages: ReadonlyMap<string, string>, text: string | null, files = FILES) =>
  checkCsp(pages, text, files);

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
    const r = check(PAGES, headers());
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 2, inline_scripts: 2, hashes: 2 });
  });

  it("fails an inline script with no hash", () => {
    const r = check(PAGES, headers({ hashes: [scriptHash(PROVIDER)] }));
    expect(r.failures).toEqual([
      `index.html has an inline script with no hash: ${scriptHash(TOGGLE)}`,
    ]);
  });

  it("fails a hash that names no script", () => {
    const stale = scriptHash("window.old = 1;");
    const r = check(PAGES, headers({ hashes: [scriptHash(TOGGLE), scriptHash(PROVIDER), stale] }));
    expect(r.failures).toEqual([
      `script-src holds ${stale}, which names no inline script of the build`,
    ]);
  });

  it("ignores a JSON script", () => {
    const pages = new Map(PAGES);
    pages.set("feed/index.html", '<script type="application/ld+json">{"a":1}</script>');
    expect(check(pages, headers()).failures).toEqual([]);
  });

  it("fails a policy without frame-ancestors 'none'", () => {
    const r = check(PAGES, headers({ replace: ["; frame-ancestors 'none'", ""] }));
    expect(r.failures).toEqual(["the policy lacks frame-ancestors 'none'"]);
  });

  it("fails each other directive that is missing or wider", () => {
    const r = check(
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
      check(PAGES, headers({ replace: ["img-src 'self' data:", "img-src 'self' data: https:"] }))
        .failures,
    ).toEqual(["the policy has img-src 'self' data: https:, not img-src 'self' data:"]);
    expect(
      check(PAGES, headers({ replace: ["img-src 'self' data:", "img-src 'self'"] })).failures,
    ).toEqual(["the policy has img-src 'self', not img-src 'self' data:"]);
    expect(check(PAGES, headers({ replace: ["img-src 'self' data:; ", ""] })).failures).toEqual([
      "the policy lacks img-src 'self' data:",
    ]);
  });

  it("fails a script source that is not 'self', 'wasm-unsafe-eval', or a hash", () => {
    const r = check(
      PAGES,
      headers({ replace: ["'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-inline'"] }),
    );
    expect(r.failures).toEqual([
      "script-src holds 'unsafe-inline'; it allows only 'self', 'wasm-unsafe-eval', and hashes",
    ]);
  });

  it("fails 'unsafe-inline' in style-src without the count comment", () => {
    const r = check(PAGES, headers({ comment: null }));
    expect(r.failures).toEqual([
      "style-src holds 'unsafe-inline' and _headers lacks the line # style-src counts in this build: style elements <n>, style attributes <m>.",
    ]);
  });

  it("fails 'unsafe-inline' in style-src when the build has no inline style", () => {
    const pages = new Map(PAGES);
    pages.set("index.html", `<html><head><script>${TOGGLE}</script></head><body></body></html>`);
    const r = check(pages, headers());
    expect(r.failures).toEqual([
      "style-src holds 'unsafe-inline', but the build has no style element and no style attribute",
    ]);
  });

  it("passes style-src 'self' on a build with no inline style", () => {
    const pages = new Map(PAGES);
    pages.set("index.html", `<html><head><script>${TOGGLE}</script></head><body></body></html>`);
    expect(check(pages, headers({ style: "'self'", comment: null })).failures).toEqual([]);
  });

  it("fails style-src 'self' on a build with an inline style", () => {
    const r = check(PAGES, headers({ style: "'self'", comment: null }));
    expect(r.failures).toEqual([
      "style-src is 'self', but the build has style elements 1, style attributes 1",
    ]);
  });

  it("fails a second Content-Security-Policy line", () => {
    const r = check(PAGES, `${headers()}/x/\n  Content-Security-Policy: default-src *\n`);
    expect(r.failures).toEqual([
      "_headers has 2 Content-Security-Policy lines (/*, /x/); it has one, in the rule for /*",
    ]);
  });

  it("fails a line over 2,000 characters", () => {
    const long = Array.from({ length: 40 }, (_, i) => scriptHash(`window.x${i} = 1;`));
    const pages = new Map([
      ["index.html", long.map((_, i) => `<script>window.x${i} = 1;</script>`).join("")],
    ]);
    const r = check(pages, headers({ hashes: long, style: "'self'", comment: null }));
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(
      /^_headers line 2 has \d{4} characters; the platform limit is 2000$/,
    );
  });

  it("fails a directive that occurs twice, since a browser keeps the first copy", () => {
    const r = check(
      PAGES,
      headers({
        replace: ["default-src 'self'; ", "default-src 'self'; script-src * 'unsafe-inline'; "],
      }),
    );
    expect(r.failures).toEqual([
      "the policy has script-src more than once; a browser keeps the first copy",
      "script-src does not start with 'self' 'wasm-unsafe-eval'",
      `index.html has an inline script with no hash: ${scriptHash(TOGGLE)}`,
      `docs/index.html has an inline script with no hash: ${scriptHash(PROVIDER)}`,
    ]);
  });

  it("fails a directive outside the list of the policy", () => {
    for (const added of [
      "script-src-elem * 'unsafe-inline'",
      "script-src-attr 'unsafe-inline'",
      "connect-src *",
      "report-uri https://collector.example/r",
    ]) {
      const name = added.split(" ")[0];
      expect(
        check(
          PAGES,
          headers({ replace: ["default-src 'self'; ", `default-src 'self'; ${added}; `] }),
        ).failures,
      ).toEqual([
        `the policy has ${name}; it has only default-src, frame-ancestors, form-action, base-uri, object-src, img-src, script-src, style-src`,
      ]);
    }
  });

  it("fails a Content-Security-Policy-Report-Only line", () => {
    const text = headers().replace(
      "  Referrer-Policy",
      "  Content-Security-Policy-Report-Only: default-src *\n  Referrer-Policy",
    );
    expect(check(PAGES, text).failures).toEqual([
      "the rule for /* sets Content-Security-Policy-Report-Only; the site sets no report-only policy",
      "the rule for /* sets Content-Security-Policy-Report-Only, which is not a header of the site rule",
    ]);
  });

  it("fails a policy that is not in the rule for /*", () => {
    const text = headers().replace("/*\n", "/docs/*\n");
    expect(check(PAGES, text).failures).toEqual([
      "_headers has 0 rules for /*; it has one",
      "_headers has 1 Content-Security-Policy lines (/docs/*); it has one, in the rule for /*",
    ]);
  });

  it("fails a second rule for /*", () => {
    const text = `${headers()}/*\n  X-Frame-Options: DENY\n`;
    expect(check(PAGES, text).failures).toEqual([
      "_headers has 2 rules for /*; it has one",
      "the rule for /* sets X-Frame-Options, which is not a header of the site rule",
    ]);
  });

  it("fails each other header of the rule for /* that is missing or changed", () => {
    expect(
      check(PAGES, headers().replace("  Referrer-Policy: no-referrer\n", "")).failures,
    ).toEqual(["the rule for /* lacks Referrer-Policy: no-referrer"]);
    expect(
      check(PAGES, headers().replace("  X-Content-Type-Options: nosniff\n", "")).failures,
    ).toEqual(["the rule for /* lacks X-Content-Type-Options: nosniff"]);
    expect(check(PAGES, headers().replace("camera=(), ", "")).failures).toEqual([
      "the rule for /* has Permissions-Policy: microphone=(), geolocation=(), not Permissions-Policy: camera=(), microphone=(), geolocation=()",
    ]);
    expect(check(PAGES, headers().replace("no-referrer", "origin")).failures).toEqual([
      "the rule for /* has Referrer-Policy: origin, not Referrer-Policy: no-referrer",
    ]);
  });

  it("fails a header of the rule for /* that is set twice", () => {
    const text = headers().replace(
      "  X-Content-Type-Options: nosniff\n",
      "  X-Content-Type-Options: nosniff\n  X-Content-Type-Options: nosniff\n",
    );
    expect(check(PAGES, text).failures).toEqual([
      "the rule for /* sets X-Content-Type-Options 2 times",
    ]);
  });

  it("fails a style count comment that differs from the build", () => {
    const text = headers({
      comment: "# style-src counts in this build: style elements 0, style attributes 0.",
    });
    expect(check(PAGES, text).failures).toEqual([
      "the style-src comment states style elements 0, style attributes 0; the build has style elements 1, style attributes 1",
    ]);
  });

  it("fails a dist that still holds _headers.template", () => {
    expect(check(PAGES, headers(), new Set([...FILES, "_headers.template"])).failures).toEqual([
      "dist/_headers.template exists; write-headers.ts deletes it after the write",
    ]);
  });

  it("fails when _headers is missing", () => {
    expect(check(PAGES, null).failures).toEqual(["dist/_headers is missing"]);
  });

  it("fails on zero inline scripts", () => {
    const r = check(
      new Map([["index.html", "<html></html>"]]),
      headers({ hashes: [], style: "'self'", comment: null }),
    );
    expect(r.failures).toEqual(["read 0 inline_scripts"]);
  });
});
