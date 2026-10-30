// The changelog link of authtempo upgrade. It imports no Node.js module, so
// the public entry index.ts exports it to the docs site.

/** The changelog page of the docs site. */
export const CHANGELOG_PAGE = "https://authtempo.com/docs/changelog/";

/**
 * The changelog link of a crossed minor: the page with the anchor of the
 * heading `<minor>.0` (review of Task 10, Low 9). A minor bump of the group
 * always writes the version `<minor>.0`. The page gives each version heading
 * the github-slugger id, which drops each dot. The docs site holds this form
 * to its page through the export of index.ts.
 */
export const changelogLink = (minor: string): string =>
  `${CHANGELOG_PAGE}#${minor.replaceAll(".", "")}0`;
