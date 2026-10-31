/** What one release check read and what it found. */
export interface Report {
  name: string;
  /** What the check read, by kind: packages, released, unreleased. */
  counts: Record<string, number>;
  failures: string[];
  /** Facts that do not decide the result, one line each. The entry prints them after the summary. */
  notes: string[];
}

/**
 * The one line per check that the release check reads. A failure count comes
 * from this line, never from a count of the failure lines or an exit code alone.
 */
export function summaryLine(r: Report): string {
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
export function requireCounts(r: Report, keys: readonly string[]): Report {
  for (const key of keys) if ((r.counts[key] ?? 0) === 0) r.failures.push(`read 0 ${key}`);
  return r;
}

/** The lines that an entry prints: the summary line, each failure, and each note. */
export function reportLines(r: Report): string[] {
  return [
    summaryLine(r),
    ...r.failures.map((failure) => `  ${failure}`),
    ...r.notes.map((note) => `  note: ${note}`),
  ];
}

/**
 * The report of a check that could not read its input: each count is zero and
 * the reason is the one failure. The entry still prints its summary line.
 */
export function unreadReport(name: string, keys: readonly string[], reason: string): Report {
  return {
    name,
    counts: Object.fromEntries(keys.map((key) => [key, 0])),
    failures: [reason],
    notes: [],
  };
}
