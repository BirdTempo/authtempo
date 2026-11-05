// The search index of the site build (plan 12q Task 0, decision 8).
//
// Starlight 0.42.6 builds the index with Pagefind 1.5.2 in its
// astro:build:done hook: createIndex, addDirectory, writeFiles, and then
// close. The Pagefind backend can answer writeFiles before its last file
// write lands, and close kills the backend. That file then stays empty. The
// release rehearsal of 2026-11-05 04:01 CST read an empty
// pagefind-entry.json. A probe of the same four calls on this site, at
// background priority, left that file empty in 1 run of 100 (2026-11-05
// 08:49 CST). A deploy of such a build ships a search that does not work.
//
// So the build checks the index after the hook of Starlight. When a file is
// empty, or the entry does not parse, the build indexes the site again. It
// takes the files from getFiles and writes each one with Node, so no write
// depends on the backend. A check that fails after that stops the build.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AstroIntegration } from "astro";

/** The calls of the Pagefind Node API that this file uses (pagefind 1.5.2, types/index.d.ts). */
export interface PagefindApi {
  createIndex(): Promise<{ errors: string[]; index?: PagefindIndex }>;
  close(): Promise<null>;
}

interface PagefindIndex {
  addDirectory(dir: { path: string }): Promise<{ errors: string[]; page_count: number }>;
  getFiles(): Promise<{ errors: string[]; files: { path: string; content: Uint8Array }[] }>;
}

/** The file that the search script of each page reads first. */
export const ENTRY = "pagefind-entry.json";

/** Each file under `dir`, relative to it. */
function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) =>
    statSync(join(dir, p)).isFile(),
  );
}

/**
 * The faults of the Pagefind folder `out`: each empty file, and the entry when
 * it is missing, does not parse, or counts no page. A lost write leaves an
 * empty file, because the backend makes the file before it writes to it.
 * @param out the folder of the bundle, dist/pagefind
 */
export function indexFaults(out: string): string[] {
  const files = existsSync(out) ? filesOf(out).sort() : [];
  const faults = files.filter((f) => statSync(join(out, f)).size === 0).map((f) => `${f} is empty`);
  if (!files.includes(ENTRY)) return [...faults, `${ENTRY} is missing`];
  if (statSync(join(out, ENTRY)).size === 0) return faults;
  try {
    const entry = JSON.parse(readFileSync(join(out, ENTRY), "utf8")) as {
      languages?: Record<string, { page_count?: number }>;
    };
    const pages = Object.values(entry.languages ?? {}).reduce((n, l) => n + (l.page_count ?? 0), 0);
    return pages > 0 ? faults : [...faults, `${ENTRY} counts no page`];
  } catch {
    return [...faults, `${ENTRY} does not parse`];
  }
}

/** The folder of package `name` in the first of `dirs` that holds it. */
function packageIn(dirs: readonly string[], name: string): string {
  for (const dir of dirs) if (existsSync(join(dir, name, "package.json"))) return join(dir, name);
  throw new Error(`${name} is not installed in ${dirs.join(", ")}`);
}

/**
 * Pagefind as Starlight imports it. The site has no Pagefind dependency of its
 * own, so the check uses the one copy and version that Starlight installs.
 */
export async function starlightPagefind(): Promise<PagefindApi> {
  const starlight = realpathSync(
    packageIn(
      createRequire(import.meta.url).resolve.paths("@astrojs/starlight") ?? [],
      "@astrojs/starlight",
    ),
  );
  const fromStarlight = createRequire(join(starlight, "package.json"));
  const pagefind = packageIn(fromStarlight.resolve.paths("pagefind") ?? [], "pagefind");
  const manifest = JSON.parse(readFileSync(join(pagefind, "package.json"), "utf8")) as {
    exports: { ".": { import: string } };
  };
  return (await import(
    pathToFileURL(join(pagefind, manifest.exports["."].import)).href
  )) as PagefindApi;
}

/**
 * Indexes the HTML files of `site` again and writes the bundle to `out`. Node
 * writes each file before close, so close cannot cut a write. Answers the
 * faults that are left.
 * @param pagefind the Pagefind API
 * @param site the build folder, dist
 * @param out the folder of the bundle, dist/pagefind
 */
export async function writeIndex(
  pagefind: PagefindApi,
  site: string,
  out: string,
): Promise<string[]> {
  try {
    const made = await pagefind.createIndex();
    if (made.index === undefined || made.errors.length > 0)
      throw new Error(`Pagefind createIndex failed: ${made.errors.join("; ")}`);
    const added = await made.index.addDirectory({ path: site });
    if (added.errors.length > 0)
      throw new Error(`Pagefind addDirectory failed: ${added.errors.join("; ")}`);
    const got = await made.index.getFiles();
    if (got.errors.length > 0)
      throw new Error(`Pagefind getFiles failed: ${got.errors.join("; ")}`);
    for (const file of got.files) {
      const path = join(out, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
  } finally {
    await pagefind.close();
  }
  return indexFaults(out);
}

/**
 * The check of the search index. It runs after the hook of Starlight, so it
 * comes after starlight() in the integrations of astro.config.mjs.
 * @param load the Pagefind API; the tests give their own
 */
export function searchIndex(
  load: () => Promise<PagefindApi> = starlightPagefind,
): AstroIntegration {
  return {
    name: "authtempo:search-index",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const site = fileURLToPath(dir);
        const out = join(site, "pagefind");
        const faults = indexFaults(out);
        if (faults.length === 0) return;
        logger.warn(
          `Pagefind lost a write: ${faults.join(", ")}. The build writes the index again.`,
        );
        const left = await writeIndex(await load(), site, out);
        if (left.length > 0)
          throw new Error(`The search index is not whole after a second write: ${left.join(", ")}`);
        logger.info("The search index is whole after a second write.");
      },
    },
  };
}
