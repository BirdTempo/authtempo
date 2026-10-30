import { checkCsp } from "../check-csp.ts";
import { checkFeed, type FeedInput } from "../check-feed.ts";
import type { CheckReport } from "./report.ts";

/** The next step of a dist that the build did not write. */
const BUILD_STEP =
  "run `pnpm --filter @authtempo/site build`; it writes dist/_headers and dist/feed.xml";

/**
 * The checks of the deploy guard (ruling 14 of the plan 11b lane). check-csp
 * holds the written headers. check-feed holds dist/feed.xml (review of Task
 * 7, Low 3). build-feed.ts can fail after write-headers.ts wrote the headers.
 * That dist has no feed, so the footer and head links answer 404.
 */
export function guardReports(input: {
  pages: ReadonlyMap<string, string>;
  headers: string | null;
  files: ReadonlySet<string>;
  feed: FeedInput;
}): CheckReport[] {
  return [checkCsp(input.pages, input.headers, input.files), checkFeed(input.feed)];
}

/**
 * The next step of a failed guard (ruling 16 of the plan 11b lane). A missing
 * written file, or a template left in dist, asks for the build. A header of
 * a written dist/_headers that fails comes from public/_headers.template, so
 * a new build gives the same fault, and the hint names the template.
 */
export function guardHint(input: {
  reports: readonly CheckReport[];
  headers: string | null;
  feed: string | null;
}): string {
  const csp = input.reports.find((r) => r.name === "check-csp")?.failures ?? [];
  const unbuilt = csp.some((f) => f.includes("_headers.template") || f.includes("is missing"));
  if (input.headers === null || input.feed === null || unbuilt) return BUILD_STEP;
  if (csp.length > 0) return "fix public/_headers.template, then run the build again";
  return "fix RELEASE_DATES or the changelog that check-feed names, then run the build again";
}

/**
 * The failure of a guard with no dist folder, or null when the folder exists.
 * A missing dist stopped the guard with a stack of readdirSync, not a FAIL
 * line (final review D of plan 12j, L2). So the guard reads the folder first.
 */
export function distMissing(exists: boolean): string | null {
  return exists ? null : `apps/site/dist does not exist; ${BUILD_STEP}`;
}
