import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scriptHash } from "../scripts/check-script.ts";
import { fillHeaders } from "../scripts/lib/headers.ts";
import { SITE } from "../scripts/lib/paths.ts";

const TEMPLATE = "/*\n  Content-Security-Policy: script-src 'self' {{SCRIPT_HASHES}}\n";
const PAGES = new Map([
  ["index.html", "<script>a()</script><script>b()</script>"],
  ["docs/index.html", '<script type="module">a()</script><script src="/x.js"></script>'],
]);

describe("fillHeaders", () => {
  it("writes the hash of each distinct inline script once, in sorted order", () => {
    const hashes = [scriptHash("a()"), scriptHash("b()")].sort().map((h) => `'${h}'`);
    expect(fillHeaders(TEMPLATE, PAGES)).toBe(
      `/*\n  Content-Security-Policy: script-src 'self' ${hashes.join(" ")}\n`,
    );
  });

  it("fails a template without the placeholder", () => {
    expect(() => fillHeaders("/*\n  X-Content-Type-Options: nosniff\n", PAGES)).toThrow(
      "the template holds {{SCRIPT_HASHES}} 0 times; it holds it once",
    );
  });

  it("fails a build with no inline script", () => {
    expect(() => fillHeaders(TEMPLATE, new Map([["index.html", "<p></p>"]]))).toThrow(
      "the build has no inline script; the writer read nothing",
    );
  });

  it("finds the placeholder once in the site template", () => {
    const template = readFileSync(`${SITE}public/_headers.template`, "utf8");
    expect(template.split("{{SCRIPT_HASHES}}")).toHaveLength(2);
  });
});
