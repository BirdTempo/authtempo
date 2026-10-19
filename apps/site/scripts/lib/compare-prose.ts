import {
  COMPARE_PAGE,
  COMPARE_ROWS,
  type CompareRow,
  HOSTED_MODELS,
  type HostedModel,
} from "../../src/data/compare.ts";
import type { Page } from "./markdown.ts";

/** The path that a failure of check-terms or check-sentences names for this prose. */
export const COMPARE_PROSE_PATH = "site/compare (src/data/compare.ts)";

/**
 * The prose of /compare/ that is not in its entry: the labels, each cell of
 * each row, and the model names, one paragraph each. check-terms and
 * check-sentences read this page. A test passes its own rows.
 */
export function compareProsePage(
  rows: readonly CompareRow[] = COMPARE_ROWS,
  models: readonly HostedModel[] = HOSTED_MODELS,
): Page {
  const paragraphs = [
    ...Object.values(COMPARE_PAGE),
    ...rows.flatMap((x) => [x.topic, x.authtempo, x.betterAuth]),
    ...models.flatMap((m) => [m.name, m.users, m.signIn]),
  ];
  return {
    path: COMPARE_PROSE_PATH,
    source: `---\ntitle: ${COMPARE_PAGE.topic}\ndescription: ${COMPARE_PAGE.read}\n---\n\n${paragraphs.join("\n\n")}\n`,
  };
}
