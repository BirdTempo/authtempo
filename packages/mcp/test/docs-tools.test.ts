import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { REPO } from "./support/bin.js";
import { connect } from "./support/client.js";
import { assertFreshIndex, SITE_LLMS, siteIndex } from "./support/index.js";

type Session = Awaited<ReturnType<typeof connect>>;
let local: Session;
let remote: Session;

beforeAll(async () => {
  assertFreshIndex();
  const index = siteIndex();
  local = await connect(createServer({ surface: "local", index, skills: [], cli: "9.9.9" }));
  remote = await connect(createServer({ surface: "remote", index, skills: [] }));
});
afterAll(async () => {
  await local?.close();
  await remote?.close();
});

/** The structured content of a call that must succeed, with the text block checked against it. */
async function ok(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await local.call(name, args);
  expect(r.isError, JSON.stringify(r)).toBe(false);
  expect(r.texts).toHaveLength(1);
  expect(JSON.parse(r.texts[0] ?? "null")).toEqual(r.structured);
  if (!r.structured) throw new Error(`${name}: no structured content`);
  return r.structured;
}

async function search(query: string, more: Record<string, unknown> = {}) {
  const s = await ok("docs.search", { query, ...more });
  return s.results as {
    path: string;
    title: string;
    heading: string;
    anchor: string | null;
    snippet: string;
    type: string;
    score: number;
  }[];
}

describe("docs.search", () => {
  // Known queries on the real index. Each expected page is the page a person
  // opens for the question; the scorer under test does not give these values.
  it("finds the magic link guide first for 'magic link'", async () => {
    expect((await search("magic link"))[0]?.path).toBe("/docs/guides/magic-link/");
  });

  it("finds the second factor guide in the top three for '2FA'", async () => {
    const top = (await search("2FA")).slice(0, 3).map((h) => h.path);
    expect(top).toContain("/docs/guides/second-factor/");
  });

  it("finds the Clerk migration first for 'import from Clerk'", async () => {
    expect((await search("import from Clerk"))[0]?.path).toBe("/docs/migrate/clerk/");
  });

  it("finds key rotation first for 'rotate signing keys'", async () => {
    expect((await search("rotate signing keys"))[0]?.path).toBe("/docs/operations/key-rotation/");
  });

  it("answers the keys of each hit, a short snippet, and at most the limit", async () => {
    const hits = await search("session", { limit: 3 });
    expect(hits).toHaveLength(3);
    for (const h of hits) {
      expect(Object.keys(h).sort()).toEqual(
        ["anchor", "heading", "path", "score", "snippet", "title", "type"].sort(),
      );
      expect(h.snippet.length).toBeLessThanOrEqual(300);
      expect(h.snippet.length).toBeGreaterThan(0);
    }
    expect(new Set(hits.map((h) => h.path)).size).toBe(hits.length);
  });

  it("keeps to the type it is given", async () => {
    const hits = await search("session", { type: "reference", limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    const index = siteIndex();
    for (const h of hits) {
      expect(h.type).toBe("reference");
      expect(index.pages.find((p) => p.path === h.path)?.type).toBe("reference");
    }
  });

  it("refuses a docs version that the index lacks", async () => {
    const r = await local.call("docs.search", { query: "magic link", version: "1.0" });
    expect(r.isError).toBe(true);
    expect(r.structured?.versions).toEqual(["latest"]);
  });

  it("refuses a query of 201 characters, a limit of 11, and an extra key", async () => {
    for (const args of [
      { query: "a".repeat(201) },
      { query: "magic link", limit: 11 },
      { query: "magic link", extra: true },
      { query: "a" },
    ]) {
      const r = await local.call("docs.search", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect((await local.call("docs.search", { query: "a".repeat(200) })).isError).toBe(false);
  });
});

describe("docs.read", () => {
  it("answers the markdown of the index for every page", async () => {
    const index = siteIndex();
    for (const page of index.pages) {
      const r = await ok("docs.read", { path: page.path });
      expect(r).toEqual({
        version: "latest",
        path: page.path,
        title: page.title,
        description: page.description,
        type: page.type,
        sources: page.sources,
        markdown: page.markdown,
        links: page.links,
      });
    }
  });

  it("answers the index with no path: the llms.txt text and one link per page", async () => {
    const index = siteIndex();
    const r = await ok("docs.read", {});
    expect(r.path).toBe("/docs/");
    expect(r.title).toBe("authtempo docs index");
    // The site build writes llms.txt from the same index. The server rebuilds
    // the text, and this compare holds the two copies byte-equal.
    expect(r.markdown).toBe(readFileSync(SITE_LLMS, "utf8"));
    const links = r.links as string[];
    expect(links).toHaveLength(index.pages.length);
    expect([...links].sort()).toEqual(index.pages.map((p) => p.path).sort());
  });

  it("answers one section with a section anchor", async () => {
    const index = siteIndex();
    const path = "/docs/operations/key-rotation/";
    const sections = index.sections.filter((s) => s.path === path);
    const steps = sections.find((s) => s.anchor === "steps");
    if (!steps) throw new Error("the index lacks the steps section of key rotation");
    const r = await ok("docs.read", { path, section: "steps" });
    const markdown = r.markdown as string;
    expect(markdown.startsWith("## Steps\n\n")).toBe(true);
    expect(markdown).toContain(steps.text);
    for (const other of sections.filter((s) => s !== steps))
      expect(markdown).not.toContain(`## ${other.heading}\n`);
  });

  it("answers a level-2 section with its level-3 sections", async () => {
    const index = siteIndex();
    const sections = index.sections.filter((s) => s.path === "/docs/faq/");
    const at = sections.findIndex((s) => s.anchor === "questions");
    const parent = sections[at];
    if (!parent) throw new Error("the index lacks the questions section of the FAQ");
    // The FAQ keeps each question in a level-3 section, and the parent has no text.
    expect(parent.depth).toBe(2);
    expect(parent.text.trim()).toBe("");
    const children: typeof sections = [];
    for (const s of sections.slice(at + 1)) {
      if (s.depth === 2) break;
      children.push(s);
    }
    expect(children.length).toBeGreaterThan(1);
    const markdown = (await ok("docs.read", { path: "/docs/faq/", section: "questions" }))
      .markdown as string;
    expect(markdown.startsWith("## Questions\n\n")).toBe(true);
    for (const child of children) {
      expect(markdown).toContain(`### ${child.heading}\n\n`);
      expect(markdown).toContain(child.text);
    }
  });

  it("gives each hit a snippet, also for a section whose text is in its children", async () => {
    for (const query of ["vue exports", "faq questions", "session"])
      for (const hit of await search(query, { limit: 10 }))
        expect(hit.snippet.length, `${query}: ${hit.path}#${hit.anchor}`).toBeGreaterThan(0);
  });

  it("reads a path with no final slash and a full URL as the page", async () => {
    for (const path of [
      "/docs/guides/magic-link",
      "https://authtempo.com/docs/guides/magic-link/",
    ]) {
      const r = await ok("docs.read", { path });
      expect(r.path, path).toBe("/docs/guides/magic-link/");
    }
  });

  it("answers the nearest paths for an unknown path with no final slash", async () => {
    const r = await local.call("docs.read", { path: "/docs/guides/magic-links" });
    expect(r.isError).toBe(true);
    expect((r.structured?.suggestions as string[] | undefined)?.[0]).toBe(
      "/docs/guides/magic-link/",
    );
  });

  it("refuses an unknown section with the anchors of the page", async () => {
    const index = siteIndex();
    const path = "/docs/operations/key-rotation/";
    const r = await local.call("docs.read", { path, section: "no-such-part" });
    expect(r.isError).toBe(true);
    expect(r.structured?.anchors).toEqual(
      index.sections.filter((s) => s.path === path).map((s) => s.anchor),
    );
  });

  it("refuses an unknown path with the three nearest paths", async () => {
    const r = await local.call("docs.read", { path: "/docs/guides/magic-links/" });
    expect(r.isError).toBe(true);
    const near = r.structured?.suggestions as string[];
    expect(near).toHaveLength(3);
    expect(near[0]).toBe("/docs/guides/magic-link/");
    expect(r.texts[0] ?? "").toContain("/docs/guides/magic-link/");
  });

  it("refuses a docs version that the index lacks, with the list", async () => {
    const r = await local.call("docs.read", { path: "/docs/", version: "1.0" });
    expect(r.isError).toBe(true);
    expect(r.structured?.versions).toEqual(["latest"]);
  });

  it("refuses an extra key and a path outside /docs/", async () => {
    for (const args of [{ path: "/docs/", extra: 1 }, { path: "/etc/passwd" }])
      expect((await local.call("docs.read", args)).isError, JSON.stringify(args)).toBe(true);
  });
});

/**
 * The schema version from the migration files of the D1 adapter: the highest
 * NNNN_schema_vN.sql. This source does not pass through core's constant.
 */
const SCHEMA_FILE_VERSION = Math.max(
  ...readdirSync(join(REPO, "packages/adapter-d1/migrations")).map((f) =>
    Number(/^\d{4}_schema_v(\d+)\.sql$/.exec(f)?.[1] ?? 0),
  ),
);

describe("version", () => {
  const pkg = (path: string) =>
    (JSON.parse(readFileSync(join(REPO, path), "utf8")) as { version: string }).version;

  it("answers the versions and the index facts on the local surface", async () => {
    const index = siteIndex();
    const v = await ok("version", {});
    expect(v).toEqual({
      core: pkg("packages/core/package.json"),
      cli: "9.9.9",
      mcp: pkg("packages/mcp/package.json"),
      schemaVersion: SCHEMA_FILE_VERSION,
      protocol: "2026-07-28",
      docsIndex: {
        commit: index.header.commit,
        pages: index.pages.length,
        builtFrom: index.header.builtFrom,
      },
    });
  });

  it("puts each version in its own key", async () => {
    // Every package is 0.0.0, so a swap of core and mcp passes a compare of
    // values. A core with other values shows where each value goes.
    vi.resetModules();
    vi.doMock("@authtempo/core", async (load) => ({
      ...(await load<Record<string, unknown>>()),
      VERSION: "1.1.1",
      SCHEMA_VERSION: 77,
    }));
    try {
      const fresh = (await import("../src/server.js")).createServer;
      const session = await connect(
        fresh({ surface: "local", index: siteIndex(), skills: [], cli: "3.3.3" }),
      );
      try {
        const v = (await session.call("version", {})).structured;
        expect(v?.core).toBe("1.1.1");
        expect(v?.cli).toBe("3.3.3");
        expect(v?.mcp).toBe(pkg("packages/mcp/package.json"));
        expect(v?.schemaVersion).toBe(77);
      } finally {
        await session.close();
      }
    } finally {
      vi.doUnmock("@authtempo/core");
      vi.resetModules();
    }
  });

  it("answers cli null on the remote surface, with the same keys", async () => {
    const r = await remote.call("version", {});
    expect(r.isError).toBe(false);
    expect(r.structured?.cli).toBeNull();
    expect(Object.keys(r.structured ?? {}).sort()).toEqual(
      ["cli", "core", "docsIndex", "mcp", "protocol", "schemaVersion"].sort(),
    );
  });
});
