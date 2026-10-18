/** One rule of a style sheet that holds no nested rule. */
export interface CssRule {
  /** The preludes of the enclosing at-rules, joined by a space; "" at the top level. */
  at: string;
  /** The prelude of the rule itself: a selector, `@font-face`, or a keyframe step. */
  selector: string;
  body: string;
}

/**
 * Every innermost rule of a style sheet, in file order. Our own reader for
 * our own files: no comment, string, or URL in them holds a brace or a
 * semicolon. It reads tokens.css and the site's own sources only.
 */
export function cssRules(css: string): CssRule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const open: { prelude: string; start: number; nested: boolean }[] = [];
  let mark = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      const parent = open.at(-1);
      if (parent) parent.nested = true;
      open.push({
        prelude: src.slice(mark, i).trim().replace(/\s+/g, " "),
        start: i + 1,
        nested: false,
      });
      mark = i + 1;
    } else if (c === "}") {
      const block = open.pop();
      if (block && !block.nested)
        out.push({
          at: open.map((b) => b.prelude).join(" "),
          selector: block.prelude,
          body: src.slice(block.start, i),
        });
      mark = i + 1;
    } else if (c === ";") mark = i + 1;
  }
  return out;
}

/** The declarations of a rule body, by property name. A later one wins. */
export function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon > 0)
      out.set(
        part.slice(0, colon).trim(),
        part
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, " "),
      );
  }
  return out;
}
