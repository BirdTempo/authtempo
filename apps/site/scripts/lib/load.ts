import { existsSync, readFileSync } from "node:fs";
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
