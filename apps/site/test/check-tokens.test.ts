import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTokens } from "../scripts/check-tokens.ts";
import { siteSources } from "../scripts/lib/load.ts";
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

  it("reads the config and each source kind of src, and not tokens.css", () => {
    const paths = siteSources().map((s) => s.path);
    expect(paths).toContain("astro.config.mjs");
    expect(paths).toContain("src/content.config.ts");
    expect(paths).toContain("src/pages/index.astro");
    expect(paths).not.toContain("src/styles/tokens.css");
    expect(paths.filter((p) => p.startsWith("src/content/"))).toEqual([]);
  });

  it("fails a literal color in a TypeScript source", () => {
    const source = {
      path: "src/pages/site.webmanifest.ts",
      text: 'export const GET = () => Response.json({ name: "authtempo", theme_color: "#f6f5f2" });',
    };
    expect(checkTokens({ css, sources: [source], favicon: null }).failures).toEqual([
      "src/pages/site.webmanifest.ts holds the literal color #f6f5f2; use a token of tokens.css",
    ]);
  });

  it("fails a color literal that the light block alone defines", () => {
    const broken = css.replace(
      "  --at-code-ink: #e8e6e1;\n  color-scheme: light;",
      "  --at-code-ink: #e8e6e1;\n  --at-warn: #ff0000;\n  color-scheme: light;",
    );
    expect(broken).not.toBe(css);
    expect(checkTokens({ css: broken, sources: [page], favicon: null }).failures).toEqual([
      "the light block sets --at-warn to #ff0000, which is not a color token",
    ]);
  });

  it("allows a scheme-free token in the light block", () => {
    const extended = css.replace(
      "  color-scheme: light;",
      "  --at-rhythm: 1.5rem;\n  color-scheme: light;",
    );
    expect(extended).not.toBe(css);
    expect(checkTokens({ css: extended, sources: [page], favicon: null }).failures).toEqual([]);
  });

  it("fails a Starlight name that the list lacks and a listed name that the map lacks", () => {
    const broken = css.replace(
      "--sl-color-bg-nav: var(--at-paper);",
      "--sl-color-bg-navx: var(--at-paper);",
    );
    const r = checkTokens({ css: broken, sources: [page], favicon: null });
    expect(r.failures).toEqual([
      "tokens.css does not set --sl-color-bg-nav",
      "tokens.css sets --sl-color-bg-navx, which is not a Starlight color of the map",
    ]);
    expect(r.counts.starlight).toBe(22);
  });

  it("fails each form of a removed focus outline", () => {
    const forms = [
      "outline: 0px",
      "outline: 0",
      "outline-style: none",
      "outline-width: 0",
      "outline-color: transparent",
    ];
    const sources = forms.map((form, i) => ({
      path: `src/x${i}.css`,
      text: `a:focus-visible { ${form}; }`,
    }));
    expect(checkTokens({ css, sources, favicon: null }).failures).toEqual(
      forms.map((_, i) => `src/x${i}.css removes the focus outline`),
    );
  });

  it("passes an id selector that looks like a hex color", () => {
    const source = {
      path: "src/pages/index.astro",
      text: "<style>#bad { margin: 0; }\n#face.card, #deaf { padding: 0; }</style>",
    };
    expect(checkTokens({ css, sources: [source], favicon: null }).failures).toEqual([]);
  });
});
