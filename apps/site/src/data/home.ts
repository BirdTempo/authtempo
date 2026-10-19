/**
 * The copy of the home page and the root layout (brand spec 2 and 9). Every
 * string here is Simplified Technical English, and check-terms and
 * check-sentences read it through scripts/lib/home-prose.ts (Task 9).
 */
export const HOME = {
  title: "authtempo",
  description:
    "Auth that keeps its own time. One Worker, your database, every limit enforced by code you own.",
  headline: "Auth that keeps its own time.",
  lede: "One Worker, your database, every limit enforced by code you own.",
  claims: ["Owned, not rented.", "Built for the edge.", "Security you can read."],
  cta: "Read the docs",
  /** The heading of the stacks of `authtempo init` (spec 24 item 2; plan 11b Task 5). */
  start: "Start",
  featuresTitle: "Every piece, drawn to one grid.",
  /** The heading and the one link of the section Try it (plan 11b Task 12). */
  tryIt: "Try it",
  tryItLink: "Try each sign-in method in the demo",
  numbers: { routes: "routes", vendors: "vendors in the path" },
  skip: "Skip to the content",
  noLicense: "the license is not set yet",
} as const;
