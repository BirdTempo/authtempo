import { describe, expect, it } from "vitest";
import { checkMigrate } from "../scripts/check-migrate.ts";
import type { Page } from "../scripts/lib/markdown.ts";

// The seven phases of spec 23 item 9, typed here and not read from PHASES.
const SEVEN = [
  "Export",
  "Carry the passwords",
  "Dry run",
  "Move",
  "Verify",
  "Change the calls",
  "Cut over",
];

/** A guide of `stem` with the H3 lines `phases` under Steps and both includes. */
function guide(stem: string, phases: readonly string[] = SEVEN): Page {
  const steps = phases.map((p) => `### ${p}\n\nOne sentence.\n`).join("\n");
  const source = [
    "---",
    `title: From ${stem}`,
    "---",
    'import { Code } from "@astrojs/starlight/components";',
    `import seam from "../../../../../samples/migrate/${stem}.ts?raw";`,
    `import test from "../../../../../samples/migrate/${stem}.test.ts?raw";`,
    "",
    "## Before you start",
    "",
    "- A list.",
    "",
    "## Steps",
    "",
    steps,
    "```sh",
    "### not a heading in a fence",
    "```",
    "",
    "## How it behaves",
    "",
    "### A heading after Steps",
    "",
  ].join("\n");
  return { path: `docs/migrate/${stem}.mdx`, source };
}

/** An index page with one row for each [stem, command] pair. */
function index(rows: readonly [string, string][]): Page {
  const lines = rows.map(
    ([stem, command]) => `| ${stem} | \`${command}\` | [From ${stem}](/docs/migrate/${stem}/) |`,
  );
  const source = [
    "---",
    "title: Choose a migration path",
    "---",
    "",
    "## Steps",
    "",
    "| Source | The command | Guide |",
    "| --- | --- | --- |",
    ...lines,
    "",
  ].join("\n");
  return { path: "docs/migrate/index.md", source };
}

const ROWS: [string, string][] = [
  ["a", "authtempo import a --users users.json --dry-run"],
  ["better-auth", "authtempo migrate --target postgres --tables compat --dry-run"],
];
const CUTOVER: Page = { path: "docs/migrate/cutover.md", source: "---\ntitle: The cutover\n---\n" };
const HTML = '<h3 id="x"><code>x</code></h3><h3 id="y"><code>y</code></h3>';
const REASONS = new Set(["x", "y"]);

function tree(guides: readonly Page[] = [guide("a"), guide("better-auth")], rows = ROWS): Page[] {
  return [...guides, index(rows), CUTOVER];
}

describe("checkMigrate", () => {
  it("passes a tree in the shape", () => {
    const r = checkMigrate(tree(), ["a"], HTML, REASONS);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ guides: 2, phases: 14, providers: 1, rows: 2, anchors: 2 });
    expect(r.exempt).toEqual([
      "better-auth: the compatibility package: the app keeps its tables (spec 16.2)",
    ]);
  });

  it("refuses two phases in the other order", () => {
    const swapped = ["Export", "Carry the passwords", "Move", "Dry run", "Verify"];
    const pages = tree([
      guide("a", [...swapped, "Change the calls", "Cut over"]),
      guide("better-auth"),
    ]);
    const r = checkMigrate(pages, ["a"], HTML, REASONS);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("docs/migrate/a.mdx");
    expect(r.failures[0]).toContain("Export, Carry the passwords, Move, Dry run, Verify");
  });

  it("refuses an H3 that is not a phase", () => {
    const pages = tree([guide("a", [...SEVEN, "Notes"]), guide("better-auth")]);
    const r = checkMigrate(pages, ["a"], HTML, REASONS);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("docs/migrate/a.mdx");
    expect(r.failures[0]).toContain("Cut over, Notes");
  });

  it("refuses a guide with no sample test and a guide with two samples", () => {
    const a = guide("a");
    const noTest = { ...a, source: a.source.replace(/^import test .*$/m, "") };
    expect(
      checkMigrate(tree([noTest, guide("better-auth")]), ["a"], HTML, REASONS).failures,
    ).toEqual(["docs/migrate/a.mdx imports 0 files samples/migrate/<x>.test.ts?raw; it needs one"]);
    const extra = 'import more from "../../../../../samples/migrate/b.ts?raw";';
    const twoSamples = {
      ...a,
      source: a.source.replace("## Before you start", `${extra}\n\n## Before you start`),
    };
    expect(
      checkMigrate(tree([twoSamples, guide("better-auth")]), ["a"], HTML, REASONS).failures,
    ).toEqual(["docs/migrate/a.mdx imports 2 files samples/migrate/<x>.ts?raw; it needs one"]);
  });

  it("refuses a provider with no guide, and a guide with no provider", () => {
    expect(checkMigrate(tree(), ["a", "b"], HTML, REASONS).failures).toEqual([
      "b has no guide in docs/migrate/",
    ]);
    const pages = tree(
      [guide("a"), guide("better-auth"), guide("c")],
      [...ROWS, ["c", "authtempo import c --users users.json"]],
    );
    expect(checkMigrate(pages, ["a"], HTML, REASONS).failures).toEqual([
      "docs/migrate/c.mdx: c is no provider of PROVIDER_FILES and no key of NO_READER",
    ]);
  });

  it("refuses a guide with no row and a row with the wrong command", () => {
    const noRow = tree(undefined, [ROWS[1] ?? ["", ""]]);
    expect(checkMigrate(noRow, ["a"], HTML, REASONS).failures).toEqual([
      "a has no row in docs/migrate/index.md",
    ]);
    const wrong = tree(undefined, [
      ["a", "authtempo import b --users users.json"],
      ["better-auth", "authtempo import better-auth --users users.json"],
    ]);
    expect(checkMigrate(wrong, ["a"], HTML, REASONS).failures).toEqual([
      "a: the command of its row in docs/migrate/index.md does not start with `authtempo import a `",
      "better-auth: the command of its row in docs/migrate/index.md does not start with `authtempo migrate `",
    ]);
  });

  it("refuses a guide with no Steps, a second row, a row of no guide, and no index", () => {
    const a = guide("a");
    const noSteps = { ...a, source: a.source.replace("## Steps", "## Moves") };
    expect(
      checkMigrate(tree([noSteps, guide("better-auth")]), ["a"], HTML, REASONS).failures,
    ).toEqual(["docs/migrate/a.mdx has no ## Steps"]);
    const extra = tree(undefined, [
      ...ROWS,
      ...ROWS.slice(0, 1),
      ["okta", "authtempo import okta"],
    ]);
    expect(checkMigrate(extra, ["a"], HTML, REASONS).failures).toEqual([
      "a row of docs/migrate/index.md links no guide: okta | `authtempo import okta` | [From okta](/docs/migrate/okta/)",
      "a has 2 rows in docs/migrate/index.md",
    ]);
    const noIndex = tree().filter((p) => p.path !== "docs/migrate/index.md");
    expect(checkMigrate(noIndex, ["a"], HTML, REASONS).failures).toEqual([
      "docs/migrate/index.md is missing",
      "a has no row in docs/migrate/index.md",
      "better-auth has no row in docs/migrate/index.md",
      "read 0 rows",
    ]);
  });

  it("refuses a conflict reason with no anchor", () => {
    const r = checkMigrate(tree(), ["a"], HTML, new Set(["x", "y", "z"]));
    expect(r.failures).toEqual(["z has no anchor on /docs/reference/cli/import/"]);
  });

  it("fails at zero guides", () => {
    const r = checkMigrate([], [], "", new Set());
    expect(r.failures).toContain("read 0 guides");
  });
});
