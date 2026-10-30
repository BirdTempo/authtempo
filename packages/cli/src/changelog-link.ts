// The changelog link of authtempo upgrade. It imports no Node.js module. The
// public entry does not export it, because each export of a released package
// is a promise of semver (review of plan 12j Task 13b, L10). The docs site
// test reads the built file dist/changelog-link.js by its path.

/** The changelog page of the docs site. */
export const CHANGELOG_PAGE = "https://authtempo.com/docs/changelog/";

/**
 * The changelog link of a crossed minor: the page with the anchor of the
 * heading `<minor>.0` (review of Task 10, Low 9). A minor bump of the group
 * always writes the version `<minor>.0`. The page gives each version heading
 * the github-slugger id, which drops each dot. The docs site holds this form
 * to its page through the built file.
 *
 * The limit: two versions can give one id. 0.1.10 and 0.11.0 both give 0110,
 * and 1.10.0 and 11.0.0 both give 1100. The page then gives the lower heading
 * the id 0110-1, and this link names the upper heading. The site check
 * check-changelog fails on two versions with one id, so such a release fails
 * before it ships.
 */
export const changelogLink = (minor: string): string =>
  `${CHANGELOG_PAGE}#${minor.replaceAll(".", "")}0`;
