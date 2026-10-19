import { HOME } from "./home.ts";

/**
 * One cost of the platform under authtempo, for /pricing/ (plan 11b Task 5).
 * `fact` is the line of the page. `page` and `anchor` name the docs section
 * that states it. `quote` is the sentence of that section that holds the
 * fact. A layout test fails a row with no source (ruling 19 of the plan 11b
 * lane).
 */
export interface PlatformCost {
  fact: string;
  page: string;
  anchor?: string;
  quote: string;
}

/** The costs of the platform, each from a docs page. The page states no price of its own. */
export const PLATFORM_COSTS: readonly PlatformCost[] = [
  {
    fact: "Password sign-in at the default cost needs Workers Paid.",
    page: "/docs/operations/deploy/",
    anchor: "the-workers-settings",
    quote: "One PBKDF2 hash needs more CPU than Workers Free gives one request.",
  },
  {
    fact: "D1 Time Travel goes back 7 days on Workers Free, and 30 days on Workers Paid.",
    page: "/docs/operations/backups/",
    anchor: "steps",
    quote: "It goes back 30 days on Workers Paid, and 7 days on Workers Free.",
  },
];

/** The labels of /pricing/ outside its entry. check-terms and check-sentences read them. */
export const PRICING_PAGE = {
  cost: "Cost",
  source: "Docs page",
} as const;

/**
 * The license line of /pricing/. While the root package.json has no license,
 * it states the empty state of the footer (HOME.noLicense) as a sentence.
 */
export function licenseLine(license: string | null): string {
  if (license === null)
    return `${HOME.noLicense.charAt(0).toUpperCase()}${HOME.noLicense.slice(1)}.`;
  return `The license is ${license}.`;
}
