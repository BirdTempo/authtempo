/** What one check read and what it found. */
export interface CheckReport {
  name: string;
  /** What the check read, by kind: pages, links, samples, codes. */
  counts: Record<string, number>;
  failures: string[];
}

/**
 * The one line per check that the evidence run reads. A failure count comes
 * from this line, never from a count of the failure lines.
 */
export function summaryLine(r: CheckReport): string {
  const counts = Object.entries(r.counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const verdict = r.failures.length === 0 ? "PASS" : "FAIL";
  return `${r.name}: ${verdict} ${counts} failures=${r.failures.length}`;
}

/**
 * Adds a failure for each listed count that is zero. A check that silently
 * reads nothing looks the same as a pass, so it fails here.
 */
export function requireCounts(r: CheckReport, keys: readonly string[]): CheckReport {
  for (const key of keys) if ((r.counts[key] ?? 0) === 0) r.failures.push(`read 0 ${key}`);
  return r;
}
