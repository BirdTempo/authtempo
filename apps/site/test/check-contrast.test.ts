import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRAST_PAIRS, checkContrast, contrastRatio } from "../scripts/check-contrast.ts";
import { SITE } from "../scripts/lib/paths.ts";

const css = readFileSync(`${SITE}src/styles/tokens.css`, "utf8");

describe("checkContrast", () => {
  it("computes 21:1 for black on white, the WCAG 2.1 maximum", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("computes the same ratio in both orders", () => {
    expect(contrastRatio("#6b6f78", "#f6f5f2")).toBe(contrastRatio("#f6f5f2", "#6b6f78"));
  });

  it("passes every pair of the site's tokens in both schemes", () => {
    const r = checkContrast(css);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pairs: 20, lowest_text: 4.61, lowest_non_text: 3.68 });
  });

  it("holds the accent on the surface and on the code color as focus-ring pairs", () => {
    expect(CONTRAST_PAIRS).toContainEqual({
      fg: "--at-accent",
      bg: "--at-surface",
      kind: "non-text",
    });
    expect(CONTRAST_PAIRS).toContainEqual({ fg: "--at-accent", bg: "--at-code", kind: "non-text" });
  });

  it("names an absent token as no value", () => {
    const broken = css.replace(
      /(:root\[data-theme="dark"\] \{[\s\S]*?)\n {2}--at-accent-text: #6b9bff;/,
      "$1",
    );
    expect(checkContrast(broken).failures).toContain(
      "dark: --at-accent-text on --at-paper needs two #rrggbb values; read no value and #121316",
    );
  });

  it("fails a mute color under 4.5:1 on paper", () => {
    const r = checkContrast(css.replace("--at-mute: #6b6f78;", "--at-mute: #8a8f9a;"));
    expect(r.failures).toContain(
      "light: --at-mute on --at-paper is 2.97:1; the floor is 4.5:1 (text)",
    );
  });

  it("fails an accent under 3:1 as a non-text color", () => {
    const r = checkContrast(css.replaceAll("--at-accent: #2f6df6;", "--at-accent: #9db8f9;"));
    expect(r.failures.some((f) => f.startsWith("light: --at-accent on --at-paper"))).toBe(true);
    expect(r.failures.every((f) => f.endsWith("(non-text)"))).toBe(true);
  });

  it("fails a value that is not #rrggbb", () => {
    const r = checkContrast(css.replace("--at-ink: #15161a;", "--at-ink: black;"));
    expect(r.failures).toContain(
      "light: --at-ink on --at-paper needs two #rrggbb values; read black and #f6f5f2",
    );
  });
});
