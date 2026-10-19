import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkIcons, pathPoints } from "../scripts/check-icons.ts";
import { SITE } from "../scripts/lib/paths.ts";
import { ICON_NAMES } from "../src/data/icons.ts";

const sprite = readFileSync(`${SITE}public/icons.svg`, "utf8");

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
});
