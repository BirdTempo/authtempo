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

function attrs(text: string): Map<string, string> {
  return new Map(
    [...text.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

/**
 * The points of a path: each end point and each control point. A cubic curve
 * lies inside the hull of its points, so these points bound the shape. Only
 * the absolute commands M, L, H, V, C, and Z are allowed: an arc or a
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

/** The points that bound a circle or a rect, or the points of a path. */
function shapePoints(
  tag: string,
  a: Map<string, string>,
): { points: [number, number][] } | { error: string } {
  const n = (k: string) => Number(a.get(k) ?? Number.NaN);
  if (tag === "path") return pathPoints(a.get("d") ?? "");
  if (tag === "circle")
    return {
      points: [
        [n("cx") - n("r"), n("cy") - n("r")],
        [n("cx") + n("r"), n("cy") + n("r")],
      ],
    };
  return {
    points: [
      [n("x"), n("y")],
      [n("x") + n("width"), n("y") + n("height")],
    ],
  };
}

export function checkIcons(sprite: string, names: readonly string[]): CheckReport {
  const r: CheckReport = { name: "check-icons", counts: { symbols: 0, shapes: 0 }, failures: [] };
  const seen = new Set<string>();
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
    for (const s of (m[2] ?? "").matchAll(/<([a-zA-Z]+)\b([^>]*?)\/?>/g)) {
      const tag = s[1] ?? "";
      const sa = attrs(s[2] ?? "");
      r.counts.shapes = (r.counts.shapes ?? 0) + 1;
      if (!["path", "circle", "rect"].includes(tag)) {
        r.failures.push(`${id}: <${tag}> is not a path, a circle, or a rect`);
        continue;
      }
      if (sa.has("fill")) r.failures.push(`${id}: a <${tag}> sets a fill`);
      if (sa.has("stroke") || sa.has("stroke-width"))
        r.failures.push(`${id}: a <${tag}> sets its own stroke`);
      if (sa.get("pathLength") !== "1")
        r.failures.push(`${id}: a <${tag}> lacks pathLength="1", so the draw motion cannot run`);
      if (tag === "rect" && (sa.get("rx") !== "2" || (sa.has("ry") && sa.get("ry") !== "2")))
        r.failures.push(`${id}: a rect has the radius ${sa.get("rx") ?? "0"}; the radius is 2`);
      const pts = shapePoints(tag, sa);
      if ("error" in pts) {
        r.failures.push(`${id}: ${pts.error}`);
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
