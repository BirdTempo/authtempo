import { FEATURES } from "../../src/data/features.ts";
import { HOME } from "../../src/data/home.ts";
import { NAV_LINKS, SITE } from "../../src/data/site.ts";
import type { Page } from "./markdown.ts";

/** The path that a failure of check-terms or check-sentences names for the home prose. */
export const HOME_PROSE_PATH =
  "site/home (src/data/home.ts, src/data/features.ts, src/data/site.ts)";

/**
 * The prose of the root layout and the home page as one page, so check-terms
 * and check-sentences hold it (brand spec 2). Each string is one paragraph.
 * The title and the description are also in the body, because check-sentences
 * reads the body only. Plan 11b moves the root prose into its content collection `site`.
 */
export function homeProsePage(): Page {
  const paragraphs = [
    HOME.title,
    HOME.description,
    HOME.headline,
    HOME.lede,
    ...HOME.claims,
    HOME.cta,
    HOME.featuresTitle,
    ...Object.values(FEATURES).flatMap((f) => [f.title, f.line]),
    HOME.numbers.routes,
    HOME.numbers.vendors,
    HOME.skip,
    HOME.noLicense,
    ...NAV_LINKS.map((l) => l.label),
    SITE.nav,
    SITE.repo,
  ];
  return {
    path: HOME_PROSE_PATH,
    source: `---\ntitle: ${HOME.title}\ndescription: ${HOME.description}\n---\n\n${paragraphs.join("\n\n")}\n`,
  };
}
