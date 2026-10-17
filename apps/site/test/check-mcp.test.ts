import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkMcp } from "../scripts/check-mcp.ts";
import { type WireLists, wireLists } from "../scripts/lib/mcp-wire.ts";
import { DIST, REPO } from "../scripts/lib/paths.ts";

/** Two tools in the form of a tools/list answer: one on both surfaces, one on the local surface only. */
function wire(): WireLists {
  return {
    tools: [
      {
        name: "docs.search",
        title: "Search the docs",
        description: "Reads no file and writes nothing. Searches the docs.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        properties: {
          query: { type: "string", minLength: 2, maxLength: 200, description: "The words." },
          limit: {
            default: 5,
            description: "The most hits.",
            type: "integer",
            minimum: 1,
            maximum: 10,
          },
        },
        required: ["query"],
        outputKeys: ["results"],
      },
      {
        name: "docs.read",
        title: "Read a page",
        description: "Reads no file and writes nothing. Answers one page.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        properties: {
          path: {
            description: "A page path.",
            type: "string",
            minLength: 1,
            maxLength: 200,
          },
          version: {
            default: "latest",
            description: "The docs version.",
            type: "string",
            minLength: 1,
            maxLength: 40,
          },
        },
        required: [],
        outputKeys: ["path", "markdown"],
      },
      {
        name: "check",
        title: "Check a deployment",
        description: "Fetches the public documents of a deployment.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        properties: {
          base_url: { type: "string", maxLength: 2048, description: "The origin." },
          base_path: {
            default: "/auth",
            description: "The basePath.",
            type: "string",
            minLength: 1,
            maxLength: 200,
            pattern: "^\\/",
          },
          strict: { default: false, description: "true: a skip fails.", type: "boolean" },
          kind: { type: "string", enum: ["a", "b"], description: "The kind." },
          confirm: { type: "boolean", const: true, description: "true: run it." },
          rounds: { type: "integer", minimum: 0, maximum: 1000, description: "The rounds." },
        },
        required: ["base_url", "confirm"],
        outputKeys: ["base", "checks"],
      },
    ],
    prompts: [
      {
        name: "check-deployment",
        title: "Check a deployment",
        arguments: [{ name: "base_url", required: false }],
      },
      { name: "migrate-clerk", title: "Move the users of Clerk", arguments: [] },
    ],
    templates: [
      { name: "docs-page", uriTemplate: "authtempo://docs/{+path}", mimeType: "text/markdown" },
    ],
    remote: {
      tools: ["docs.search", "docs.read"],
      prompts: ["check-deployment", "migrate-clerk"],
      templates: ["authtempo://docs/{+path}"],
    },
    resourcePage: { size: 100, more: true },
    limits: { bodyBytes: 65_536, queryChars: 200, limit: 10, resourcePage: 100 },
    error: null,
  };
}

const DOCS_SEARCH = `<h3 id="tool-docs-search"><code>docs.search</code></h3>

Reads no file and writes nothing. Searches the docs.

| Fact | Value |
| --- | --- |
| Title | Search the docs |
| Surfaces | local, remote |
| \`readOnlyHint\` | \`true\` |
| \`destructiveHint\` | \`false\` |
| \`idempotentHint\` | \`true\` |
| \`openWorldHint\` | \`false\` |
| Output keys | \`results\` |

| Input | Type | Rules | What it is |
| --- | --- | --- | --- |
| \`query\` | string | required; 2 to 200 characters | The words. |
| \`limit\` | integer | default \`5\`; 1 to 10 | The most hits. |
`;

const DOCS_READ = `<h3 id="tool-docs-read"><code>docs.read</code></h3>

Reads no file and writes nothing. Answers one page.

| Fact | Value |
| --- | --- |
| Title | Read a page |
| Surfaces | local, remote |
| \`readOnlyHint\` | \`true\` |
| \`destructiveHint\` | \`false\` |
| \`idempotentHint\` | \`true\` |
| \`openWorldHint\` | \`false\` |
| Output keys | \`path\`, \`markdown\` |

| Input | Type | Rules | What it is |
| --- | --- | --- | --- |
| \`path\` | string | optional; 1 to 200 characters | A page path. |
| \`version\` | string | default \`"latest"\`; 1 to 40 characters | The docs version. |
`;

const CHECK = `<h3 id="tool-check"><code>check</code></h3>

Fetches the public documents of a deployment.

| Fact | Value |
| --- | --- |
| Title | Check a deployment |
| Surfaces | local |
| \`readOnlyHint\` | \`true\` |
| \`destructiveHint\` | \`false\` |
| \`idempotentHint\` | \`true\` |
| \`openWorldHint\` | \`true\` |
| Output keys | \`base\`, \`checks\` |

| Input | Type | Rules | What it is |
| --- | --- | --- | --- |
| \`base_url\` | string | required; at most 2048 characters | The origin. |
| \`base_path\` | string | default \`"/auth"\`; 1 to 200 characters; matches \`^\\/\` | The basePath. |
| \`strict\` | boolean | default \`false\` | true: a skip fails. |
| \`kind\` | string | optional; one of \`a\`, \`b\` | The kind. |
| \`confirm\` | boolean | required; only \`true\` | true: run it. |
| \`rounds\` | integer | optional; 0 to 1000 | The rounds. |
`;

const REST = `## Resources

| Template | Name | MIME type |
| --- | --- | --- |
| \`authtempo://docs/{+path}\` | \`docs-page\` | \`text/markdown\` |

## Prompts

| Prompt | Title | Arguments |
| --- | --- | --- |
| \`check-deployment\` | Check a deployment | \`base_url\` (optional) |
| \`migrate-clerk\` | Move the users of Clerk | none |

## Limits

| Limit | Value | Why |
| --- | --- | --- |
| \`bodyBytes\` | \`65536\` | A docs call is small. |
| \`queryChars\` | \`200\` | The longest query. |
| \`resourcePage\` | \`100\` | One resources page. |
| \`limit\` | \`10\` | The most hits. |

## Next
`;

const PAGE = `## Tools\n\n${DOCS_SEARCH}\n${DOCS_READ}\n${CHECK}\n${REST}`;

describe("checkMcp", () => {
  it("passes when the page and the wire agree", () => {
    const r = checkMcp(PAGE, wire());
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ tools: 3, inputs: 10, prompts: 2, templates: 1, limits: 4 });
  });

  it("fails on a tool that the page lacks", () => {
    const r = checkMcp(`## Tools\n\n${DOCS_SEARCH}\n${DOCS_READ}\n${REST}`, wire());
    expect(r.failures).toEqual(["the page lacks the tool check"]);
  });

  it("fails on a page anchor of no tool", () => {
    const extra = DOCS_READ.replaceAll("docs-read", "docs-get").replaceAll("docs.read", "docs.get");
    const r = checkMcp(
      `## Tools\n\n${DOCS_SEARCH}\n${DOCS_READ}\n${extra}\n${CHECK}\n${REST}`,
      wire(),
    );
    expect(r.failures).toEqual(["the page anchor tool-docs-get names no tool of the wire"]);
  });

  it("fails on an anchor that is not the form of its tool name", () => {
    const page = PAGE.replace('id="tool-docs-read"', 'id="tool-docs.read"');
    expect(checkMcp(page, wire()).failures).toEqual([
      "docs.read: the anchor is tool-docs.read; the name gives tool-docs-read",
    ]);
  });

  it("fails on an input row that the schema lacks", () => {
    const page = PAGE.replace(
      "| `strict` |",
      "| `force` | boolean | optional | Force it. |\n| `strict` |",
    );
    expect(checkMcp(page, wire()).failures).toEqual([
      "check: the input row force is not in the schema",
    ]);
  });

  it("fails on a schema property that the page lacks", () => {
    const page = PAGE.replace("| `rounds` | integer | optional; 0 to 1000 | The rounds. |\n", "");
    expect(checkMcp(page, wire()).failures).toEqual(["check: the page lacks the input rounds"]);
  });

  it("fails on another type, rule, or text of an input", () => {
    const page = PAGE.replace("| `rounds` | integer |", "| `rounds` | number |")
      .replace("optional; 1 to 200 characters", "optional; 1 to 100 characters")
      .replace("| The kind. |", "| The sort. |");
    expect(checkMcp(page, wire()).failures).toEqual([
      "docs.read.path: the rules are optional; 1 to 100 characters on the page and optional; 1 to 200 characters on the wire",
      "check.kind: the text is The sort. on the page and The kind. on the wire",
      "check.rounds: the type is number on the page and integer on the wire",
    ]);
  });

  it("fails on another annotation", () => {
    const page = PAGE.replace("| `openWorldHint` | `true` |", "| `openWorldHint` | `false` |");
    expect(checkMcp(page, wire()).failures).toEqual([
      "check: openWorldHint is false on the page and true on the wire",
    ]);
  });

  it("fails on a missing annotation row", () => {
    const page = CHECK.replace("| `destructiveHint` | `false` |\n", "");
    expect(
      checkMcp(`## Tools\n\n${DOCS_SEARCH}\n${DOCS_READ}\n${page}\n${REST}`, wire()).failures,
    ).toEqual(["check: the page lacks the annotation destructiveHint"]);
  });

  it("fails on another title, description, surface list, or output key list", () => {
    const page = PAGE.replace("| Title | Check a deployment |", "| Title | Check it |")
      .replace("Fetches the public documents of a deployment.", "Fetches a deployment.")
      .replace("| Surfaces | local |", "| Surfaces | local, remote |")
      .replace("`base`, `checks`", "`base`");
    expect(checkMcp(page, wire()).failures).toEqual([
      "check: the description on the page differs from the wire",
      "check: the title is Check it on the page and Check a deployment on the wire",
      "check: the surfaces are local, remote on the page and local on the wire",
      "check: the output keys are base on the page and base, checks on the wire",
    ]);
  });

  it("fails on a schema key that the check cannot read, and never skips it", () => {
    const w = wire();
    const check = w.tools.find((t) => t.name === "check");
    if (check === undefined) throw new Error("the fixture has the tool check");
    check.properties.rounds = { ...check.properties.rounds, multipleOf: 2 };
    expect(checkMcp(PAGE, w).failures).toEqual([
      "check.rounds: the check cannot read the schema key multipleOf",
    ]);
  });

  it("fails on a missing prompt", () => {
    const page = PAGE.replace("| `migrate-clerk` | Move the users of Clerk | none |\n", "");
    expect(checkMcp(page, wire()).failures).toEqual(["the page lacks the prompt migrate-clerk"]);
  });

  it("fails on a prompt row of no prompt, and on another title or argument", () => {
    const page = PAGE.replace(
      "| `migrate-clerk` | Move the users of Clerk | none |",
      "| `migrate-clerk` | Move Clerk | `dir` (optional) |\n| `migrate-okta` | Move Okta | none |",
    );
    expect(checkMcp(page, wire()).failures).toEqual([
      "migrate-clerk: the prompt title is Move Clerk on the page and Move the users of Clerk on the wire",
      "migrate-clerk: the arguments are `dir` (optional) on the page and none on the wire",
      "the prompt row migrate-okta is not on the wire",
    ]);
  });

  it("fails on a template that differs, both ways", () => {
    const page = PAGE.replace("`authtempo://docs/{+path}`", "`authtempo://docs/{path}`");
    expect(checkMcp(page, wire()).failures).toEqual([
      "the page lacks the template authtempo://docs/{+path}",
      "the template row authtempo://docs/{path} is not on the wire",
    ]);
  });

  it("fails on a limit that differs, both ways", () => {
    const page = PAGE.replace("| `limit` | `10` |", "| `limits` | `10` |").replace(
      "`65536`",
      "`65535`",
    );
    expect(checkMcp(page, wire()).failures).toEqual([
      "bodyBytes: the limit is 65535 on the page and 65536 in LIMITS",
      "the page lacks the limit limit",
      "the limit row limits is not in LIMITS",
    ]);
  });

  it("fails on a limit that the server does not apply, also when the page agrees", () => {
    const w = wire();
    w.limits = { ...w.limits, queryChars: 300, limit: 20, resourcePage: 50 };
    const page = PAGE.replace("| `queryChars` | `200` |", "| `queryChars` | `300` |")
      .replace("| `limit` | `10` |", "| `limit` | `20` |")
      .replace("| `resourcePage` | `100` |", "| `resourcePage` | `50` |");
    expect(checkMcp(page, w).failures).toEqual([
      "queryChars: LIMITS holds 300; the docs.search query takes at most 200 on the wire",
      "limit: LIMITS holds 20; the docs.search limit is at most 10 on the wire",
      "resourcePage: LIMITS holds 50; the first resources/list page on the wire holds 100",
    ]);
  });

  it("accepts a short last resources page, and refuses a page longer than the limit", () => {
    const short = { ...wire(), resourcePage: { size: 7, more: false } };
    expect(checkMcp(PAGE, short).failures).toEqual([]);
    const long = { ...wire(), resourcePage: { size: 101, more: false } };
    expect(checkMcp(PAGE, long).failures).toEqual([
      "resourcePage: LIMITS holds 100; the first resources/list page on the wire holds 101",
    ]);
    const none = { ...wire(), resourcePage: null };
    expect(checkMcp(PAGE, none).failures).toEqual([
      "resourcePage: the wire has no value that applies it",
    ]);
  });

  it("fails on two sections for one tool", () => {
    const second = DOCS_READ.replace(
      "Reads no file and writes nothing. Answers one page.",
      "Writes the page.",
    );
    const page = `## Tools\n\n${DOCS_SEARCH}\n${DOCS_READ}\n${second}\n${CHECK}\n${REST}`;
    expect(checkMcp(page, wire()).failures).toEqual([
      "the page has 2 sections for the tool docs.read",
    ]);
  });

  it("ends the last tool section at the next h2, so a later table is not the tool's", () => {
    const facts = CHECK.slice(CHECK.indexOf("| Fact |"), CHECK.indexOf("| Input |"));
    const bare = CHECK.replace(facts, "");
    const page = `## Tools\n\n${DOCS_SEARCH}\n${DOCS_READ}\n${bare}\n${REST}\n## Notes\n\n${facts}`;
    expect(checkMcp(page, wire()).failures).toEqual([
      "check: the title is missing on the page and Check a deployment on the wire",
      "check: the surfaces are missing on the page and local on the wire",
      "check: the page lacks the annotation readOnlyHint",
      "check: the page lacks the annotation destructiveHint",
      "check: the page lacks the annotation idempotentHint",
      "check: the page lacks the annotation openWorldHint",
      "check: the output keys are none on the page and base, checks on the wire",
    ]);
  });

  it("fails when the remote surface serves other prompts or templates", () => {
    const w = wire();
    w.remote.prompts = ["check-deployment"];
    w.remote.templates = [];
    expect(checkMcp(PAGE, w).failures).toEqual([
      "the remote prompts are check-deployment; the local prompts are check-deployment, migrate-clerk",
      "the remote templates are none; the local templates are authtempo://docs/{+path}",
    ]);
  });

  it("fails when the server does not start, and names the error", () => {
    const w: WireLists = {
      ...wire(),
      tools: [],
      prompts: [],
      templates: [],
      error: "exit 2: authtempo-mcp: the docs index is missing",
    };
    const r = checkMcp(PAGE, w);
    expect(r.failures[0]).toBe(
      "the server did not answer: exit 2: authtempo-mcp: the docs index is missing",
    );
    expect(r.failures).toContain("read 0 tools");
  });

  it("fails at zero tools", () => {
    const r = checkMcp("## Tools\n", {
      tools: [],
      prompts: [],
      templates: [],
      remote: { tools: [], prompts: [], templates: [] },
      resourcePage: null,
      limits: {},
      error: null,
    });
    expect(r.failures).toEqual([
      "read 0 tools",
      "read 0 inputs",
      "read 0 prompts",
      "read 0 templates",
      "read 0 limits",
    ]);
  });
});

describe("wireLists", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("names the error of a server that exits before it answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "check-mcp-"));
    dirs.push(dir);
    const bin = join(dir, "bin.js");
    writeFileSync(bin, 'process.stderr.write("authtempo-mcp: boom\\n"); process.exit(2);\n');
    chmodSync(bin, 0o755);
    const w = await wireLists(bin, join(dir, "index.json"));
    expect(w.tools).toEqual([]);
    expect(w.error).toBe("exit 2: authtempo-mcp: boom");
  });

  it("names a server file that does not exist", async () => {
    const w = await wireLists("/nowhere/authtempo-mcp.js", "/nowhere/index.json");
    expect(w.error).toMatch(/^exit 1: /);
  });

  // The site's Turbo test builds @authtempo/mcp first (a dev dependency), and
  // the site build writes the index. This test reads both, as the check does.
  it("reads the lists of the built server on both surfaces", async () => {
    const bin = `${REPO}packages/mcp/dist/bin/authtempo-mcp.js`;
    const index = `${DIST}agent/index.json`;
    expect(existsSync(bin) && existsSync(index)).toBe(true);
    const w = await wireLists(bin, index);
    expect(w.error).toBeNull();
    expect(w.tools.map((t) => t.name)).toEqual([
      "docs.search",
      "docs.read",
      "version",
      "scaffold",
      "migrate.plan",
      "migrate.run",
      "schema.migrate",
      "check",
    ]);
    expect(w.remote.tools).toEqual(["docs.search", "docs.read", "version"]);
    expect(w.tools.find((t) => t.name === "check")?.annotations.openWorldHint).toBe(true);
    expect(w.tools.find((t) => t.name === "scaffold")?.required).toEqual(["dir", "stack"]);
    expect(w.templates).toEqual([
      { name: "docs-page", uriTemplate: "authtempo://docs/{+path}", mimeType: "text/markdown" },
    ]);
    expect(w.prompts.map((p) => p.name)).toContain("check-deployment");
    expect(w.remote.prompts).toEqual(w.prompts.map((p) => p.name));
    expect(w.limits.bodyBytes).toBe(65_536);
    expect(w.resourcePage).toEqual({ size: 100, more: true });
  });
});
