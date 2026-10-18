import { type CheckReport, requireCounts } from "./lib/report.ts";
import { type ColorToken, parseTokens } from "./lib/tokens.ts";

/**
 * The relative luminance of WCAG 2.1, for a color written #rrggbb
 * (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance, read 2026-10-15).
 */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`${hex} is not a #rrggbb color`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = Number.parseInt(h ?? "", 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** The contrast ratio of WCAG 2.1: (L1 + 0.05) / (L2 + 0.05), with L1 the lighter color. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The pairs of brand spec 4, and the text pairs on a surface and in a code block. */
export const CONTRAST_PAIRS: readonly {
  fg: ColorToken;
  bg: ColorToken;
  kind: "text" | "non-text";
}[] = [
  { fg: "--at-ink", bg: "--at-paper", kind: "text" },
  { fg: "--at-mute", bg: "--at-paper", kind: "text" },
  { fg: "--at-accent-text", bg: "--at-paper", kind: "text" },
  { fg: "--at-accent", bg: "--at-paper", kind: "non-text" },
  { fg: "--at-ink", bg: "--at-surface", kind: "text" },
  { fg: "--at-mute", bg: "--at-surface", kind: "text" },
  { fg: "--at-accent-text", bg: "--at-surface", kind: "text" },
  { fg: "--at-code-ink", bg: "--at-code", kind: "text" },
];
/** WCAG 2.1 SC 1.4.3 (text, 4.5:1) and SC 1.4.11 (non-text, 3:1). */
export const FLOOR = { text: 4.5, "non-text": 3 } as const;

const floor2 = (x: number) => Math.floor(x * 100) / 100;

/**
 * Brand spec 4 and 14. Each pair is computed in the light set and in the
 * dark attribute set. check-tokens holds the dark media set to the same
 * values, so one dark set is enough here. A pair fails under its floor,
 * and a value that is not #rrggbb fails before the formula runs.
 */
export function checkContrast(css: string): CheckReport {
  const t = parseTokens(css);
  const r: CheckReport = { name: "check-contrast", counts: { pairs: 0 }, failures: [] };
  const lowest = { text: Number.POSITIVE_INFINITY, "non-text": Number.POSITIVE_INFINITY };
  for (const [scheme, set] of [
    ["light", t.light],
    ["dark", t.darkAttr],
  ] as const) {
    for (const p of CONTRAST_PAIRS) {
      const fg = set.get(p.fg);
      const bg = set.get(p.bg);
      const hex = /^#[0-9a-f]{6}$/i;
      if (fg === undefined || bg === undefined || !hex.test(fg) || !hex.test(bg)) {
        r.failures.push(
          `${scheme}: ${p.fg} on ${p.bg} needs two #rrggbb values; read ${fg} and ${bg}`,
        );
        continue;
      }
      const ratio = contrastRatio(fg, bg);
      r.counts.pairs = (r.counts.pairs ?? 0) + 1;
      lowest[p.kind] = Math.min(lowest[p.kind], ratio);
      if (ratio < FLOOR[p.kind])
        r.failures.push(
          `${scheme}: ${p.fg} on ${p.bg} is ${floor2(ratio)}:1; the floor is ${FLOOR[p.kind]}:1 (${p.kind})`,
        );
    }
  }
  r.counts.lowest_text = Number.isFinite(lowest.text) ? floor2(lowest.text) : 0;
  r.counts.lowest_non_text = Number.isFinite(lowest["non-text"]) ? floor2(lowest["non-text"]) : 0;
  return requireCounts(r, ["pairs"]);
}
