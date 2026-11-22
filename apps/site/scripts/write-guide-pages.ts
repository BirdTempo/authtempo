// Writes the page of each IdP guide of GUIDES (plan 13a Task 15) to the docs
// folder. Run it after a change of a guide text in core, and after a build of
// core: `node scripts/write-guide-pages.ts`. check-guide-pages fails while a
// page differs from its record.
import { writeFileSync } from "node:fs";
import { GUIDES } from "@authtempo/core";
import { guidePageMarkdown, guidePagePath } from "../src/data/guide-pages.ts";
import { DOCS } from "./lib/paths.ts";

for (const g of GUIDES) {
  writeFileSync(`${DOCS}${guidePagePath(g.id)}`, guidePageMarkdown(g));
  console.log(`write-guide-pages: ${guidePagePath(g.id)}`);
}
