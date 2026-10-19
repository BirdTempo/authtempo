import { renderMarkdown } from "./markdown.ts";

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

/**
 * SECURITY.md as HTML under the h2 "Report a fault" of /security/. Each heading
 * goes down two levels, to h6 at most. So the file adds no h1, and no h2 beside
 * the sections of the page (ruling 21 of the plan 11b lane).
 */
export async function renderPolicy(markdown: string): Promise<string> {
  const html = await renderMarkdown(markdown);
  return html.replace(/<(\/?)h([1-6])\b/g, (_m, close: string, level: string) => {
    return `<${close}h${Math.min(Number(level) + 2, 6)}`;
  });
}
