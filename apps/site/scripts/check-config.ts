import { firstCells } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** Every key that createAuth accepts has a row on the config page, and every row names a key. */
export function checkConfig(html: string, keys: readonly string[]): CheckReport {
  const rows = firstCells(html);
  const r: CheckReport = {
    name: "check-config",
    counts: { keys: keys.length, rows: rows.length },
    failures: [],
  };
  const rowSet = new Set(rows);
  for (const k of keys) if (!rowSet.has(k)) r.failures.push(`config key ${k} has no row`);
  const keySet = new Set(keys);
  for (const row of rows) if (!keySet.has(row)) r.failures.push(`row ${row} names no config key`);
  return requireCounts(r, ["keys", "rows"]);
}
