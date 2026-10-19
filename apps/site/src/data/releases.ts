/**
 * The feed /feed.xml (plan 11b Task 7, spec 24 item 6). Its path and title,
 * for the feed itself, the footer link, and the head link of the root pages.
 */
export const FEED_PATH = "/feed.xml";
export const FEED_TITLE = "authtempo releases";

/**
 * The date of each release, keyed `<package name>@<version>`, as an RFC 3339
 * date-time in UTC (YYYY-MM-DDTHH:MM:SSZ). Each feed entry takes its updated
 * date from its row (ruling 29 of the plan 11b lane).
 *
 * The release step adds one row with each new version heading of a
 * CHANGELOG.md. check-feed fails a heading with no row and a row with no
 * heading, and build-feed.ts fails a heading with no row. So a release cannot
 * ship with no date, and the two lists cannot drift.
 *
 * The date is a fact of the source, not of the build. Turbo hashes this file,
 * so a cached build writes the same feed as a fresh one. The build reads no
 * clock and no git commit.
 */
export const RELEASE_DATES: Readonly<Record<string, string>> = {};

/**
 * The updated date of a feed with no entry. RFC 4287 4.1.1 needs one updated
 * element on the feed. It is the date of plan 11b, which adds the feed.
 */
export const FEED_START = "2026-10-14T00:00:00Z";
