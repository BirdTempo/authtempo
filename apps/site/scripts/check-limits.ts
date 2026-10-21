import { columnCodes } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The family of a key cell such as `magic-link:email:<email>`: its first two parts. */
const FAMILY = /^([a-z][a-z-]*:[a-z][a-z-]*):/;

/**
 * The limits page against `LIMIT_FAMILIES`, both ways: each family has one
 * row in the Key column, and each row names a family (plan 12h Task 13).
 */
export function checkLimits(html: string, families: readonly string[]): CheckReport {
  const keys = columnCodes(html, ["Key"]);
  const r: CheckReport = {
    name: "check-limits",
    counts: { families: families.length, rows: keys.length },
    failures: [],
  };
  const seen = new Set<string>();
  for (const key of keys) {
    const family = FAMILY.exec(key)?.[1];
    if (family === undefined) {
      r.failures.push(`row ${key} is no key of a family`);
      continue;
    }
    if (!families.includes(family)) r.failures.push(`row ${key} names no limit family`);
    else if (seen.has(family)) r.failures.push(`family ${family} has two rows`);
    seen.add(family);
  }
  for (const f of families) if (!seen.has(f)) r.failures.push(`family ${f} has no row`);
  return requireCounts(r, ["families", "rows"]);
}
