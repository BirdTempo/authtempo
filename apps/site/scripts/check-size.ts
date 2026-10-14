import { statSync } from "node:fs";
import { walk } from "./lib/files.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

export interface FileSize {
  path: string;
  bytes: number;
}

/** Workers Free allows 20,000 files per version (read 2026-10-14). The margin covers plan 11b. */
export const MAX_FILES = 15_000;
/** Workers allows 25 MiB per file (read 2026-10-14). */
export const MAX_BYTES = 20 * 1024 * 1024;

export function checkSize(files: readonly FileSize[]): CheckReport {
  const r: CheckReport = {
    name: "check-size",
    counts: { files: files.length, largestBytes: Math.max(0, ...files.map((f) => f.bytes)) },
    failures: [],
  };
  if (files.length > MAX_FILES)
    r.failures.push(`dist holds ${files.length} files; the limit is ${MAX_FILES}`);
  for (const f of files)
    if (f.bytes > MAX_BYTES)
      r.failures.push(`${f.path} is ${f.bytes} bytes; the limit is ${MAX_BYTES}`);
  return requireCounts(r, ["files"]);
}

/** Every file of a build directory with its size. */
export function sizesOf(dist: string): FileSize[] {
  return walk(dist, () => true).map((p) => ({
    path: p.slice(dist.length),
    bytes: statSync(p).size,
  }));
}
