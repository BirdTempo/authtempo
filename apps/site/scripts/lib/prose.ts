import { cliHelpPages } from "./cli-help.ts";
import { homeProsePage } from "./home-prose.ts";
import { docsPages, sitePages } from "./load.ts";
import type { Page } from "./markdown.ts";
import { SITE_CONTENT } from "./paths.ts";

/**
 * Every page of prose that check-terms and check-sentences read: the docs, the
 * entries of the collection `site` (spec 24 item 7), the home prose of plan
 * 11b1, and the CLI help of plan 11c. Both rows of check.ts call this one list.
 */
export function prosePages(siteDir: string = SITE_CONTENT): Page[] {
  return [...docsPages(), ...sitePages(siteDir), homeProsePage(), ...cliHelpPages()];
}
