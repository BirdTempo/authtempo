import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkScript, scriptHash } from "../scripts/check-script.ts";
import { SITE } from "../scripts/lib/paths.ts";

const toggle = readFileSync(`${SITE}src/scripts/theme-toggle.js`, "utf8");
const home = `<html><head><script>${toggle}</script></head><body></body></html>`;
const pages = (html: string) => new Map([["index.html", html]]);

/**
 * One line that each forbidden pattern must catch, with the pattern as the
 * failure line prints it. The list is typed here, not read from the check.
 */
const FORBIDDEN_SAMPLES: readonly [sample: string, pattern: string][] = [
  ['fetch("/x");', "/\\bfetch\\s*\\(/"],
  ["new XMLHttpRequest();", "/XMLHttpRequest/"],
  ['navigator.sendBeacon("/x", d);', "/sendBeacon/"],
  ["new WebSocket(u);", "/WebSocket/"],
  ['import("/x.js");', "/\\bimport\\b/"],
  ['const u = "https:" + h;', "/https?:/"],
  ['eval("x");', "/\\beval\\s*\\(/"],
  ['new Function("x");', "/new\\s+Function/"],
  ['document.write("x");', "/document\\.write/"],
  ['el.innerHTML = "x";', "/innerHTML/"],
  ['const u = "//h/x.js";', "/\\/\\//"],
  ["new Image().src = u;", "/\\bImage\\b/"],
  ["new EventSource(u);", "/EventSource/"],
  ['document.createElement("script");', "/createElement/"],
  ['el.insertAdjacentHTML("beforeend", x);', "/insertAdjacentHTML/"],
  ["location.href = u;", "/\\blocation\\b/"],
  ["open(u);", "/\\bopen\\s*\\(/"],
  ['setTimeout("x()", 1);', "/set(?:Timeout|Interval)\\s*\\(\\s*[\"'`]/"],
  ["setInterval('x()', 1);", "/set(?:Timeout|Interval)\\s*\\(\\s*[\"'`]/"],
];

describe("scriptHash", () => {
  it("prints the CSP source form of the SHA-256 of a text", () => {
    expect(scriptHash("")).toBe("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
    expect(scriptHash("window.x = 1;")).toBe("sha256-U1BU0BfAhaBREBgsEDDctSYokOF3U7hQUIj6mrtukfw=");
  });
});

describe("checkScript", () => {
  it("passes a root page with the toggle and no other script", () => {
    const r = checkScript({ toggle, rootPages: pages(home) });
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, scripts: 1, lines: 29 });
    expect(r.exempt).toEqual([
      `src/scripts/theme-toggle.js ${scriptHash(toggle)}: the theme toggle of brand spec 12`,
    ]);
  });

  it("fails a second inline script", () => {
    const r = checkScript({
      toggle,
      rootPages: pages(home.replace("</body>", "<script>window.x = 1;</script></body>")),
    });
    expect(r.failures).toEqual([
      "index.html has 2 script elements; a root page has one, the theme toggle",
      `index.html has an inline script ${scriptHash("window.x = 1;")}, which is not the theme toggle`,
    ]);
  });

  it("fails a script file", () => {
    const r = checkScript({
      toggle,
      rootPages: pages(
        home.replace(
          `<script>${toggle}</script>`,
          '<script src="https://cdn.example/x.js"></script>',
        ),
      ),
    });
    expect(r.failures).toEqual([
      "index.html loads the script file https://cdn.example/x.js; a root page loads none",
    ]);
  });

  it("fails a script file with a single-quoted src", () => {
    const r = checkScript({
      toggle,
      rootPages: pages(home.replace(`<script>${toggle}</script>`, "<script src='/x.js'></script>")),
    });
    expect(r.failures).toEqual(["index.html loads the script file /x.js; a root page loads none"]);
  });

  it("fails an attribute on the toggle tag", () => {
    const r = checkScript({
      toggle,
      rootPages: pages(home.replace("<script>", '<script type="module">')),
    });
    expect(r.failures).toEqual([
      'index.html has a script with the attributes type="module"; the toggle tag has none',
    ]);
  });

  it("fails a toggle of 30 lines", () => {
    const longer = `${toggle}const extra = 1;\n`;
    expect(checkScript({ toggle: longer, rootPages: pages(home) }).failures).toContain(
      "theme-toggle.js has 30 lines; the limit is 29",
    );
  });

  it.each(FORBIDDEN_SAMPLES)("fails a toggle with %s", (sample, pattern) => {
    const r = checkScript({ toggle: `${toggle}${sample}\n`, rootPages: pages(home) });
    expect(r.failures).toContain(
      `theme-toggle.js matches ${pattern}; the toggle sends nothing and loads nothing`,
    );
  });

  it("fails on zero root pages", () => {
    expect(checkScript({ toggle, rootPages: new Map() }).failures).toEqual([
      "read 0 pages",
      "read 0 scripts",
    ]);
  });
});
