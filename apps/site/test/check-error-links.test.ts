import { describe, expect, it } from "vitest";
import { checkErrorLinks, type ErrorLink } from "../scripts/check-error-links.ts";

const pages: Record<string, string> = {
  "/docs/reference/errors/": '<h3 id="invalid_token">x</h3><h3 id="oauth-invalid_token">y</h3>',
  "/docs/reference/client/": '<h2 id="results">Results</h2>',
};
const read = (path: string) => pages[path] ?? "";
const link = (code: string, url: string, text = "The link is not valid."): ErrorLink => ({
  table: "core",
  code,
  url,
  text,
});

describe("checkErrorLinks", () => {
  it("passes a link to an anchor of a built page, with a text of the glossary", () => {
    const r = checkErrorLinks(
      [
        link("invalid_token", "https://authtempo.com/docs/reference/errors/#invalid_token"),
        link("network", "https://authtempo.com/docs/reference/client/#results"),
      ],
      read,
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ links: 2, anchors: 2, texts: 2 });
  });

  // Each refusal case holds one good link, so the anchor count is not 0 and
  // the failures are the refusals alone.
  it("refuses an anchor that the page does not have, and a page that the build lacks", () => {
    const r = checkErrorLinks(
      [
        link("invalid_token", "https://authtempo.com/docs/reference/errors/#invalid_token"),
        link("gone", "https://authtempo.com/docs/reference/errors/#gone"),
        link("x", "https://authtempo.com/docs/reference/nothing/#x"),
      ],
      read,
    );
    expect(r.failures).toEqual([
      "core code gone links /docs/reference/errors/#gone, which the build does not have",
      "core code x links /docs/reference/nothing/#x, which the build does not have",
    ]);
  });

  it("refuses a link to another origin or with no anchor", () => {
    const r = checkErrorLinks(
      [
        link("invalid_token", "https://authtempo.com/docs/reference/errors/#invalid_token"),
        link("a", "https://example.com/docs/reference/errors/#invalid_token"),
        link("b", "https://authtempo.com/docs/reference/errors/"),
      ],
      read,
    );
    expect(r.failures).toEqual([
      "core code a links https://example.com/docs/reference/errors/#invalid_token, not a page of https://authtempo.com",
      "core code b links https://authtempo.com/docs/reference/errors/ with no anchor",
    ]);
  });

  it("refuses a text with a forbidden term or a long sentence", () => {
    const url = "https://authtempo.com/docs/reference/errors/#invalid_token";
    const r = checkErrorLinks(
      [link("a", url, "Please log in again."), link("b", url, `${"word ".repeat(26).trim()}.`)],
      read,
    );
    expect(r.failures).toEqual([
      'core code a: the text uses "log in"; use "sign in"',
      "core code b: the text has a sentence of 26 words (at most 25)",
    ]);
  });

  it("fails on no links", () => {
    expect(checkErrorLinks([], read).failures).toEqual([
      "read 0 links",
      "read 0 anchors",
      "read 0 texts",
    ]);
  });
});
