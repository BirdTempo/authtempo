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

/** The real import and the verify on the copy, as ruling 15 of plan 11f asks before the cutover. */
const MOVE = (stem: string) =>
  `authtempo import ${stem} --users users.json --target postgres --url-env COPY_URL`;
const VERIFY = (stem: string) =>
  `authtempo import verify ${stem} --users users.json --target postgres --url-env COPY_URL`;

/** The body of one phase. Move and Verify hold their command on the copy in a fence. */
function body(stem: string, phase: string): string {
  if (phase === "Move")
    return `Run it on a copy. [One real import](/docs/migrate/cutover/#one-real-import) tells why.\n\n\`\`\`sh\n${MOVE(stem)}\n\`\`\`\n`;
  if (phase === "Verify") return `One sentence.\n\n\`\`\`sh\n${VERIFY(stem)}\n\`\`\`\n`;
  return "One sentence.\n";
}

/** A guide of `stem` with the H3 lines `phases` under Steps and both includes. */
function guide(stem: string, phases: readonly string[] = SEVEN): Page {
  const steps = phases.map((p) => `### ${p}\n\n${body(stem, p)}`).join("\n");
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
    expect(r.counts).toEqual({
      guides: 2,
      phases: 14,
      providers: 1,
      rows: 2,
      anchors: 2,
      copies: 2,
    });
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

  it("refuses a guide with a phase missing, and a guide with no phase", () => {
    const six = tree([guide("a", SEVEN.slice(0, 6)), guide("better-auth")]);
    expect(checkMigrate(six, ["a"], HTML, REASONS).failures).toEqual([
      "docs/migrate/a.mdx: the H3 lines under Steps are Export, Carry the passwords, Dry run, Move, Verify, Change the calls; the phases are Export, Carry the passwords, Dry run, Move, Verify, Change the calls, Cut over",
    ]);
    const none = tree([guide("a", []), guide("better-auth")]);
    expect(checkMigrate(none, ["a"], HTML, REASONS).failures).toEqual([
      "docs/migrate/a.mdx: the H3 lines under Steps are none; the phases are Export, Carry the passwords, Dry run, Move, Verify, Change the calls, Cut over",
    ]);
  });

  it("reads a heading with up to three spaces before it, as CommonMark does", () => {
    const a = guide("a");
    const indentedMove = { ...a, source: a.source.replace("### Move\n", "   ### Move\n") };
    const codeLine = { ...a, source: a.source.replace("### Move\n", "### Move\n\n    ### Code\n") };
    expect(
      checkMigrate(tree([indentedMove, guide("better-auth")]), ["a"], HTML, REASONS).failures,
    ).toEqual([]);
    expect(
      checkMigrate(tree([codeLine, guide("better-auth")]), ["a"], HTML, REASONS).failures,
    ).toEqual([]);
    const indentedNotes = {
      ...a,
      source: a.source.replace("### Cut over\n", "### Cut over\n\n  ### Notes\n"),
    };
    expect(
      checkMigrate(tree([indentedNotes, guide("better-auth")]), ["a"], HTML, REASONS).failures[0],
    ).toContain("Cut over, Notes;");
    const indentedEnd = {
      ...a,
      source: a.source.replace("## How it behaves", "  ## How it behaves"),
    };
    expect(
      checkMigrate(tree([indentedEnd, guide("better-auth")]), ["a"], HTML, REASONS).failures,
    ).toEqual([]);
  });

  it("refuses a guide with no sample test, its sample twice, or the sample of another guide", () => {
    const a = guide("a");
    const run = (source: string) =>
      checkMigrate(tree([{ ...a, source }, guide("better-auth")]), ["a"], HTML, REASONS).failures;
    const at = (line: string) =>
      a.source.replace("## Before you start", `${line}\n\n## Before you start`);
    expect(run(a.source.replace(/^import test .*$/m, ""))).toEqual([
      "docs/migrate/a.mdx imports samples/migrate/a.test.ts?raw 0 times; it needs one",
    ]);
    expect(run(at('import again from "../../../../../samples/migrate/a.ts?raw";'))).toEqual([
      "docs/migrate/a.mdx imports samples/migrate/a.ts?raw 2 times; it needs one",
    ]);
    expect(
      run(a.source.replace("samples/migrate/a.test.ts?raw", "samples/migrate/b.test.ts?raw")),
    ).toEqual([
      "docs/migrate/a.mdx imports samples/migrate/b.test.ts?raw, which is not a file of the guide a",
      "docs/migrate/a.mdx imports samples/migrate/a.test.ts?raw 0 times; it needs one",
    ]);
    expect(run(at('import other from "../../../../../samples/migrate/b.test.ts?raw";'))).toEqual([
      "docs/migrate/a.mdx imports samples/migrate/b.test.ts?raw, which is not a file of the guide a",
    ]);
    // The parse of check-fences reads an import on two lines too.
    expect(run(at('import other from\n  "../../../../../samples/migrate/b.test.ts?raw";'))).toEqual(
      [
        "docs/migrate/a.mdx imports samples/migrate/b.test.ts?raw, which is not a file of the guide a",
      ],
    );
  });

  it("refuses a real import or a verify on the real database in Move or Verify", () => {
    const a = guide("a");
    const run = (source: string) =>
      checkMigrate(tree([{ ...a, source }, guide("better-auth")]), ["a"], HTML, REASONS).failures;
    const real = (line: string) => line.replace("COPY_URL", "DATABASE_URL");
    expect(run(a.source.replace(MOVE("a"), real(MOVE("a"))))).toEqual([
      `docs/migrate/a.mdx: a command of the phase Move does not write to the copy (--url-env COPY_URL): ${real(MOVE("a"))}`,
    ]);
    expect(run(a.source.replace(VERIFY("a"), real(VERIFY("a"))))).toEqual([
      `docs/migrate/a.mdx: a command of the phase Verify does not write to the copy (--url-env COPY_URL): ${real(VERIFY("a"))}`,
    ]);
    // A flag name that only starts with the right text is no copy.
    expect(run(a.source.replace(MOVE("a"), `${MOVE("a")}_OLD`))).toEqual([
      `docs/migrate/a.mdx: a command of the phase Move does not write to the copy (--url-env COPY_URL): ${MOVE("a")}_OLD`,
    ]);
  });

  it("refuses a Move with no link to One real import, and a phase with no command", () => {
    const a = guide("a");
    const run = (source: string) =>
      checkMigrate(tree([{ ...a, source }, guide("better-auth")]), ["a"], HTML, REASONS).failures;
    expect(run(a.source.replace("#one-real-import", "#steps"))).toEqual([
      "docs/migrate/a.mdx: the phase Move does not link /docs/migrate/cutover/#one-real-import",
    ]);
    expect(run(a.source.replace(VERIFY("a"), "authtempo check https://api.example.com"))).toEqual([
      "docs/migrate/a.mdx: the phase Verify has no command `authtempo import verify a`",
    ]);
    expect(run(a.source.replace(MOVE("a"), "authtempo check https://api.example.com"))).toEqual([
      "docs/migrate/a.mdx: the phase Move has no command `authtempo import a`",
    ]);
    // The command of the Move phase in the Verify phase is no command of Move.
    const moved = a.source
      .replace(`${MOVE("a")}\n`, "")
      .replace(VERIFY("a"), `${VERIFY("a")}\n${MOVE("a")}`);
    expect(run(moved)).toEqual([
      "docs/migrate/a.mdx: the phase Move has no command `authtempo import a`",
    ]);
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

  it("reads the first table of the index only", () => {
    const pages = tree();
    const index = pages.find((p) => p.path === "docs/migrate/index.md");
    const second = "\nA second table.\n\n| Term | Meaning |\n| --- | --- |\n| a | b |\n";
    const withSecond = pages.map((p) => (p === index ? { ...p, source: p.source + second } : p));
    const r = checkMigrate(withSecond, ["a"], HTML, REASONS);
    expect(r.failures).toEqual([]);
    expect(r.counts.rows).toBe(2);
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
