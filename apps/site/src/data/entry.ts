/** An entry of the collection `site` cut at its h2 headings, for a root page of brand spec 10. */
export interface EntryParts {
  /** The first paragraph: the one-sentence lede of the hero (ruling 17 of the plan 11b lane). */
  lede: string;
  /** The rest of the text before the first h2, as markdown. */
  intro: string;
  /** Each h2 section, with its heading text and its markdown, the "## " line included. */
  sections: { heading: string; markdown: string }[];
}

/**
 * Cut an entry body. A page renders each part and puts its own table or
 * links after the section that names them, so the prose stays in the entry.
 */
export function entryParts(body: string): EntryParts {
  const [head = "", ...rest] = body.trim().split(/^(?=## )/m);
  const [lede = "", ...intro] = head.trim().split(/\n\s*\n/);
  return {
    lede: lede.trim(),
    intro: intro.join("\n\n").trim(),
    sections: rest.map((markdown) => ({
      heading: (/^## (.*)$/m.exec(markdown)?.[1] ?? "").trim(),
      markdown: markdown.trim(),
    })),
  };
}

/** The section of a heading, or a throw that names the entry, so a renamed heading stops the build. */
export function sectionOf(parts: EntryParts, heading: string, entry: string): string {
  const s = parts.sections.find((x) => x.heading === heading);
  if (s === undefined) throw new Error(`${entry}: no section "## ${heading}"`);
  return s.markdown;
}
