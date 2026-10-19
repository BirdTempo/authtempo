import { CONFLICT_REASONS, type ImportReport, isRefusal } from "./types.js";

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

/** The answer of `authtempo import verify`, and of a verify bundle on D1 (spec 23 item 7). */
export interface ImportVerify {
  /** True when the database holds every record of the export. */
  held: boolean;
  /** The users and organizations that a real run would write. */
  wouldWrite: number;
  /** The records that exist but lack a row the export maps to. */
  partial: number;
  /** The refused hashes, the conflicts, and the refused records: each needs a person. */
  needPerson: number;
  /** The exit status of `import verify`: 0 only when the database holds the export. */
  code: 0 | 1;
}

// One rule for the CLI and the D1 Worker (spec 23 item 7). No Node module.
export function verifyReport(report: ImportReport): ImportVerify {
  const nothingToWrite = Object.values(report.created).every((n) => n === 0);
  const held = report.dryRun && exitCode(report) === 0 && nothingToWrite;
  const needPerson =
    report.refusedHashes.length +
    report.skipped.filter((s) => CONFLICT_REASONS.has(s.reason) || isRefusal(s.reason)).length;
  return {
    held,
    wouldWrite: report.created.user + report.created.organization,
    partial: report.partial.length,
    needPerson,
    code: held ? 0 : 1,
  };
}

/** The one line of the verify: counts and the fixed words, never a source id (spec 23 item 14). */
export function verifyLine(v: ImportVerify, report: ImportReport): string {
  return v.held
    ? `verify: the database holds this export: user ${report.exists.user}, organization ${report.exists.organization}`
    : `verify: the database does not hold this export: ${v.wouldWrite} records would be written, ${v.partial} partial, ${v.needPerson} need a person`;
}

export function summary(r: ImportReport): string[] {
  const lines = [
    `${r.source}${r.dryRun ? " (dry run, nothing written)" : ""}`,
    `created: ${Object.entries(r.created)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `exists: user ${r.exists.user}, organization ${r.exists.organization}`,
    `refusals: ${r.refusals}`,
    `hashes: ${
      Object.entries(r.hashFormats)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"
    }`,
  ];
  for (const s of r.skipped) lines.push(`skipped ${s.kind} ${s.sourceId}: ${s.reason}`);
  for (const h of r.refusedHashes) lines.push(`refused hash ${h.sourceId}: ${h.format}`);
  for (const p of r.partial)
    lines.push(
      `partial ${p.kind} ${p.sourceId}: missing ${p.missing.join(", ")}${p.repairRefused ? `; not repaired: ${p.repairRefused}` : ""}`,
    );
  for (const x of r.repaired) lines.push(`repaired ${x.kind} ${x.sourceId}: ${x.rows.join(", ")}`);
  for (const d of r.dropped) lines.push(`dropped ${d.sourceId}: ${d.item}`);
  return lines;
}
