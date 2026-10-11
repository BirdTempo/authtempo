import { CONFLICT_REASONS, type ImportReport } from "./types.js";

// No Node.js module here: the CLI and the D1 Worker both read the exit status
// and the summary from this file (worker/src/index.ts).

/**
 * The CLI's exit status for a finished report: 1 when a person must look.
 * That is a refused hash, a refusal (`report.refusals`, the skips that
 * `isRefusal` names), a conflict (`CONFLICT_REASONS`), or a partial record.
 * A policy skip that the export states (deleted, banned) does not count.
 */
export function exitCode(report: ImportReport): 0 | 1 {
  return report.refusedHashes.length > 0 ||
    report.refusals > 0 ||
    report.partial.length > 0 ||
    report.skipped.some((s) => CONFLICT_REASONS.has(s.reason))
    ? 1
    : 0;
}

export function summary(r: ImportReport): string[] {
  const lines = [
    `${r.source}${r.dryRun ? " (dry run, nothing written)" : ""}`,
    `created: ${Object.entries(r.created)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `exists: user ${r.exists.user}, organization ${r.exists.organization}`,
    `refusals: ${r.refusals}`,
  ];
  for (const s of r.skipped) lines.push(`skipped ${s.kind} ${s.sourceId}: ${s.reason}`);
  for (const h of r.refusedHashes) lines.push(`refused hash ${h.sourceId}: ${h.format}`);
  for (const p of r.partial)
    lines.push(`partial ${p.kind} ${p.sourceId}: missing ${p.missing.join(", ")}`);
  for (const d of r.dropped) lines.push(`dropped ${d.sourceId}: ${d.item}`);
  return lines;
}
