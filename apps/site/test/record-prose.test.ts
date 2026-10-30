import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentMarkdown } from "../scripts/lib/agent.ts";
import { DOCS, REPO, SITE } from "../scripts/lib/paths.ts";
import { prosePages, RUNBOOK_PATH, recordProsePages } from "../scripts/lib/prose.ts";
import { changelogMarkdown, readChangelogFiles } from "../src/data/changelogs.ts";
import { REPO_ROOT, repositoryUrl } from "../src/data/repo.ts";
import { CHANGELOG_EMPTY } from "../src/data/unpublished.ts";

// Plan 12j Task 13: the record files of the release are Simplified Technical
// English, so check-terms and check-sentences read them through prosePages().
describe("the record files in the prose pages", () => {
  it("holds each changeset and the runbook", () => {
    const paths = prosePages().map((p) => p.path);
    const changesets = readdirSync(`${REPO}.changeset`)
      .filter((n) => n.endsWith(".md"))
      .map((n) => `.changeset/${n}`);
    expect(changesets.length).toBeGreaterThan(0);
    for (const path of [...changesets, RUNBOOK_PATH]) expect(paths, path).toContain(path);
    for (const c of readChangelogFiles(REPO_ROOT)) expect(paths).toContain(`${c.dir}/CHANGELOG.md`);
  });

  it("holds each package changelog, read from a tree that has them", () => {
    // The tree at 0.0.0 has no CHANGELOG.md, so the fixture tree proves the read.
    const pages = recordProsePages(`${SITE}test/fixtures/site/changelogs-group`);
    expect(pages.map((p) => p.path)).toEqual([
      "packages/client/CHANGELOG.md",
      "packages/core/CHANGELOG.md",
    ]);
    expect(pages.every((p) => p.plain === true && p.source.startsWith("# @authtempo/"))).toBe(true);
  });

  it("blanks the frontmatter of a changeset and keeps its line numbers", () => {
    // A fixture tree, since the version branch deletes each changeset (ruling 65 of plan 12j, C1).
    const [page, ...more] = recordProsePages(`${SITE}test/fixtures/site/changesets`);
    expect(more).toEqual([]);
    expect(page?.path).toBe(".changeset/fixture-change.md");
    expect(page?.source.split("\n")).toEqual([
      "",
      "",
      "",
      "",
      "",
      "A fixture change of two packages.",
      "",
    ]);
    expect(page?.plain).toBe(true);
  });

  it("reads each changeset present in the tree with the same blank form", () => {
    const pages = recordProsePages();
    const present = readdirSync(`${REPO}.changeset`).filter(
      (n) => n.endsWith(".md") && n !== "README.md",
    );
    for (const name of present) {
      const raw = readFileSync(`${REPO}.changeset/${name}`, "utf8").split("\n");
      const end = raw.indexOf("---", 1);
      expect(raw[0], name).toBe("---");
      expect(end, name).toBeGreaterThan(0);
      const page = pages.find((p) => p.path === `.changeset/${name}`);
      expect(page?.source.split("\n"), name).toEqual([
        ...raw.slice(0, end + 1).map(() => ""),
        ...raw.slice(end + 1),
      ]);
    }
  });
});

describe("the agent markdown of the changelog page", () => {
  it("holds the text that ChangelogList renders", () => {
    const path = "docs/changelog.mdx";
    const md = agentMarkdown({ path, source: readFileSync(`${DOCS}${path}`, "utf8") }, (p) =>
      readFileSync(`${DOCS}${p}`, "utf8"),
    );
    expect(md).toContain(
      changelogMarkdown(readChangelogFiles(REPO_ROOT), repositoryUrl, CHANGELOG_EMPTY),
    );
    expect(md).not.toContain("<ChangelogList");
  });
});
