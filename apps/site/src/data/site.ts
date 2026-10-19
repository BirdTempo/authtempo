/**
 * The site's own names (brand spec 9 and 13). They are the origin of the
 * canonical and Open Graph URLs, the docs path, and the two header labels.
 * One source for each: no template holds a copy.
 */
export const SITE = {
  origin: "https://authtempo.com",
  docs: "/docs/",
  /** The aria-label of the header nav. */
  nav: "Site",
  /** The label of the repository link, shown when REPO_URL is set. */
  repo: "GitHub",
} as const;

/**
 * The links of the root header (brand spec 9). Each page of plan 11b adds
 * its link with the page, so no link names a page that does not exist.
 */
export const NAV_LINKS: readonly { label: string; href: string }[] = [
  { label: "Docs", href: SITE.docs },
];

/**
 * The public repository, for the GitHub link of brand spec 9. No file of the
 * tree names one at f52b222. The owner sets it at publication; while it is
 * null, the header shows no GitHub link.
 */
export const REPO_URL: string | null = null;
