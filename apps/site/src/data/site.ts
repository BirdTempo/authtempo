import { FEED_PATH } from "./releases.ts";

/**
 * The site's own names (brand spec 9 and 13). They are the origin of the
 * canonical and Open Graph URLs, the docs path, and the labels of the header
 * and the footer.
 * One source for each: no template holds a copy.
 */
export const SITE = {
  origin: "https://authtempo.com",
  docs: "/docs/",
  /** The aria-label of the header nav. */
  nav: "Site",
  /** The aria-label of the footer nav. */
  footerNav: "Footer",
  /** The label of the repository link, shown when REPO_URL is set. */
  repo: "GitHub",
} as const;

/**
 * The links of the root header (brand spec 9). Each page of plan 11b adds
 * its link with the page, so no link names a page that does not exist.
 * Compare comes right after Docs (ruling 7 of the plan 11b lane).
 */
export const NAV_LINKS: readonly { label: string; href: string }[] = [
  { label: "Docs", href: SITE.docs },
  { label: "Compare", href: "/compare/" },
];

/**
 * The links of the root footer (plan 11b, ruling 7 of its lane): Features,
 * Pricing, Security, the changelog, and the feed. Each one joins with its
 * page, as a header link does. Task 4 of plan 11b adds Features, Task 5 adds
 * Pricing and Security, and Task 7 adds the feed.
 */
export const FOOTER_LINKS: readonly { label: string; href: string }[] = [
  { label: "Features", href: "/features/" },
  { label: "Pricing", href: "/pricing/" },
  { label: "Security", href: "/security/" },
  { label: "Changelog", href: `${SITE.docs}changelog/` },
  { label: "Feed", href: FEED_PATH },
];

/**
 * The public repository, for the GitHub link of brand spec 9. No file of the
 * tree names one at f52b222. The owner sets it at publication; while it is
 * null, the header shows no GitHub link.
 */
export const REPO_URL: string | null = null;
