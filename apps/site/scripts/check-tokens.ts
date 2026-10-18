import { cssRules, declarations } from "./lib/css.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";
import { COLOR_TOKENS, parseTokens } from "./lib/tokens.ts";

/** A source file of the site, by its path from apps/site/. */
export interface SourceFile {
  path: string;
  text: string;
}

const COLORS: readonly string[] = COLOR_TOKENS;
/** A literal color: a hex value or a color function. */
const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const NO_OUTLINE = /outline\s*:\s*(?:none|0)\b/;

/** The text that can hold a color: a whole .css file; the style blocks and color attributes of an .astro or .svg file. */
function colorText(f: SourceFile): string {
  if (f.path.endsWith(".css")) return f.text;
  const styles = [...f.text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "");
  const attrs = [...f.text.matchAll(/\s(?:fill|stroke|stop-color|color|style)="([^"]*)"/g)].map(
    (m) => m[1] ?? "",
  );
  return [...styles, ...attrs].join("\n");
}

/**
 * Brand spec 4 and 14: one token file for every color, the same color tokens
 * in the light and the two dark blocks, every Starlight color mapped to a
 * token, a focus ring that no source removes, no literal color outside
 * tokens.css, and no use of a token that tokens.css does not define. The
 * favicon is a standalone file: its colors must be the ink and the accent.
 */
export function checkTokens(input: {
  css: string;
  sources: readonly SourceFile[];
  favicon: string | null;
}): CheckReport {
  const t = parseTokens(input.css);
  const r: CheckReport = {
    name: "check-tokens",
    counts: { colors: 0, starlight: 0, sources: input.sources.length },
    failures: [],
  };
  for (const name of COLOR_TOKENS) {
    const light = t.light.get(name);
    const media = t.darkMedia.get(name);
    const attr = t.darkAttr.get(name);
    if (light === undefined) r.failures.push(`${name} has no light value`);
    if (media === undefined) r.failures.push(`${name} has no value in the dark media block`);
    if (attr === undefined) r.failures.push(`${name} has no value in the dark attribute block`);
    if (media !== undefined && attr !== undefined && media !== attr)
      r.failures.push(
        `${name} is ${media} in the dark media block and ${attr} in the dark attribute block`,
      );
    if (light !== undefined && media !== undefined && attr !== undefined)
      r.counts.colors = (r.counts.colors ?? 0) + 1;
  }
  for (const [label, block] of [
    ["dark media", t.darkMedia],
    ["dark attribute", t.darkAttr],
  ] as const)
    for (const name of block.keys())
      if (!COLORS.includes(name))
        r.failures.push(`the ${label} block sets ${name}, which is not a color token`);
  for (const [name, value] of t.light) {
    if (!name.startsWith("--sl-color-")) continue;
    const ref = /^var\((--at-[a-z-]+)\)$/.exec(value)?.[1];
    if (ref === undefined || !COLORS.includes(ref))
      r.failures.push(`${name} is ${value}; a Starlight color maps to var(<a color token>)`);
    else r.counts.starlight = (r.counts.starlight ?? 0) + 1;
  }
  const focus = cssRules(input.css).find((x) => x.at === "" && x.selector === ":focus-visible");
  const fd = focus ? declarations(focus.body) : new Map<string, string>();
  if (fd.get("outline") !== "2px solid var(--at-accent)" || fd.get("outline-offset") !== "2px")
    r.failures.push(
      "tokens.css lacks :focus-visible { outline: 2px solid var(--at-accent); outline-offset: 2px; }",
    );
  if (NO_OUTLINE.test(input.css)) r.failures.push("tokens.css removes the focus outline");
  for (const f of input.sources) {
    const text = colorText(f);
    const literal = LITERAL.exec(text);
    if (literal)
      r.failures.push(`${f.path} holds the literal color ${literal[0]}; use a token of tokens.css`);
    if (NO_OUTLINE.test(text)) r.failures.push(`${f.path} removes the focus outline`);
  }
  for (const f of [{ path: "src/styles/tokens.css", text: input.css }, ...input.sources])
    for (const name of new Set([...f.text.matchAll(/var\((--at-[a-z0-9-]+)/g)].map((m) => m[1])))
      if (name !== undefined && !t.light.has(name))
        r.failures.push(`${f.path} uses ${name}, which tokens.css does not define`);
  if (input.favicon !== null) {
    const allowed = new Set(
      [t.light.get("--at-ink"), t.darkAttr.get("--at-ink"), t.light.get("--at-accent")]
        .filter((v): v is string => v !== undefined)
        .map((v) => v.toLowerCase()),
    );
    for (const m of input.favicon.matchAll(/#[0-9a-f]{3,8}\b/gi))
      if (!allowed.has(m[0].toLowerCase()))
        r.failures.push(
          `public/favicon.svg holds ${m[0]}, which is not the ink or the accent of tokens.css`,
        );
  }
  return requireCounts(r, ["colors", "starlight", "sources"]);
}
