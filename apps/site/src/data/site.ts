/**
 * The links of the root header (brand spec 9). Each page of plan 11b adds
 * its link with the page, so no link names a page that does not exist.
 */
export const NAV_LINKS: readonly { label: string; href: string }[] = [
  { label: "Docs", href: "/docs/" },
];

/**
 * The public repository, for the GitHub link of brand spec 9. No file of the
 * tree names one at f52b222. The owner sets it at publication; while it is
 * null, the header shows no GitHub link.
 */
export const REPO_URL: string | null = null;
