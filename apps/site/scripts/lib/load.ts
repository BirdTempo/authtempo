import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { FontManifest } from "../check-fonts.ts";
import { walk } from "./files.ts";
import type { Page } from "./markdown.ts";
import { DIST, DOCS, REPO, SITE } from "./paths.ts";

/** Every page source under src/content/docs/. */
export function docsPages(): Page[] {
  return walk(DOCS, (p) => /\.mdx?$/.test(p)).map((p) => ({
    path: p.slice(DOCS.length),
    source: readFileSync(p, "utf8"),
  }));
}

/** Every HTML file of dist, by its path relative to dist. */
export function distPages(): Map<string, string> {
  return new Map(
    walk(DIST, (p) => p.endsWith(".html")).map((p) => [
      p.slice(DIST.length),
      readFileSync(p, "utf8"),
    ]),
  );
}

/** Every file of dist, by its path relative to dist. */
export function distFiles(): Set<string> {
  return new Set(walk(DIST, () => true).map((p) => p.slice(DIST.length)));
}

/** The built page of a URL path such as /docs/reference/errors/. Throws when it is missing. */
export function distPage(urlPath: string): string {
  return readFileSync(`${DIST}${urlPath.slice(1)}index.html`, "utf8");
}

/**
 * The built page of a URL path, or "" when it is missing. A coverage check
 * then reports each code, route, key, or export as missing, and does not throw.
 */
export function distPageOrEmpty(urlPath: string): string {
  const file = `${DIST}${urlPath.slice(1)}index.html`;
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** The sample files that a page must include: every .ts under samples/ except tests and support. */
export function sampleFiles(): string[] {
  // Until the first sample lands (Task 6), samples/ does not exist. The fence
  // check then fails on "read 0 includes", so an empty list hides nothing.
  if (!existsSync(`${SITE}samples/`)) return [];
  return walk(`${SITE}samples/`, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts")).filter(
    (p) => !p.startsWith(`${SITE}samples/support/`),
  );
}

/** A repo file's text by its path from the repo root, or null when it does not exist. */
export function readRepoFile(path: string): string | null {
  const abs = `${REPO}${path}`;
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** A file of apps/site/ by its path from there, or null when it does not exist. */
export function readSiteFile(path: string): string | null {
  const abs = `${SITE}${path}`;
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/**
 * The site's own sources that can hold a color or a motion. They are each
 * .astro, .css, .svg, .ts, .js, .mjs, and .json file under src/ outside the
 * content, astro.config.mjs, and the sprite. tokens.css is not one: it is
 * the one place for a literal color. public/favicon.svg is not one: it is
 * a standalone file, and check-tokens reads it by its own input.
 */
export function siteSources(): { path: string; text: string }[] {
  const files = walk(
    `${SITE}src/`,
    (p) =>
      /\.(astro|css|svg|ts|js|mjs|json)$/.test(p) &&
      !p.startsWith(`${SITE}src/content/`) &&
      p !== `${SITE}src/styles/tokens.css`,
  );
  files.push(`${SITE}astro.config.mjs`);
  if (existsSync(`${SITE}public/icons.svg`)) files.push(`${SITE}public/icons.svg`);
  return files.map((p) => ({ path: p.slice(SITE.length), text: readFileSync(p, "utf8") }));
}

/**
 * The files of public/fonts/ by name, as bytes, and the names of its folders.
 * Both are empty when the folder does not exist. A folder is not read: the
 * check names it as a failure, and the runner still prints its summary line.
 */
export function fontDir(): { files: Map<string, Uint8Array>; folders: string[] } {
  const dir = `${SITE}public/fonts/`;
  const files = new Map<string, Uint8Array>();
  const folders: string[] = [];
  if (!existsSync(dir)) return { files, folders };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) folders.push(entry.name);
    else files.set(entry.name, new Uint8Array(readFileSync(`${dir}${entry.name}`)));
  }
  return { files, folders };
}

/** src/assets/fonts.json, or an empty record, so the check fails on "read 0 fonts". */
export function readFontManifest(): FontManifest {
  const text = readSiteFile("src/assets/fonts.json");
  if (text === null) return { tool: "", read: "", unicodes: "", sources: [], files: [] };
  return JSON.parse(text) as FontManifest;
}

/** A built file that can name a font: a style sheet, a page, or a script (brand spec 15). */
export function isBuiltText(path: string): boolean {
  return /\.(css|html|js)$/.test(path);
}

/** Each .css, .html, and .js file of dist, by its path relative to dist. */
export function distTexts(): Map<string, string> {
  return new Map(
    walk(DIST, isBuiltText).map((p) => [p.slice(DIST.length), readFileSync(p, "utf8")]),
  );
}
