import { cssRules, declarations } from "./lib/css.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";
import { COLOR_TOKENS, parseTokens, STARLIGHT_COLORS } from "./lib/tokens.ts";

/** A source file of the site, by its path from apps/site/. */
export interface SourceFile {
  path: string;
  text: string;
}

const COLORS: readonly string[] = COLOR_TOKENS;
const STARLIGHT: readonly string[] = STARLIGHT_COLORS;
/** A hex color of 3, 4, 6, or 8 digits, with no word character, dot, or dash after it. */
const HEX = "#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\\w.-])";
const COLOR_FUNCTION = "\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(";
/** A literal color in a declaration value: a hex color or a color function. */
const COLOR_VALUE = new RegExp(`${HEX}|${COLOR_FUNCTION}`, "i");
/**
 * A literal color in a source text. A hex color sits in a value, a string,
 * a function argument, or a list. So a colon, a quote, a bracket, a comma,
 * or an equal sign precedes it. An id selector such as `#bad { }` has no
 * such prefix and a brace after it, so it is not a color.
 */
const LITERAL = new RegExp(`(?<=[:"'\`(,=]\\s*)${HEX}(?!\\s*\\{)|${COLOR_FUNCTION}`, "i");
/** A declaration that removes the focus ring, in any of its forms (brand spec 14). */
const NO_OUTLINE = /outline(?:-style|-width|-color)?\s*:\s*(?:none|0(?:px)?|transparent)\b/;

/**
 * The text that can hold a color. It is the whole text of a .css, .ts, .js,
 * .mjs, or .json file. It is the style blocks and the color attributes of
 * an .astro or .svg file.
 */
function colorText(f: SourceFile): string {
  if (/\.(css|ts|js|mjs|json)$/.test(f.path)) return f.text;
  const styles = [...f.text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "");
  const attrs = [...f.text.matchAll(/\s(?:fill|stroke|stop-color|color|style)="([^"]*)"/g)].map(
    (m) => m[1] ?? "",
  );
  return [...styles, ...attrs].join("\n");
}

/**
 * Brand spec 4 and 14. One token file holds every color. The light block
 * and the two dark blocks define the same color tokens. Each Starlight color
 * of the list maps to a token, and the map sets no other Starlight color.
 * The focus ring is in tokens.css, and no source removes it. No source
 * outside tokens.css holds a literal color. No source uses a token that
 * tokens.css does not define. The favicon is a standalone file: its colors
 * must be the ink and the accent.
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
  // The light block also holds the scheme-free tokens of later tasks, so the
  // rule reads the value's shape: a color value names a color token.
  for (const [name, value] of t.light)
    if (name.startsWith("--at-") && !COLORS.includes(name) && COLOR_VALUE.test(value))
      r.failures.push(`the light block sets ${name} to ${value}, which is not a color token`);
  for (const name of STARLIGHT_COLORS)
    if (!t.light.has(name)) r.failures.push(`tokens.css does not set ${name}`);
  for (const [name, value] of t.light) {
    if (!name.startsWith("--sl-color-")) continue;
    if (!STARLIGHT.includes(name)) {
      r.failures.push(`tokens.css sets ${name}, which is not a Starlight color of the map`);
      continue;
    }
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
