/**
 * The parts of /security/ outside its entry (plan 11b Task 5). check-terms
 * and check-sentences read the empty state with the other root prose.
 */
export const SECURITY_PAGE = {
  /** The stated empty state while SECURITY.md is absent (spec 24 item 3). Plan 12j writes the file. */
  noChannel: "The reporting channel is not set yet. It comes with the first release.",
} as const;

/** The docs pages under "Read more", in order (spec 24 item 2). Each link shows the page title. */
export const READ_MORE: readonly string[] = [
  "/docs/concepts/threat-model/",
  "/docs/reference/limits/",
  "/docs/reference/cookies/",
];
