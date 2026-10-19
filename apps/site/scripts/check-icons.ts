import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The grid of brand spec 8: a 24-unit box with a safe margin of 2 on each side. */
export const SAFE_MIN = 2;
export const SAFE_MAX = 22;
/** The attributes that each symbol sets once, so that no shape sets its own. */
export const SYMBOL_ATTRS: Readonly<Record<string, string>> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.75",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};
/**
 * The attributes a shape may set, by tag. Every other attribute is a failure.
 * A style, a transform, or an opacity changes the drawn shape past what the
 * check reads, so the check refuses it by name.
 */
export const SHAPE_ATTRS: Readonly<Record<string, readonly string[]>> = {
  path: ["d", "pathLength"],
  circle: ["cx", "cy", "r", "pathLength"],
  rect: ["x", "y", "width", "height", "rx", "ry", "pathLength"],
};
/** The three attributes that have their own failure line, so the allow-list does not name them twice. */
const PAINT_ATTRS = ["fill", "stroke", "stroke-width"];

/** Each attribute of a tag, in either quote form. */
function attrs(text: string): Map<string, string> {
  return new Map(
    [...text.matchAll(/([a-zA-Z:-]+)=(?:"([^"]*)"|'([^']*)')/g)].map((m) => [
      m[1] ?? "",
      m[2] ?? m[3] ?? "",
    ]),
  );
}

/**
 * The points of a path: each end point and each control point. A cubic curve
 * lies inside the hull of its points, so these points bound the shape. Only
 * the absolute commands M, L, H, V, C, and Z are allowed. An arc or a
 * relative command needs a wider reader, and the set needs neither.
 */
export function pathPoints(d: string): { points: [number, number][] } | { error: string } {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const points: [number, number][] = [];
  let cmd = "";
  let x = 0;
  let y = 0;
  let i = 0;
  const num = (): number | null => {
    const t = tokens[i];
    if (t === undefined || /[A-Za-z]/.test(t)) return null;
    i++;
    return Number(t);
  };
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (/[A-Za-z]/.test(t)) {
      if (!"MLHVCZ".includes(t)) return { error: `the command ${t} is not one of M L H V C Z` };
      cmd = t;
      i++;
      if (cmd === "Z") continue;
    } else if (cmd === "" || cmd === "Z") return { error: `the number ${t} follows no command` };
    if (cmd === "H" || cmd === "V") {
      const v = num();
      if (v === null) return { error: `${cmd} has no number` };
      if (cmd === "H") x = v;
      else y = v;
      points.push([x, y]);
      continue;
    }
    for (let k = 0; k < (cmd === "C" ? 3 : 1); k++) {
      const px = num();
      const py = num();
      if (px === null || py === null) return { error: `${cmd} needs pairs of numbers` };
      x = px;
      y = py;
      points.push([x, y]);
    }
  }
  return { points };
}

/**
 * The points that bound a circle or a rect, or the points of a path. A
 * missing or non-numeric length is an error that names the attribute.
 */
function shapePoints(
  tag: string,
  a: Map<string, string>,
): { points: [number, number][] } | { error: string } {
  if (tag === "path") return pathPoints(a.get("d") ?? "");
  const keys = tag === "circle" ? ["cx", "cy", "r"] : ["x", "y", "width", "height"];
  const n: Record<string, number> = {};
  for (const k of keys) {
    const v = a.get(k);
    if (v === undefined || v.trim() === "" || Number.isNaN(Number(v)))
      return { error: `a <${tag}> has no number for ${k}` };
    n[k] = Number(v);
  }
  const g = (k: string): number => n[k] ?? Number.NaN;
  if (tag === "circle")
    return {
      points: [
        [g("cx") - g("r"), g("cy") - g("r")],
        [g("cx") + g("r"), g("cy") + g("r")],
      ],
    };
  return {
    points: [
      [g("x"), g("y")],
      [g("x") + g("width"), g("y") + g("height")],
    ],
  };
}

/** The root may hold the title, a comment, and the symbols. Any other child is a failure. */
function rootChildren(sprite: string): string[] {
  const rest = sprite
    .replace(/<symbol\b[^>]*>[\s\S]*?<\/symbol>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[^<]*<\/title>/g, "")
    .replace(/^\s*<svg\b[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
  return [...rest.matchAll(/<([a-zA-Z]+)\b/g)].map((m) => m[1] ?? "");
}

export function checkIcons(sprite: string, names: readonly string[]): CheckReport {
  const r: CheckReport = { name: "check-icons", counts: { symbols: 0, shapes: 0 }, failures: [] };
  const seen = new Set<string>();
  for (const tag of rootChildren(sprite))
    r.failures.push(`the root holds <${tag}>; the root holds a title, a comment, and symbols only`);
  for (const m of sprite.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g)) {
    const a = attrs(m[1] ?? "");
    const id = a.get("id") ?? "(no id)";
    r.counts.symbols = (r.counts.symbols ?? 0) + 1;
    if (seen.has(id)) r.failures.push(`${id} is in the sprite twice`);
    seen.add(id);
    if (!names.includes(id)) r.failures.push(`${id} is not a name of ICON_NAMES`);
    for (const [k, v] of Object.entries(SYMBOL_ATTRS))
      if (a.get(k) !== v)
        r.failures.push(`${id}: ${k} is ${a.get(k) ?? "missing"}; it must be ${v}`);
    for (const k of a.keys())
      if (k !== "id" && !(k in SYMBOL_ATTRS))
        r.failures.push(`${id}: the symbol sets ${k}, which is not id or a symbol attribute`);
    for (const s of (m[2] ?? "").matchAll(/<([a-zA-Z]+)\b([^>]*?)\/?>/g)) {
      const tag = s[1] ?? "";
      const sa = attrs(s[2] ?? "");
      r.counts.shapes = (r.counts.shapes ?? 0) + 1;
      const allowed = SHAPE_ATTRS[tag];
      if (allowed === undefined) {
        r.failures.push(`${id}: <${tag}> is not a path, a circle, or a rect`);
        continue;
      }
      if (sa.has("fill")) r.failures.push(`${id}: a <${tag}> sets a fill`);
      if (sa.has("stroke") || sa.has("stroke-width"))
        r.failures.push(`${id}: a <${tag}> sets its own stroke`);
      for (const k of sa.keys())
        if (!allowed.includes(k) && !PAINT_ATTRS.includes(k))
          r.failures.push(`${id}: a <${tag}> sets ${k}, which is not one of ${allowed.join(", ")}`);
      if (sa.get("pathLength") !== "1")
        r.failures.push(`${id}: a <${tag}> lacks pathLength="1", so the draw motion cannot run`);
      if (tag === "rect" && (sa.get("rx") !== "2" || (sa.has("ry") && sa.get("ry") !== "2")))
        r.failures.push(
          `${id}: a rect has rx=${sa.get("rx") ?? "none"} ry=${sa.get("ry") ?? "none"}; the radius is 2`,
        );
      const pts = shapePoints(tag, sa);
      if ("error" in pts) {
        r.failures.push(`${id}: ${pts.error}`);
        continue;
      }
      if (pts.points.length === 0) {
        r.failures.push(`${id}: a <${tag}> has no point`);
        continue;
      }
      const out = pts.points.find(
        ([x, y]) => !(x >= SAFE_MIN && x <= SAFE_MAX && y >= SAFE_MIN && y <= SAFE_MAX),
      );
      if (out)
        r.failures.push(`${id}: the point (${out[0]}, ${out[1]}) is outside the safe margin of 2`);
    }
  }
  for (const n of names) if (!seen.has(n)) r.failures.push(`the sprite has no symbol ${n}`);
  return requireCounts(r, ["symbols", "shapes"]);
}
