import { FEATURES_PAGE, PACKAGE_FEATURES } from "../../src/data/features.ts";
import type { Page } from "./markdown.ts";

/** The path that a failure of check-terms or check-sentences names for this prose. */
export const FEATURES_PROSE_PATH = "site/features (src/data/features.ts)";

/**
 * The prose of /features/ that is not in its entry: the labels and the package
 * rows, one paragraph each. The feature rows are in the home prose already, so
 * they are not here twice. check-terms and check-sentences read this page.
 */
export function featuresProsePage(): Page {
  const paragraphs = [
    ...Object.values(FEATURES_PAGE),
    ...Object.values(PACKAGE_FEATURES).flatMap((p) => [p.title, p.line]),
  ];
  return {
    path: FEATURES_PROSE_PATH,
    source: `---\ntitle: ${FEATURES_PAGE.routes}\ndescription: ${FEATURES_PAGE.packages}\n---\n\n${paragraphs.join("\n\n")}\n`,
  };
}
