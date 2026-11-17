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
export const RELEASE_DATES: Readonly<Record<string, string>> = {
  "@authtempo/adapter-d1@0.1.0": "2026-11-16T09:18:16Z",
  "@authtempo/adapter-mysql@0.1.0": "2026-11-16T09:18:19Z",
  "@authtempo/adapter-postgres@0.1.0": "2026-11-16T09:19:22Z",
  "@authtempo/adapter-sqlite@0.1.0": "2026-11-16T09:16:25Z",
  "@authtempo/astro@0.1.0": "2026-11-16T09:15:56Z",
  "@authtempo/breach-check@0.1.0": "2026-11-16T09:16:28Z",
  "@authtempo/captcha-turnstile@0.1.0": "2026-11-16T09:16:32Z",
  "@authtempo/cli@0.1.0": "2026-11-16T09:16:19Z",
  "@authtempo/client@0.1.0": "2026-11-16T09:18:36Z",
  "@authtempo/compat-better-auth@0.1.0": "2026-11-16T09:16:12Z",
  "@authtempo/core@0.1.0": "2026-11-16T09:16:10Z",
  "@authtempo/express@0.1.0": "2026-11-16T09:17:24Z",
  "@authtempo/fastify@0.1.0": "2026-11-16T09:16:03Z",
  "@authtempo/handoff@0.1.0": "2026-11-16T09:15:47Z",
  "@authtempo/hono@0.1.0": "2026-11-16T09:17:28Z",
  "@authtempo/import@0.1.0": "2026-11-16T09:15:58Z",
  "@authtempo/legacy-hashes@0.1.0": "2026-11-16T09:15:53Z",
  "@authtempo/mcp@0.1.0": "2026-11-16T09:17:01Z",
  "@authtempo/next@0.1.0": "2026-11-16T09:17:05Z",
  "@authtempo/observe@0.1.0": "2026-11-16T09:17:39Z",
  "@authtempo/react@0.1.0": "2026-11-16T09:25:15Z",
  "@authtempo/react-router@0.1.0": "2026-11-16T09:19:15Z",
  "@authtempo/solid@0.1.0": "2026-11-16T09:18:18Z",
  "@authtempo/sveltekit@0.1.0": "2026-11-16T09:16:30Z",
  "@authtempo/tanstack-start@0.1.0": "2026-11-16T09:18:25Z",
  "@authtempo/verify@0.1.0": "2026-11-16T09:17:29Z",
  "@authtempo/vue@0.1.0": "2026-11-16T09:19:32Z",
};

/**
 * The updated date of a feed with no entry. RFC 4287 4.1.1 needs one updated
 * element on the feed. It is the date of plan 11b, which adds the feed.
 */
export const FEED_START = "2026-10-14T00:00:00Z";
