import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentIndex } from "../../../apps/site/scripts/lib/agent.ts";
import type { Page } from "../../../apps/site/scripts/lib/markdown.ts";
import { searchSections, tokenize } from "../src/search.js";
import { PKG, REPO } from "./support/bin.js";
import { siteIndex } from "./support/index.js";

/** A page of the fixture tree, in the frontmatter form of the site (spec 18). */
function page(path: string, title: string, sections: Record<string, string>): Page {
  const body = Object.entries(sections)
    .map(([heading, text]) => `## ${heading}\n\n${text}\n`)
    .join("\n");
  const source = `---\ntitle: ${title}\ndescription: A page of the search test.\ntype: how-to\nsources:\n  - packages/mcp/test/search.test.ts\n---\n\n**For:** a reader of the search test.\n\n${body}`;
  return { path, source };
}

/**
 * The fixture index, built by the site's own builder (the plan's fixture
 * rule). The sidebar order puts beta before alpha, so a tie that follows the
 * sidebar does not follow the path or the title.
 */
const fixture = buildAgentIndex(
  [
    page("docs/guides/alpha.md", "Alpha guide", { Notes: "Set the zephyr value once." }),
    page("docs/guides/beta.md", "Beta guide", { Notes: "Set the zephyr value once." }),
    page("docs/guides/quokka.md", "Quokka setup", {
      Steps: "Run the command and read its output.",
    }),
    page("docs/guides/other.md", "Other topic", {
      Steps: "The quokka option changes the output.",
    }),
  ],
  ["/docs/guides/beta/", "/docs/guides/alpha/", "/docs/guides/quokka/", "/docs/guides/other/"],
  {
    commit: "fixture",
    readFile: () => {
      throw new Error("the fixture has no include");
    },
    terms: { "2fa": "second factor", mfa: "second factor", "two-factor": "second factor" },
    bindings: [],
    groups: {},
  },
);

describe("tokenize", () => {
  const terms = { "2fa": "second factor", mfa: "second factor", "two-factor": "second factor" };

  it("maps 2FA, MFA, and two-factor to the tokens of second factor", () => {
    for (const word of ["2FA", "MFA", "two-factor", "Two Factor"])
      expect(tokenize(word, terms), word).toEqual(["second", "factor"]);
    expect(tokenize("turn on 2FA now", terms)).toEqual(["turn", "on", "second", "factor", "now"]);
  });

  it("maps the same words through the terms of the real index", () => {
    const real = siteIndex().header.terms;
    for (const word of ["2FA", "MFA", "two-factor"])
      expect(tokenize(word, real), word).toEqual(["second", "factor"]);
  });

  it("lowercases and splits on each character that is no letter or digit", () => {
    expect(tokenize("Key_Rotation: v2.1/now", {})).toEqual(["key", "rotation", "v2", "1", "now"]);
  });
});

describe("searchSections", () => {
  it("ranks a title match above a body match of the same term", () => {
    const hits = searchSections(fixture, "quokka", { limit: 5 });
    expect(hits.map((h) => h.path)).toEqual(["/docs/guides/quokka/", "/docs/guides/other/"]);
  });

  it("gives the same order for the same query twice", () => {
    const a = searchSections(siteIndex(), "session token", { limit: 10 });
    const b = searchSections(siteIndex(), "session token", { limit: 10 });
    expect(a.length).toBeGreaterThan(1);
    expect(b).toEqual(a);
  });

  it("sorts a tie by the sidebar order", () => {
    const hits = searchSections(fixture, "zephyr", { limit: 5 });
    expect(hits.map((h) => h.path)).toEqual(["/docs/guides/beta/", "/docs/guides/alpha/"]);
    expect(hits[0]?.score).toBe(hits[1]?.score);
  });

  it("answers no hit for a word that no page holds", () => {
    expect(searchSections(fixture, "nonexistentword", { limit: 5 })).toEqual([]);
  });
});

describe("the files of the remote surface", () => {
  // The remote server runs on a Worker (Task 16), where no Node module exists.
  // These files are its part of src/. The repo's one no-Node check reads a
  // folder, so the test copies the files into a new folder and runs it there.
  const WORKER_FILES = [
    "index-format.ts",
    "spec.ts",
    "tools.ts",
    "search.ts",
    "docs-tools.ts",
    "server.ts",
    "protocol.ts",
    "index.ts",
  ];

  it("import no Node module", () => {
    const dir = mkdtempSync(join(tmpdir(), "authtempo-mcp-no-node-"));
    try {
      for (const f of WORKER_FILES) copyFileSync(join(PKG, "src", f), join(dir, f));
      const r = spawnSync(process.execPath, [join(REPO, "scripts/check-no-node.mjs"), dir], {
        encoding: "utf8",
      });
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain(`no-node: PASS files=${WORKER_FILES.length}`);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
