import { cssRules, declarations } from "./css.ts";

/** The nine color tokens of brand spec section 4, in its order. */
export const COLOR_TOKENS = [
  "--at-paper",
  "--at-surface",
  "--at-ink",
  "--at-mute",
  "--at-line",
  "--at-accent",
  "--at-accent-text",
  "--at-code",
  "--at-code-ink",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export const DARK_MEDIA = "@media (prefers-color-scheme: dark)";
export const DARK_MEDIA_SELECTOR = ':root:not([data-theme="light"])';
export const DARK_ATTR_SELECTOR = ':root[data-theme="dark"]';

/** The custom properties of tokens.css by scheme block. */
export interface TokenFile {
  /** Every top-level `:root` rule, merged: the light colors and the scheme-free tokens. */
  light: Map<string, string>;
  /** `:root:not([data-theme="light"])` in the dark media query: dark with no choice. */
  darkMedia: Map<string, string>;
  /** `:root[data-theme="dark"]`: dark by the toggle or by Starlight's select. */
  darkAttr: Map<string, string>;
}

export function parseTokens(css: string): TokenFile {
  const t: TokenFile = { light: new Map(), darkMedia: new Map(), darkAttr: new Map() };
  for (const r of cssRules(css)) {
    const target =
      r.at === "" && r.selector === ":root"
        ? t.light
        : r.at === DARK_MEDIA && r.selector === DARK_MEDIA_SELECTOR
          ? t.darkMedia
          : r.at === "" && r.selector === DARK_ATTR_SELECTOR
            ? t.darkAttr
            : null;
    if (target) for (const [k, v] of declarations(r.body)) if (k.startsWith("--")) target.set(k, v);
  }
  return t;
}
