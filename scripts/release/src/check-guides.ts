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
  const counts = { guides: guides.length };
  // A bad date argument is one failure that names the argument, not one for each guide.
  if (now === null)
    return requireCounts(
      {
        name: "check-guides",
        counts,
        failures: [`the date ${today} is not a real date YYYY-MM-DD`],
        notes: [],
      },
      ["guides"],
    );
  for (const g of guides) {
    const then = dayTime(g.checkedOn);
    if (then === null) {
      failures.push(`${g.id}: checkedOn ${g.checkedOn} is not a real date YYYY-MM-DD`);
      continue;
    }
    const age = Math.round((now - then) / 86_400_000);
    // A date after the check date keeps a guide fresh for ever, so it fails too.
    if (age < 0) {
      failures.push(
        `${g.id}: checkedOn ${g.checkedOn} is after ${today}; a guide is not checked in the future`,
      );
      continue;
    }
    if (age > MAX_AGE_DAYS)
      failures.push(
        `${g.id}: checkedOn ${g.checkedOn} is ${age} days before ${today}; a guide is checked again within ${MAX_AGE_DAYS} days`,
      );
  }
  return requireCounts({ name: "check-guides", counts, failures, notes: [] }, ["guides"]);
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
  const sources = filesOf(join(root, SRC), ".ts");
  // Without the source the compare cannot run, and a moved source must not pass an old build.
  const [source] = [...sources].sort((a, b) => b.time - a.time);
  if (source === undefined)
    return unread(`${SRC} holds no .ts file; the build cannot be compared with the change`);
  if (built.time < source.time)
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

/**
 * The default check date: the calendar date at UTC+14, the latest date on
 * earth. The owner works at UTC+8. A UTC date is still the day before until
 * 08:00 local, so a guide checked that morning would show a false red
 * "checkedOn is after the check date". `now` is an argument, so a test sets it.
 */
export function defaultToday(now: Date): string {
  return new Date(now.getTime() + 14 * 3_600_000).toISOString().slice(0, 10);
}

if (import.meta.main) {
  // The date is an argument (`check-guides.ts 2027-03-01`), and the clock is the default.
  const today = process.argv[2] ?? defaultToday(new Date());
  const { lines, code } = await entry(fileURLToPath(new URL("../../../", import.meta.url)), today);
  for (const line of lines) console.log(line);
  process.exit(code);
}
