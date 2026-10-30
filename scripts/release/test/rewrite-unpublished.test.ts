import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkPreRelease } from "../../../apps/site/scripts/check-pre-release.ts";
import { checkUnpublished } from "../../../apps/site/scripts/check-unpublished.ts";
import {
  PRE_RELEASE_PATTERN,
  PRE_RELEASE_SENTENCES,
  REGISTRY_INSTALL,
  UNPUBLISHED_PAGES,
  VERSION_SLOT,
} from "../../../apps/site/src/data/unpublished.ts";
import { releasedNames } from "../src/lib/released.ts";
import { reportLines, summaryLine } from "../src/lib/report.ts";
import {
  noteForms,
  UNPUBLISHED_FILES,
  UNPUBLISHED_MARK,
  unpublishedFailures,
} from "../src/lib/unpublished.ts";
import { readWorkspace } from "../src/lib/workspace.ts";
import {
  DOCS_DIR,
  entry,
  REWRITE_LISTS,
  type RewriteLists,
  removeParagraph,
  rewriteUnpublished,
  rewrittenPaths,
} from "../src/rewrite-unpublished.ts";
import { copyFixture } from "./support/release-copy.ts";

// rewrite-unpublished (ruling 50 of plan 12j, item 1): the runbook step of the
// first release and the dry run run it, so each note goes by one list.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const readTree = (path: string) =>
  existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;

/** Each docs page of the tree, by its path under DOCS_DIR. */
function treePages(): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, DOCS_DIR, dir)).sort()) {
      const path = dir === "" ? name : `${dir}/${name}`;
      if (statSync(join(root, DOCS_DIR, path)).isDirectory()) walk(path);
      else if (/\.mdx?$/.test(name))
        out.push({ path, source: readTree(`${DOCS_DIR}${path}`) ?? "" });
    }
  };
  walk("");
  return out;
}

/** The packed text files of the released packages of the tree, but dist, which a build writes. */
function shippedFiles(): string[] {
  const released = new Set(releasedNames(root));
  const out: string[] = [];
  const add = (path: string) => {
    if (!existsSync(join(root, path))) return;
    if (!statSync(join(root, path)).isDirectory()) out.push(path);
    else for (const name of readdirSync(join(root, path)).sort()) add(`${path}/${name}`);
  };
  for (const p of readWorkspace(root))
    if (released.has(p.name))
      for (const f of ["package.json", "README.md", ...(p.manifest.files ?? [])])
        if (f !== "dist" && !f.startsWith("dist/")) add(`${p.dir}/${f}`);
  return out;
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("rewrite-unpublished on the tree", () => {
  it("rewrites each listed text of the tree, and the checks pass at the new version", () => {
    const r = rewriteUnpublished(readTree, "0.1.0");
    expect(r.failures).toEqual([]);
    // 12 packed files with 13 notes, 42 pages with 44 note lines, and 12 texts, 2 of them by hand.
    expect(summaryLine(r)).toBe(
      "rewrite-unpublished: PASS files=12 notes=13 pages=42 lines=44 texts=10 hand=2 failures=0",
    );
    // A listed file that the rewrite did not change fails here.
    expect([...r.texts.keys()].sort()).toEqual(rewrittenPaths());
    for (const [path, text] of r.texts) {
      expect(text, path).not.toBe(readTree(path));
      expect(noteForms(text), path).toEqual([]);
      expect(text, path).not.toContain(VERSION_SLOT);
    }
    const rewritten = (path: string) => r.texts.get(path) ?? readTree(path);

    // check-pack's rule on the shipped files at 0.1.0: no packed file holds a note form.
    const packed = shippedFiles();
    const marked = new Map(
      packed
        .map((p) => [p, noteForms(rewritten(p) ?? "")] as const)
        .filter(([, forms]) => forms.length > 0),
    );
    expect(
      unpublishedFailures({
        version: "0.1.0",
        packed,
        marked,
        lists: { files: UNPUBLISHED_FILES, code: [] },
        exists: () => true,
      }),
    ).toEqual([]);

    // check-unpublished at 0.1.0: no page holds the mark, and each listed page holds REGISTRY_INSTALL.
    const pages = treePages().map((p) => ({
      path: p.path,
      source: rewritten(`${DOCS_DIR}${p.path}`) ?? "",
    }));
    expect(
      checkUnpublished({
        version: "0.1.0",
        pages,
        listed: UNPUBLISHED_PAGES,
        mark: UNPUBLISHED_MARK,
        install: REGISTRY_INSTALL,
      }).failures,
    ).toEqual([]);

    // check-pre-release at 0.1.0: only the two texts of the runbook steps stay.
    expect(
      checkPreRelease({
        version: "0.1.0",
        listed: PRE_RELEASE_SENTENCES,
        read: rewritten,
        pages,
        pattern: PRE_RELEASE_PATTERN,
      }).failures,
    ).toEqual(
      PRE_RELEASE_SENTENCES.filter((e) => e.published === null).map(
        (e) => `${e.file}: core is at 0.1.0, and the file still holds the text: ${e.sentence}`,
      ),
    );
    expect(r.notes).toEqual(
      PRE_RELEASE_SENTENCES.filter((e) => e.published === null).map(
        (e) => `by hand: ${e.file}: ${e.sentence}`,
      ),
    );
  });

  it("writes the version in place of each slot", () => {
    const r = rewriteUnpublished(readTree, "0.3.0");
    expect(r.failures).toEqual([]);
    const readme = r.texts.get("packages/compat-better-auth/README.md") ?? "";
    expect(readme).toContain('"better-auth": "npm:@authtempo/compat-better-auth@0.3.0",');
    expect(readme).toContain('"@authtempo/core": "0.3.0",');
    expect(readme).not.toContain("@0.0.0");
    expect(r.texts.get("apps/site/src/data/compare.ts")).toContain(
      '"One version of every package, from 0.3.0."',
    );
  });
});

describe("rewrite-unpublished on fixture texts", () => {
  const README = "packages/x/README.md";
  const PAGE = "docs/a.md";
  const NOTE = "The packages are not on a registry yet.";
  const LISTS: RewriteLists = {
    files: [
      {
        path: README,
        notes: [{ form: UNPUBLISHED_MARK, note: NOTE, published: `Run x@${VERSION_SLOT}.` }],
      },
    ],
    pages: [PAGE],
    pageNotes: [
      { note: NOTE, published: "Install it." },
      { note: `- ${NOTE}`, published: "- Install it." },
    ],
    sentences: [
      { file: "SECURITY.md", sentence: "Until the first release, no.", published: "" },
      { file: "SECURITY.md", sentence: "No release yet.", published: null },
    ],
  };
  const TREE: Record<string, string> = {
    [README]: `# x\n\n${NOTE}\n`,
    [`${DOCS_DIR}${PAGE}`]: `# A\n\n${NOTE}\n\n- ${NOTE}\n- Another item.\n`,
    "SECURITY.md":
      "# S\n\n## Report\n\nUntil the first release, no.\n\n## Next\n\nNo release yet.\n",
  };
  const run = (tree: Record<string, string>, lists = LISTS, version = "0.1.0") =>
    rewriteUnpublished((p) => tree[p] ?? null, version, lists);

  it("replaces each note, each note line, and each text, and keeps a list mark", () => {
    const r = run(TREE);
    expect(r.failures).toEqual([]);
    expect(r.texts.get(README)).toBe("# x\n\nRun x@0.1.0.\n");
    expect(r.texts.get(`${DOCS_DIR}${PAGE}`)).toBe(
      "# A\n\nInstall it.\n\n- Install it.\n- Another item.\n",
    );
    // The removal leaves the heading "Report" with no text, so the heading goes too.
    expect(r.texts.get("SECURITY.md")).toBe("# S\n\n## Next\n\nNo release yet.\n");
    expect(reportLines(r)).toEqual([
      "rewrite-unpublished: PASS files=1 notes=1 pages=1 lines=2 texts=1 hand=1 failures=0",
      "  note: by hand: SECURITY.md: No release yet.",
    ]);
  });

  it("fails a note that its file lacks or holds twice", () => {
    expect(run({ ...TREE, [README]: "# x\n" }).failures).toEqual([
      `${README} holds a note of UNPUBLISHED_FILES 0 times, not once: ${NOTE}`,
    ]);
    expect(run({ ...TREE, [README]: `${NOTE}\n${NOTE}\n` }).failures).toEqual([
      `${README} holds a note of UNPUBLISHED_FILES 2 times, not once: ${NOTE}`,
      `${README} still holds the note "not on a registry yet" after the rewrite; its list lacks the text`,
    ]);
    const { [README]: _gone, ...noReadme } = TREE;
    expect(run(noReadme).failures).toEqual([
      `${README} is in UNPUBLISHED_FILES and does not exist`,
    ]);
  });

  it("fails a page line with a form that PAGE_NOTES lacks, and a page with no note line", () => {
    const page = `${DOCS_DIR}${PAGE}`;
    const odd = { ...TREE, [page]: `${TREE[page]}It is not published.\n` };
    expect(run(odd).failures).toEqual([
      `${page}:7: holds the note "it is not published", and PAGE_NOTES lacks the line`,
      `${page} still holds the note "it is not published" after the rewrite; its list lacks the text`,
    ]);
    expect(run({ ...TREE, [page]: "# A\n" }).failures).toEqual([
      `${page} is in UNPUBLISHED_PAGES and holds no line of PAGE_NOTES`,
    ]);
  });

  it("fails a form that the rewrite leaves, also across a line break", () => {
    // A second note in the file, outside the listed text: the P-note case of the review.
    const r = run({
      ...TREE,
      [README]: `# x\n\n${NOTE}\n\nWhen the package\nis published, run x.\n`,
    });
    expect(r.failures).toEqual([
      `${README} still holds the note "when the package is published" after the rewrite; its list lacks the text`,
    ]);
  });

  it("fails a text that is not a whole paragraph, a missing text, and a text twice", () => {
    const inline = { ...TREE, "SECURITY.md": "# S\n\nA. Until the first release, no.\n" };
    expect(run(inline).failures).toEqual([
      "SECURITY.md: the text is not a whole paragraph, so the rewrite cannot remove it: Until the first release, no.",
    ]);
    expect(run({ ...TREE, "SECURITY.md": "# S\n" }).failures).toEqual([
      "SECURITY.md holds a text of PRE_RELEASE_SENTENCES 0 times, not once: Until the first release, no.",
    ]);
    const twice = {
      ...TREE,
      "SECURITY.md": "Until the first release, no.\n\nUntil the first release, no.\n\n",
    };
    expect(run(twice).failures).toEqual([
      "SECURITY.md holds a text of PRE_RELEASE_SENTENCES 2 times, not once: Until the first release, no.",
    ]);
  });

  it("refuses a group at 0.0.0, and removes a paragraph only when it is whole", () => {
    const r = run(TREE, LISTS, "0.0.0");
    expect(r.failures).toEqual([
      "the group is at 0.0.0; run the rewrite after changeset version, at the version of the release",
    ]);
    expect(r.texts.size).toBe(0);
    expect(removeParagraph("A.\n\nB.\n\nC.\n", "B.")).toBe("A.\n\nC.\n");
    expect(removeParagraph("B.\n\nC.\n", "B.")).toBe("C.\n");
    expect(removeParagraph("A. B.\n\nC.\n", "B.")).toBeNull();
    expect(removeParagraph("A.\n\nB.\n", "B.")).toBeNull();
    // A heading with more text after the removal stays.
    expect(removeParagraph("## H\n\nB.\n\nC.\n", "B.")).toBe("## H\n\nC.\n");
    expect(removeParagraph("## H\n\nB.\n\n", "B.")).toBe("");
  });
});

describe("the entry of rewrite-unpublished", () => {
  const CLIENT = "packages/client/README.md";
  const NOTE = "The packages are not on a registry yet.";
  const LISTS: RewriteLists = {
    files: [
      { path: CLIENT, notes: [{ form: UNPUBLISHED_MARK, note: NOTE, published: "Run it." }] },
    ],
    pages: [],
    pageNotes: [],
    sentences: [],
  };
  /** The fixture tree at `version`, with the note in the client README. */
  const tree = (version: string) => {
    const dir = copyFixture((d) => {
      appendFileSync(join(d, CLIENT), `\n${NOTE}\n`);
      for (const p of ["packages/client", "packages/core"]) {
        const file = join(d, p, "package.json");
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace('"version": "0.0.0"', `"version": "${version}"`),
        );
      }
    });
    made.push(dir);
    return dir;
  };

  it("writes each file on a pass, and no file on a failure", () => {
    const dir = tree("0.1.0");
    expect(entry(dir, LISTS)).toEqual({
      lines: [
        "rewrite-unpublished: PASS files=1 notes=1 pages=0 lines=0 texts=0 hand=0 failures=0",
      ],
      code: 0,
    });
    expect(readFileSync(join(dir, CLIENT), "utf8")).toMatch(/\nRun it\.\n$/);
    // A second run finds no note, so it fails and writes nothing.
    const before = readFileSync(join(dir, CLIENT), "utf8");
    expect(entry(dir, LISTS).code).toBe(1);
    expect(readFileSync(join(dir, CLIENT), "utf8")).toBe(before);
    // At 0.0.0 the run fails and the note stays.
    const main = tree("0.0.0");
    expect(entry(main, LISTS).lines[0]).toBe(
      "rewrite-unpublished: FAIL files=0 notes=0 pages=0 lines=0 texts=0 hand=0 failures=1",
    );
    expect(readFileSync(join(main, CLIENT), "utf8")).toContain(NOTE);
  });

  it("reads the lists of the repository by default", () => {
    expect(REWRITE_LISTS.files).toBe(UNPUBLISHED_FILES);
    expect(REWRITE_LISTS.pages).toBe(UNPUBLISHED_PAGES);
    expect(REWRITE_LISTS.sentences).toBe(PRE_RELEASE_SENTENCES);
    // check-changesets exempts these paths on the version branch: each packed file of the lists is one.
    const paths = rewrittenPaths();
    for (const file of UNPUBLISHED_FILES) expect(paths).toContain(file.path);
    expect(paths).toContain("packages/compat-better-auth/README.md");
    expect(paths).not.toContain("apps/site/src/content/docs/docs/resources.md");
  });
});
