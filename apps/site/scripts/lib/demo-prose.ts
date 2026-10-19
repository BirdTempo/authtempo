import { DEMO_EXEMPT } from "@authtempo/demo/facts";
import { DEMO_OFF, DEMO_PAGE, limitRows } from "../../src/data/demo.ts";
import type { Page } from "./markdown.ts";

/** The path that a failure of check-terms or check-sentences names for this prose. */
export const DEMO_PROSE_PATH = "site/demo (src/data/demo.ts, @authtempo/demo/facts)";

/**
 * The prose of /demo/ that is not in its entry, one paragraph each. It holds
 * the reason of each exemption and each part that the design turns off. It
 * also holds each limit in words and the end lines. check-terms and
 * check-sentences read this page.
 */
export function demoProsePage(): Page {
  const paragraphs = [
    ...Object.values(DEMO_EXEMPT),
    ...DEMO_OFF.flatMap((x) => [x.name, x.reason]),
    ...limitRows().map((row) => row.text),
    DEMO_PAGE.notOpen,
    DEMO_PAGE.thenOpen,
    DEMO_PAGE.certificate,
    DEMO_PAGE.open,
  ];
  return {
    path: DEMO_PROSE_PATH,
    source: `---\ntitle: ${DEMO_PAGE.open}\ndescription: ${DEMO_PAGE.notOpen}\n---\n\n${paragraphs.join("\n\n")}\n`,
  };
}
