import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTokens } from "../scripts/check-tokens.ts";
import { SITE } from "../scripts/lib/paths.ts";

const css = readFileSync(`${SITE}src/styles/tokens.css`, "utf8");
const page = {
  path: "src/pages/index.astro",
  text: '<a href="#add">Add</a><style>a { color: var(--at-ink); }</style>',
};

describe("checkTokens", () => {
  it("passes the token file of the site", () => {
    const r = checkTokens({ css, sources: [page], favicon: null });
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ colors: 9, starlight: 23, sources: 1 });
  });

  it("fails a color token that one dark block lacks", () => {
    const broken = css.replace(
      /(:root\[data-theme="dark"\] \{[\s\S]*?)\n {2}--at-mute: #8a8f9a;/,
      "$1",
    );
    expect(checkTokens({ css: broken, sources: [page], favicon: null }).failures).toEqual([
      "--at-mute has no value in the dark attribute block",
    ]);
  });

  it("fails a Starlight color that is not a token", () => {
    const broken = css.replace("--sl-color-bg: var(--at-paper);", "--sl-color-bg: #ffffff;");
    expect(checkTokens({ css: broken, sources: [page], favicon: null }).failures).toEqual([
      "--sl-color-bg is #ffffff; a Starlight color maps to var(<a color token>)",
    ]);
  });

  it("fails a literal color in a source file", () => {
    const source = { path: "src/x.astro", text: "<style>p { color: #1b1f24; }</style>" };
    expect(checkTokens({ css, sources: [source], favicon: null }).failures).toEqual([
      "src/x.astro holds the literal color #1b1f24; use a token of tokens.css",
    ]);
  });

  it("fails a source that removes the focus outline", () => {
    const source = { path: "src/x.css", text: "a:focus { outline: none; }" };
    expect(checkTokens({ css, sources: [source], favicon: null }).failures).toEqual([
      "src/x.css removes the focus outline",
    ]);
  });

  it("fails tokens.css without the focus ring", () => {
    const broken = css.replace("outline-offset: 2px;", "");
    expect(checkTokens({ css: broken, sources: [page], favicon: null }).failures).toEqual([
      "tokens.css lacks :focus-visible { outline: 2px solid var(--at-accent); outline-offset: 2px; }",
    ]);
  });

  it("fails a token that tokens.css does not define", () => {
    const source = { path: "src/x.astro", text: "<style>p { color: var(--at-nope); }</style>" };
    expect(checkTokens({ css, sources: [source], favicon: null }).failures).toEqual([
      "src/x.astro uses --at-nope, which tokens.css does not define",
    ]);
  });

  it("fails on zero sources", () => {
    expect(checkTokens({ css, sources: [], favicon: null }).failures).toEqual(["read 0 sources"]);
  });
});
