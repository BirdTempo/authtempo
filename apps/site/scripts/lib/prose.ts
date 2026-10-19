import { readRepoText } from "../../src/data/repo.ts";
import { cliHelpPages } from "./cli-help.ts";
import { compareProsePage } from "./compare-prose.ts";
import { demoProsePage } from "./demo-prose.ts";
import { featuresProsePage } from "./features-prose.ts";
import { homeProsePage } from "./home-prose.ts";
import { docsPages, sitePages } from "./load.ts";
import type { Page } from "./markdown.ts";
import { SITE_CONTENT } from "./paths.ts";
import { policyProsePages, rootProsePage } from "./root-prose.ts";

/**
 * Every page of prose that check-terms and check-sentences read. It holds the
 * docs and the entries of the collection `site` (spec 24 item 7). It holds the
 * home prose of plan 11b1 and the CLI help of plan 11c. From plan 11b, it holds
 * the package rows of /features/, the data of /pricing/ and /security/, and
 * the rows of /compare/. It also holds the data of /demo/, and SECURITY.md
 * when it exists. Both rows of check.ts call this one list. A test passes `policy` to read a
 * fixture in place of the root file.
 */
export function prosePages(
  siteDir: string = SITE_CONTENT,
  policy: string | null = readRepoText("SECURITY.md"),
): Page[] {
  return [
    ...docsPages(),
    ...sitePages(siteDir),
    homeProsePage(),
    featuresProsePage(),
    rootProsePage(),
    compareProsePage(),
    demoProsePage(),
    ...policyProsePages(policy),
    ...cliHelpPages(),
  ];
}
