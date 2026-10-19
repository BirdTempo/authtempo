import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkMotion } from "../scripts/check-motion.ts";
import { SITE } from "../scripts/lib/paths.ts";

const css = readFileSync(`${SITE}src/styles/tokens.css`, "utf8");
const BUILT =
  "@media (prefers-reduced-motion:reduce){*,:after,:before{animation:none!important;transition-duration:0s!important}}";
const pages = new Map([
  ["index.html", '<link rel="stylesheet" href="/_astro/a.css">'],
  ["docs/index.html", `<style>${BUILT}</style>`],
]);
const read = (href: string) => (href === "/_astro/a.css" ? BUILT : null);
const run = (tokensCss: string, sources: { path: string; text: string }[] = []) =>
  checkMotion({ tokensCss, sources, pages, read });

describe("checkMotion", () => {
  it("passes the site's tokens and two pages with the block", () => {
    const r = run(css);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 2, keyframes: 3, animations: 3 });
  });

  it("fails tokens.css without the reduced-motion block", () => {
    expect(run(css.replace("animation: none !important;", "")).failures).toEqual([
      "tokens.css lacks @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition-duration: 0s !important; } }",
    ]);
  });

  it("fails a keyframe with an end state", () => {
    const broken = css.replace("@keyframes at-draw {\n  from {", "@keyframes at-draw {\n  to {");
    expect(run(broken).failures).toEqual([
      "@keyframes at-draw sets an end state; the end state is the element's own style",
    ]);
  });

  it("fails an animation that keeps its end state", () => {
    const broken = css.replace(
      "animation: at-enter var(--at-enter) var(--at-ease-enter) backwards;",
      "animation: at-enter var(--at-enter) var(--at-ease-enter) both;",
    );
    expect(run(broken).failures).toEqual([
      ".at-enter keeps the end state of an animation (at-enter var(--at-enter) var(--at-ease-enter) both); use backwards",
    ]);
  });

  it("fails an animation in another source", () => {
    const source = { path: "src/x.astro", text: "<style>p { animation: at-enter 1s; }</style>" };
    expect(run(css, [source]).failures).toEqual([
      "src/x.astro declares an animation; motion lives in tokens.css only",
    ]);
  });

  it("fails a page with no reduced-motion CSS", () => {
    const r = checkMotion({
      tokensCss: css,
      sources: [],
      pages: new Map([["a.html", "<p></p>"]]),
      read,
    });
    expect(r.failures).toEqual(["a.html has no CSS with the reduced-motion block", "read 0 pages"]);
  });
});
