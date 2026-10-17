import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AgentIndex, parseAgentIndex } from "../../src/index-format.js";
import { COPY, newestUnder, REPO } from "./bin.js";

/** The agent index of the site build, and the content tree it comes from. */
export const SITE_INDEX = join(REPO, "apps/site/dist/agent/index.json");
export const SITE_LLMS = join(REPO, "apps/site/dist/llms.txt");
const CONTENT = join(REPO, "apps/site/src/content/docs/docs");

let cached: AgentIndex | undefined;

/** The index that the site build wrote, through the format's own parser. */
export function siteIndex(): AgentIndex {
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(SITE_INDEX, "utf8");
  } catch {
    throw new Error(
      `${SITE_INDEX} is missing: run the site build first (pnpm turbo run build --filter=@authtempo/site)`,
    );
  }
  cached = parseAgentIndex(text);
  return cached;
}

/**
 * Fails when the site's index, or the package's copy of it, is older than a
 * file of the content tree. A test of an old index proves nothing about the docs.
 */
export function assertFreshIndex(): void {
  const newest = newestUnder(CONTENT);
  for (const file of [SITE_INDEX, COPY]) {
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      throw new Error(`${file} is missing: run pnpm turbo run index --filter=@authtempo/mcp`);
    }
    if (mtime < newest)
      throw new Error(
        `${file} is older than the content tree: run pnpm turbo run index --filter=@authtempo/mcp`,
      );
  }
}
