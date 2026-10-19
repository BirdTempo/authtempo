import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkScript, scriptHash } from "../scripts/check-script.ts";
import { SITE } from "../scripts/lib/paths.ts";

const toggle = readFileSync(`${SITE}src/scripts/theme-toggle.js`, "utf8");
const home = `<html><head><script>${toggle}</script></head><body></body></html>`;
const pages = (html: string) => new Map([["index.html", html]]);

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

  it("fails a toggle of 30 lines", () => {
    const longer = `${toggle}const extra = 1;\n`;
    expect(checkScript({ toggle: longer, rootPages: pages(home) }).failures).toContain(
      "theme-toggle.js has 30 lines; the limit is 29",
    );
  });

  it("fails a toggle that sends a request", () => {
    const sends = `${toggle}fetch("/x");\n`;
    expect(checkScript({ toggle: sends, rootPages: pages(home) }).failures).toContain(
      "theme-toggle.js matches /\\bfetch\\s*\\(/; the toggle sends nothing and loads nothing",
    );
  });

  it("fails on zero root pages", () => {
    expect(checkScript({ toggle, rootPages: new Map() }).failures).toEqual([
      "read 0 pages",
      "read 0 scripts",
    ]);
  });
});
