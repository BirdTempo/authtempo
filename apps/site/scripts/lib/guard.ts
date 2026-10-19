import { checkCsp } from "../check-csp.ts";
import { checkFeed, type FeedInput } from "../check-feed.ts";
import type { CheckReport } from "./report.ts";

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
