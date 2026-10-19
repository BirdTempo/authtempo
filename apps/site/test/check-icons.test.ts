import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkIcons, pathPoints } from "../scripts/check-icons.ts";
import { SITE } from "../scripts/lib/paths.ts";
import { ICON_NAMES } from "../src/data/icons.ts";

const sprite = readFileSync(`${SITE}public/icons.svg`, "utf8");
const SYMBOL =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
/** A sprite of one symbol "a" with the given shapes, and any extra symbol attributes. */
const one = (shapes: string, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg"><title>t</title><symbol id="a" ${SYMBOL}${extra}>${shapes}</symbol></svg>`;

describe("checkIcons", () => {
  it("passes the sprite of the site", () => {
    const r = checkIcons(sprite, ICON_NAMES);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ symbols: 19, shapes: 39 });
  });

  it("fails a symbol with another stroke width", () => {
    const broken = sprite.replace(
      '<symbol id="verify" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"',
      '<symbol id="verify" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"',
    );
    expect(checkIcons(broken, ICON_NAMES).failures).toEqual([
      "verify: stroke-width is 1.5; it must be 1.75",
    ]);
  });

  it("fails a shape with a fill", () => {
    const broken = sprite.replace(
      '<rect pathLength="1" x="3" y="6" width="18" height="12" rx="2"/><path pathLength="1" d="M7 14 H13"/>',
      '<rect pathLength="1" x="3" y="6" width="18" height="12" rx="2" fill="red"/><path pathLength="1" d="M7 14 H13"/>',
    );
    expect(checkIcons(broken, ICON_NAMES).failures).toEqual(["session: a <rect> sets a fill"]);
  });

  it("fails a point outside the safe margin", () => {
    const broken = sprite.replace('d="M4 12 H20 M14 6', 'd="M1 12 H20 M14 6');
    expect(checkIcons(broken, ICON_NAMES).failures).toEqual([
      "start: the point (1, 12) is outside the safe margin of 2",
    ]);
  });

  it("fails a relative path command", () => {
    expect(pathPoints("M4 12 h16")).toEqual({ error: "the command h is not one of M L H V C Z" });
  });

  it("reads each point of a cubic curve", () => {
    expect(pathPoints("M2 2 C3 3 4 4 5 5 Z")).toEqual({
      points: [
        [2, 2],
        [3, 3],
        [4, 4],
        [5, 5],
      ],
    });
  });

  it("fails a name that the sprite lacks, and a symbol that the list lacks", () => {
    const names = [...ICON_NAMES.filter((n) => n !== "cli"), "extra"];
    expect(checkIcons(sprite, names).failures).toEqual([
      "cli is not a name of ICON_NAMES",
      "the sprite has no symbol extra",
    ]);
  });

  it("fails on an empty sprite", () => {
    expect(checkIcons("<svg></svg>", []).failures).toEqual(["read 0 symbols", "read 0 shapes"]);
  });

  it("fails a single-quoted fill", () => {
    expect(
      checkIcons(one(`<path pathLength="1" fill='red' d="M4 12 H20"/>`), ["a"]).failures,
    ).toEqual(["a: a <path> sets a fill"]);
  });

  it("fails a shape with a style attribute", () => {
    expect(
      checkIcons(one(`<path pathLength="1" style="fill:red;stroke-width:3" d="M4 12 H20"/>`), ["a"])
        .failures,
    ).toEqual(["a: a <path> sets style, which is not one of d, pathLength"]);
  });

  it("fails a shape with a transform", () => {
    expect(
      checkIcons(one(`<path pathLength="1" transform="translate(-10 0)" d="M4 12 H20"/>`), ["a"])
        .failures,
    ).toEqual(["a: a <path> sets transform, which is not one of d, pathLength"]);
  });

  it("fails a symbol with an attribute beyond its six", () => {
    expect(
      checkIcons(one(`<path pathLength="1" d="M4 12 H20"/>`, ` opacity="0.3"`), ["a"]).failures,
    ).toEqual(["a: the symbol sets opacity, which is not id or a symbol attribute"]);
  });

  it("fails a path with no point", () => {
    expect(
      checkIcons(one(`<path pathLength="1"/><path pathLength="1" d=""/>`), ["a"]).failures,
    ).toEqual(["a: a <path> has no point", "a: a <path> has no point"]);
  });

  it("fails a circle with no radius by name", () => {
    expect(checkIcons(one(`<circle pathLength="1" cx="12" cy="12"/>`), ["a"]).failures).toEqual([
      "a: a <circle> has no number for r",
    ]);
  });

  it("names both radii of a rect", () => {
    expect(
      checkIcons(one(`<rect pathLength="1" x="3" y="6" width="18" height="12" rx="2" ry="3"/>`), [
        "a",
      ]).failures,
    ).toEqual(["a: a rect has rx=2 ry=3; the radius is 2"]);
  });

  it("fails a root child that is not a title, a comment, or a symbol", () => {
    const styled = sprite.replace("</svg>", "<style>path{fill:red}</style></svg>");
    expect(checkIcons(styled, ICON_NAMES).failures).toEqual([
      "the root holds <style>; the root holds a title, a comment, and symbols only",
    ]);
  });

  it("fails an unquoted attribute value", () => {
    expect(
      checkIcons(one(`<path pathLength="1" fill=red d="M4 12 H20"/>`), ["a"]).failures,
    ).toEqual(["a: a <path> has text the check cannot read: fill=red"]);
  });

  it("fails an attribute name the reader cannot read", () => {
    expect(checkIcons(one(`<path pathLength="1" x1="4" d="M4 12 H20"/>`), ["a"]).failures).toEqual([
      'a: a <path> has text the check cannot read: x1="4"',
    ]);
  });

  it("fails a symbol with text the reader cannot read", () => {
    expect(
      checkIcons(one(`<path pathLength="1" d="M4 12 H20"/>`, " opacity=0.3"), ["a"]).failures,
    ).toEqual(["a: the symbol has text the check cannot read: opacity=0.3"]);
  });

  it("fails a cubic command that reads one pair", () => {
    expect(pathPoints("M4 12 C5 5 6 6")).toEqual({ error: "C needs pairs of numbers" });
  });
});
