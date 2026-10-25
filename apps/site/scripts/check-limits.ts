import { cellCodes, cellText, tableRows } from "./lib/html.ts";
import type { LimitWindowFact } from "./lib/limit-windows.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The family of a key cell such as `magic-link:email:<email>`: its first two parts. */
const FAMILY = /^([a-z][a-z-]*:[a-z][a-z-]*):/;

/**
 * The families whose window the code builds at each call, so the source scan
 * reads no number. They are the window of a token (`rateLimitSeconds`) and
 * the poll interval of a device code. Their rows name the setting.
 */
export const DYNAMIC_LIMITS: ReadonlySet<string> = new Set([
  "token-use:tk",
  "token-use:to",
  "oauth-device-poll:code",
]);

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
};

/** The seconds of a Window cell such as "15 minutes" or "1 hour", else null. */
export function windowSeconds(text: string): number | null {
  const m = /^(\d+) (second|minute|hour|day)s?$/.exec(text.trim());
  if (m === null) return null;
  return Number(m[1]) * (UNIT_SECONDS[m[2] ?? ""] ?? Number.NaN);
}

/**
 * The limits page against `LIMIT_FAMILIES`, both ways: each family has one
 * row in the Key column, and each row names a family (plan 12h Task 13).
 * Each row's Window and Maximum also equal the window of each `limit` call
 * of its family in core (ruling 41 I1 of plan 12i). A part that the
 * code reads from a setting must name a setting in the cell.
 */
export function checkLimits(
  html: string,
  families: readonly string[],
  code: { facts: readonly LimitWindowFact[]; failures: readonly string[] },
): CheckReport {
  const rows = tableRows(html, "Key");
  const r: CheckReport = {
    name: "check-limits",
    counts: { families: families.length, rows: rows.length, calls: code.facts.length },
    failures: [...code.failures],
    exempt: [],
  };
  const byFamily = new Map<string, LimitWindowFact[]>();
  for (const f of code.facts) byFamily.set(f.family, [...(byFamily.get(f.family) ?? []), f]);
  const seen = new Set<string>();
  let compared = 0;
  for (const row of rows) {
    const key = cellCodes(row.Key ?? "")[0] ?? cellText(row.Key ?? "");
    const family = FAMILY.exec(key)?.[1];
    if (family === undefined) {
      r.failures.push(`row ${key} is no key of a family`);
      continue;
    }
    if (!families.includes(family)) r.failures.push(`row ${key} names no limit family`);
    else if (seen.has(family)) r.failures.push(`family ${family} has two rows`);
    seen.add(family);
    const calls = byFamily.get(family) ?? [];
    if (calls.length === 0) {
      if (families.includes(family)) r.failures.push(`family ${family} has no limit call in core`);
      continue;
    }
    const [first, ...rest] = calls;
    if (first === undefined) continue;
    for (const c of rest)
      if (c.seconds !== first.seconds || c.max !== first.max)
        r.failures.push(`family ${family} has two windows in core: ${first.at} and ${c.at}`);
    if (DYNAMIC_LIMITS.has(family)) {
      r.exempt?.push(`${family}: the code builds its window at each call`);
      continue;
    }
    const window = row.Window ?? "";
    const max = row.Maximum ?? "";
    if (first.seconds === null) {
      if (cellCodes(window).length === 0)
        r.failures.push(`row ${key}: the window comes from a setting, and the cell names none`);
    } else if (windowSeconds(cellText(window)) !== first.seconds)
      r.failures.push(
        `row ${key}: the window "${cellText(window)}" is not the ${first.seconds} s of ${first.at}`,
      );
    if (first.max === null) {
      if (cellCodes(max).length === 0)
        r.failures.push(`row ${key}: the maximum comes from a setting, and the cell names none`);
    } else if (cellText(max) !== String(first.max))
      r.failures.push(
        `row ${key}: the maximum "${cellText(max)}" is not the ${first.max} of ${first.at}`,
      );
    compared++;
  }
  r.counts.compared = compared;
  for (const f of families) if (!seen.has(f)) r.failures.push(`family ${f} has no row`);
  return requireCounts(r, ["families", "rows", "calls", "compared"]);
}
