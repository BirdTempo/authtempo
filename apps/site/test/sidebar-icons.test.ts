import { describe, expect, it } from "vitest";
import { ICON_NAMES } from "../src/data/icons.ts";
import { SIDEBAR_ICONS, sidebarIcon } from "../src/data/sidebar-icons.ts";

describe("the sidebar icons (brand spec 11)", () => {
  it("names an icon of the sprite for each group", () => {
    expect(Object.keys(SIDEBAR_ICONS)).toEqual([
      "Getting started",
      "Frameworks",
      "How-to guides",
      "Migration",
      "Operations",
      "Reference",
      "Concepts",
      "Versions",
    ]);
    for (const icon of Object.values(SIDEBAR_ICONS)) expect(ICON_NAMES).toContain(icon);
    expect(sidebarIcon("Reference")).toBe("client");
    expect(sidebarIcon("Frameworks")).toBe("oauth");
  });

  it("throws on a group with no icon", () => {
    expect(() => sidebarIcon("Recipes")).toThrow(
      'the sidebar group "Recipes" has no icon; add it to SIDEBAR_ICONS in src/data/sidebar-icons.ts',
    );
  });
});
