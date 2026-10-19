import { createMarkdownProcessor, type MarkdownRenderer } from "@astrojs/markdown-remark";

let renderer: Promise<MarkdownRenderer> | null = null;

/**
 * Markdown to HTML by Astro's own processor (@astrojs/markdown-remark), for
 * the parts of a root page entry and for SECURITY.md (plan 11b Task 5). It
 * gives each heading its id, as a docs page has. Syntax highlight is off:
 * these texts hold no code block, and a highlight writes style attributes.
 */
export async function renderMarkdown(text: string): Promise<string> {
  renderer ??= createMarkdownProcessor({ syntaxHighlight: false });
  return (await (await renderer).render(text)).code;
}
