import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAgentIndex, sidebarOrder } from "../../../apps/site/scripts/lib/agent.ts";
import type { Page } from "../../../apps/site/scripts/lib/markdown.ts";
import type { AgentIndex } from "../src/index-format.js";
import { docsResources } from "../src/resources.js";
import { createServer } from "../src/server.js";
import { REPO } from "./support/bin.js";
import { connect } from "./support/client.js";
import { assertFreshIndex, siteIndex } from "./support/index.js";

type Session = Awaited<ReturnType<typeof connect>>;
let local: Session;
let remote: Session;
let small: Session;
let index: AgentIndex;

/** The page size of the small server. It is not a divisor of the page count, so the last page is short. */
const SMALL = 7;

beforeAll(async () => {
  assertFreshIndex();
  index = siteIndex();
  local = await connect(createServer({ surface: "local", index, skills: [], cli: "9.9.9" }));
  remote = await connect(createServer({ surface: "remote", index, skills: [] }));
  // The same server with a small page, so the paging test does not depend on the page count.
  small = await connect({
    ...createServer({ surface: "local", index, skills: [] }),
    resources: docsResources(index, SMALL),
  });
});
afterAll(async () => {
  await local?.close();
  await remote?.close();
  await small?.close();
});

/**
 * The URI of a page path, written out here and not read from resources.ts:
 * /docs/ is authtempo://docs/index, and /docs/a/b/ is authtempo://docs/a/b.
 */
function expectedUri(path: string): string {
  return path === "/docs/" ? "authtempo://docs/index" : `authtempo://docs/${path.slice(6, -1)}`;
}

interface Listed {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/**
 * Each page of resources/list, from the first call to the last cursor. The
 * client's listResources() with no cursor walks every page itself
 * (@modelcontextprotocol/client 2.3.1, read 2026-10-17). So each call here
 * is a raw request, which returns the server's own page.
 */
async function allPages(s: Session): Promise<Listed[][]> {
  const pages: Listed[][] = [];
  let cursor: string | undefined;
  for (;;) {
    const r = await s.client.request({
      method: "resources/list",
      params: cursor === undefined ? {} : { cursor },
    });
    pages.push(r.resources as Listed[]);
    if (r.nextCursor === undefined) return pages;
    cursor = r.nextCursor;
    // A list that never ends is a defect, not a long list.
    if (pages.length > 1000) throw new Error("resources/list gives a cursor without end");
  }
}

/** The error of a call that must fail. */
async function failure(
  p: Promise<unknown>,
): Promise<{ code: number; message: string; data: unknown }> {
  try {
    await p;
  } catch (e) {
    return e as { code: number; message: string; data: unknown };
  }
  throw new Error("the call did not fail");
}

describe("the docs resources", () => {
  it("lists every page once, in the sidebar order, both ways against the index", async () => {
    const listed = (await allPages(local)).flat();
    const uris = listed.map((r) => r.uri);
    expect(new Set(uris).size, "no URI twice").toBe(uris.length);
    // Each page of the index has its URI, and each URI is a page of the index.
    const fromIndex = index.pages.map((p) => expectedUri(p.path));
    for (const uri of fromIndex) expect(uris, "a page is missing").toContain(uri);
    for (const uri of uris) expect(fromIndex, "a URI has no page").toContain(uri);
    // The order is the sidebar of the built home page, read here with the site's own reader.
    const home = readFileSync(join(REPO, "apps/site/dist/docs/index.html"), "utf8");
    expect(uris).toEqual(sidebarOrder(home).map(expectedUri));
    expect(uris).toContain("authtempo://docs/guides/magic-link");
    expect(uris).toContain("authtempo://docs/index");
    for (const [i, r] of listed.entries()) {
      const page = index.pages[i];
      expect(r.mimeType, r.uri).toBe("text/markdown");
      expect(r.name, r.uri).toBe(page?.path);
      expect(r.title, r.uri).toBe(page?.title);
      expect(r.description, r.uri).toBe(page?.description);
    }
    // The remote surface serves the same list.
    expect((await allPages(remote)).flat()).toEqual(listed);
  });

  it("pages the list at 100 entries", async () => {
    const pages = await allPages(local);
    const n = index.pages.length;
    expect(pages[0]).toHaveLength(Math.min(100, n));
    expect(pages).toHaveLength(Math.ceil(n / 100));
    // With a page size of 7, every cursor leads on, and the union is the index in its order.
    const smallPages = await allPages(small);
    expect(smallPages).toHaveLength(Math.ceil(n / SMALL));
    for (const p of smallPages.slice(0, -1)) expect(p).toHaveLength(SMALL);
    expect(smallPages.flat().map((r) => r.uri)).toEqual(
      index.pages.map((p) => expectedUri(p.path)),
    );
    // A cursor that the list did not give is a protocol error -32602. Each
    // offset carries the key of a real cursor, so only the offset is wrong.
    // 5 and 99 are inside the list but are no page start.
    const first = (await small.client.request({ method: "resources/list", params: {} })).nextCursor;
    if (first === undefined) throw new Error("the small list gives no cursor");
    const key = first.slice(0, first.lastIndexOf(":"));
    expect(key.startsWith(`${index.header.commit}-`)).toBe(true);
    for (const offset of ["x", "0", "-7", "1.5", String(n), "007", "5", "99"]) {
      const cursor = `${key}:${offset}`;
      for (const s of [small, local]) {
        const e = await failure(s.client.listResources({ cursor }));
        expect(e.code, cursor).toBe(-32602);
      }
    }
    // The commit alone, the cursor form before the page hash, is no key.
    for (const cursor of ["x", "7", `other-commit:${SMALL}`, `${index.header.commit}:${SMALL}`]) {
      const e = await failure(small.client.listResources({ cursor }));
      expect(e.code, cursor).toBe(-32602);
    }
  });

  it("reads each page as the index's markdown", async () => {
    for (const page of index.pages) {
      const uri = expectedUri(page.path);
      const r = await local.client.readResource({ uri });
      expect(r.contents, uri).toHaveLength(1);
      const c = r.contents[0] as { uri: string; mimeType?: string; text?: string };
      expect(c.uri).toBe(uri);
      expect(c.mimeType, uri).toBe("text/markdown");
      expect(c.text, uri).toBe(page.markdown);
      // The .md twin that the site build wrote holds the same bytes.
      const twin = join(REPO, "apps/site/dist", page.path.slice(1), "index.md");
      expect(c.text, uri).toBe(readFileSync(twin, "utf8"));
    }
    const r = await remote.client.readResource({ uri: "authtempo://docs/guides/magic-link" });
    expect((r.contents[0] as { text?: string }).text).toBe(
      index.pages.find((p) => p.path === "/docs/guides/magic-link/")?.markdown,
    );
  });

  it("answers -32602 for a missing page, with the URI", async () => {
    for (const uri of [
      "authtempo://docs/guides/no-such-page",
      // The page path with its final slash is no resource URI.
      "authtempo://docs/guides/magic-link/",
      "authtempo://docs/",
      "authtempo://other/guides/magic-link",
    ]) {
      const e = await failure(local.client.readResource({ uri }));
      expect(e.code, uri).toBe(-32602);
      expect(e.data, uri).toEqual({ uri });
      expect(e.message, uri).toContain(uri);
    }
  });

  it("lists the one template", async () => {
    for (const s of [local, remote]) {
      const r = await s.client.listResourceTemplates();
      expect(r.resourceTemplates).toHaveLength(1);
      expect(r.resourceTemplates[0]).toMatchObject({
        uriTemplate: "authtempo://docs/{+path}",
        mimeType: "text/markdown",
      });
    }
  });
});

/** A page of a fixture tree, in the frontmatter form of the site (spec 18). */
function fixturePage(path: string, title: string): Page {
  const source = `---\ntitle: ${title}\ndescription: A page of the resources test.\ntype: how-to\nsources:\n  - packages/mcp/test/resources.test.ts\n---\n\n**For:** a reader of the resources test.\n\n## Notes\n\nNo text.\n`;
  return { path, source };
}

/** An index of a fixture tree, built by the site's own builder (the plan's fixture rule). */
function fixtureIndex(files: readonly string[], commit: string): AgentIndex {
  const pages = files.map((f, i) => fixturePage(f, `Page ${i}`));
  const order = files.map((f) => `/${f.replace(/\.md$/, "").replace(/(^|\/)index$/, "")}/`);
  return buildAgentIndex(pages, order, {
    commit,
    readFile: () => {
      throw new Error("the fixture has no include");
    },
    terms: {},
    bindings: [],
    groups: {},
  });
}

describe("the docs resources of a fixture tree", () => {
  it("refuses a page at /docs/index/ when the server is made, not when it lists", () => {
    // An author can write docs/index/index.md. Its URI would be the URI of the home page.
    const index = fixtureIndex(["docs/index.md", "docs/index/index.md"], "fixture");
    expect(index.pages.map((p) => p.path)).toEqual(["/docs/", "/docs/index/"]);
    expect(() => docsResources(index)).toThrow(
      "the page /docs/index/ has the URI of the home page",
    );
  });

  it("refuses a cursor of another index build", () => {
    const files = ["docs/a.md", "docs/b.md", "docs/c.md"];
    const first = docsResources(fixtureIndex(files, "commit-one"), 1);
    const second = docsResources(fixtureIndex(files, "commit-two"), 1);
    const cursor = first.list(undefined)?.nextCursor;
    if (cursor === undefined) throw new Error("the first list gives no cursor");
    expect(first.list(cursor)?.resources.map((r) => r.uri)).toEqual(["authtempo://docs/b"]);
    expect(second.list(cursor)).toBeNull();
  });

  it("refuses a cursor of an index with the same commit and other pages", () => {
    // A build with no git, or from a dirty tree, keeps the commit of another build.
    const first = docsResources(
      fixtureIndex(["docs/a.md", "docs/b.md", "docs/c.md"], "unknown"),
      1,
    );
    const second = docsResources(
      fixtureIndex(["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"], "unknown"),
      1,
    );
    const cursor = first.list(undefined)?.nextCursor;
    if (cursor === undefined) throw new Error("the first list gives no cursor");
    expect(cursor.startsWith("unknown-")).toBe(true);
    expect(first.list(cursor)?.resources.map((r) => r.uri)).toEqual(["authtempo://docs/b"]);
    expect(second.list(cursor)).toBeNull();
    // The same pages give the same key: one input, one cursor.
    const again = docsResources(
      fixtureIndex(["docs/a.md", "docs/b.md", "docs/c.md"], "unknown"),
      1,
    );
    expect(again.list(undefined)?.nextCursor).toBe(cursor);
  });
});
