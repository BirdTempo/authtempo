import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SITE } from "../scripts/lib/paths.ts";
import {
  ENTRY,
  indexFaults,
  type PagefindApi,
  searchIndex,
  starlightPagefind,
  writeIndex,
} from "../scripts/lib/search-index.ts";

// The check of the search index (plan 12q Task 0, decision 8). Pagefind 1.5.2
// can lose its last write when Starlight closes it, and the file stays empty.
// A probe of 2026-11-05 reached that state on this site, so these tests start
// from it.

const temp = mkdtempSync(join(tmpdir(), "authtempo-search-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;

/** A built site of two docs pages, as astro build writes them. */
function builtSite(): string {
  const dir = join(temp, `site-${++n}`);
  for (const [path, title] of [
    ["docs/sessions", "Sessions"],
    ["docs/passkeys", "Passkeys"],
  ] as const) {
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(
      join(dir, path, "index.html"),
      `<!doctype html><html lang="en"><head><title>${title}</title></head>` +
        `<body><main data-pagefind-body><h1>${title}</h1><p>The ${title} page.</p></main></body></html>`,
    );
  }
  return dir;
}

/** A built site with the whole index that Starlight's hook writes when no write is lost. */
async function indexedSite(): Promise<{ site: string; out: string }> {
  const site = builtSite();
  const out = join(site, "pagefind");
  expect(await writeIndex(await starlightPagefind(), site, out)).toEqual([]);
  return { site, out };
}

const pagesOf = (out: string) =>
  (
    JSON.parse(readFileSync(join(out, ENTRY), "utf8")) as {
      languages: { en: { page_count: number } };
    }
  ).languages.en.page_count;

type Hook = NonNullable<ReturnType<typeof searchIndex>["hooks"]["astro:build:done"]>;

/** Runs the hook as Astro does after the build, with a logger that keeps each line. */
async function runHook(site: string, load: () => Promise<PagefindApi> = starlightPagefind) {
  const lines: string[] = [];
  const logger = {
    warn: (m: string) => lines.push(`warn ${m}`),
    info: (m: string) => lines.push(`info ${m}`),
  };
  const hook = searchIndex(load).hooks["astro:build:done"] as Hook;
  await hook({ dir: pathToFileURL(`${site}/`), logger } as unknown as Parameters<Hook>[0]);
  return lines;
}

describe("the check of the search index (plan 12q)", () => {
  it("writes a whole index of the built pages through Starlight's Pagefind", async () => {
    const { out } = await indexedSite();
    expect(pagesOf(out)).toBe(2);
  });

  it("finds an empty file, an entry that is missing or cut, and an entry with no page", async () => {
    const { out } = await indexedSite();
    const entry = join(out, ENTRY);
    const whole = readFileSync(entry, "utf8");
    writeFileSync(entry, "");
    expect(indexFaults(out)).toEqual([`${ENTRY} is empty`]);
    writeFileSync(entry, whole.slice(0, 20));
    expect(indexFaults(out)).toEqual([`${ENTRY} does not parse`]);
    writeFileSync(entry, JSON.stringify({ version: "1.5.2", languages: {} }));
    expect(indexFaults(out)).toEqual([`${ENTRY} counts no page`]);
    rmSync(entry);
    expect(indexFaults(out)).toEqual([`${ENTRY} is missing`]);
    writeFileSync(entry, whole);
    writeFileSync(join(out, "pagefind.js"), "");
    expect(indexFaults(out)).toEqual(["pagefind.js is empty"]);
  });

  it("writes the index again after a lost write, with a warning", async () => {
    const { site, out } = await indexedSite();
    // The state of the probe: the backend made the entry file, and close cut its write.
    writeFileSync(join(out, ENTRY), "");
    const lines = await runHook(site);
    expect(lines).toEqual([
      `warn Pagefind lost a write: ${ENTRY} is empty. The build writes the index again.`,
      "info The search index is whole after a second write.",
    ]);
    expect(indexFaults(out)).toEqual([]);
    expect(pagesOf(out)).toBe(2);
  });

  it("leaves a whole index alone and loads no Pagefind", async () => {
    const { site } = await indexedSite();
    const load = () => Promise.reject(new Error("a whole index loaded Pagefind"));
    expect(await runHook(site, load)).toEqual([]);
  });

  it("stops the build when the second write is not whole, and closes Pagefind", async () => {
    const site = builtSite();
    let closed = false;
    // A second write that loses the entry too.
    const lossy: PagefindApi = {
      createIndex: async () => ({
        errors: [],
        index: {
          addDirectory: async () => ({ errors: [], page_count: 2 }),
          getFiles: async () => ({
            errors: [],
            files: [{ path: ENTRY, content: new Uint8Array() }],
          }),
        },
      }),
      close: async () => {
        closed = true;
        return null;
      },
    };
    await expect(runHook(site, async () => lossy)).rejects.toThrow(
      `The search index is not whole after a second write: ${ENTRY} is empty`,
    );
    expect(closed).toBe(true);
  });

  it("runs after starlight() in the integrations of the site config", () => {
    const config = readFileSync(`${SITE}astro.config.mjs`, "utf8");
    const list = config.slice(config.indexOf("integrations: ["));
    const starlight = list.indexOf("starlight({");
    const check = list.indexOf("searchIndex(),");
    expect({ starlight: starlight >= 0, check: check > starlight }).toEqual({
      starlight: true,
      check: true,
    });
  });
});
