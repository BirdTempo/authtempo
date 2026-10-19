import type { IconName } from "./icons.ts";

/**
 * The icon of each top-level sidebar group of astro.config.mjs, by its label
 * (brand spec 11). Starlight 0.42.6 refuses `attrs` on a group
 * (dist/schemas/sidebar.js: `attrs: z.never().optional()`), so the label is
 * the key. A group with no entry stops the build with its label.
 * Frameworks (plan 11d2) takes the two overlapped circles: the reader's
 * framework and authtempo meet on these pages.
 */
export const SIDEBAR_ICONS: Readonly<Record<string, IconName>> = {
  "Getting started": "start",
  Frameworks: "oauth",
  "How-to guides": "routes",
  Migration: "social",
  Operations: "cli",
  Reference: "client",
  Concepts: "verify",
  Versions: "limits",
};

export function sidebarIcon(label: string): IconName {
  const icon = SIDEBAR_ICONS[label];
  if (icon === undefined)
    throw new Error(
      `the sidebar group "${label}" has no icon; add it to SIDEBAR_ICONS in src/data/sidebar-icons.ts`,
    );
  return icon;
}
