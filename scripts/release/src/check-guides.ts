import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Report, reportLines, requireCounts, unreadReport } from "./lib/report.ts";

/** The most days that a guide may stand after its `checkedOn` date. A guide of exactly this age passes. */
export const MAX_AGE_DAYS = 180;

const SRC = "packages/core/src/sso/guides";
const DIST = "packages/core/dist/sso/guides";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The part of an IdpGuide that this check reads. */
export interface GuideDate {
  id: string;
  /** The day that the owner checked the guide against the provider, YYYY-MM-DD. */
  checkedOn: string;
}

/** The time of a real calendar day in the form YYYY-MM-DD, or null. */
function dayTime(text: string): number | null {
  if (!DAY.test(text)) return null;
  const t = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === text ? t : null;
}

/**
 * Holds each guide to the age limit. `today` is an argument, so the result
 * is the same on each run with the same date. The release refuses a guide
 * that the owner did not check again within MAX_AGE_DAYS, because the
 * screens of a provider change.
 */
export function checkGuides(guides: readonly GuideDate[], today: string): Report {
  const failures: string[] = [];
  const now = dayTime(today);
  for (const g of guides) {
    const then = dayTime(g.checkedOn);
    if (then === null || now === null) {
      failures.push(`${g.id}: checkedOn ${g.checkedOn} is not a real date YYYY-MM-DD`);
      continue;
    }
    const age = Math.round((now - then) / 86_400_000);
    if (age > MAX_AGE_DAYS)
      failures.push(
        `${g.id}: checkedOn ${g.checkedOn} is ${age} days before ${today}; a guide is checked again within ${MAX_AGE_DAYS} days`,
      );
  }
  return requireCounts(
    { name: "check-guides", counts: { guides: guides.length }, failures, notes: [] },
    ["guides"],
  );
}

/** Each file of `dir` with its change time, or an empty list when the folder is not there. */
function filesOf(dir: string, ext: string): { path: string; time: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => ({ path: join(dir, f), time: statSync(join(dir, f)).mtimeMs }));
}

/**
 * Reads GUIDES from the built core, so the check reads build output. A build
 * that is older than the guide source would pass or fail on old dates, so it
 * fails here (the check reads the build, and the build is newer than the change).
 */
export async function entry(
  root: string,
  today: string,
): Promise<{ lines: string[]; code: number }> {
  const indexFile = `${DIST}/index.js`;
  const unread = (reason: string) => {
    const r = unreadReport("check-guides", ["guides"], reason);
    return { lines: reportLines(requireCounts(r, ["guides"])), code: 1 };
  };
  if (!existsSync(join(root, indexFile)))
    return unread(`${indexFile} does not exist; the build did not run`);
  const built = filesOf(join(root, DIST), ".js").reduce((a, b) => (b.time < a.time ? b : a));
  const source = filesOf(join(root, SRC), ".ts").reduce<{ path: string; time: number } | null>(
    (a, b) => (a === null || b.time > a.time ? b : a),
    null,
  );
  if (source !== null && built.time < source.time)
    return unread(
      `${DIST}/${basename(built.path)} is older than ${SRC}/${basename(source.path)}; the build is older than the change`,
    );
  const mod = (await import(pathToFileURL(join(root, indexFile)).href)) as {
    GUIDES?: readonly GuideDate[];
  };
  if (!Array.isArray(mod.GUIDES)) return unread(`${indexFile} exports no GUIDES list`);
  const report = checkGuides(mod.GUIDES, today);
  return { lines: reportLines(report), code: report.failures.length > 0 ? 1 : 0 };
}

if (import.meta.main) {
  // The date is an argument (`check-guides.ts 2027-03-01`), and the clock is the default.
  const today = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const { lines, code } = await entry(fileURLToPath(new URL("../../../", import.meta.url)), today);
  for (const line of lines) console.log(line);
  process.exit(code);
}
