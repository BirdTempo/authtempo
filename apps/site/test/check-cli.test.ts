import { describe, expect, it } from "vitest";
import { checkCli } from "../scripts/check-cli.ts";
import type { HelpRun } from "../scripts/lib/cli-help.ts";

const FILES = new Set(["docs/reference/cli/index.html", "docs/reference/cli/check/index.html"]);
const PAGE =
  '<h3 id="base_not_https"><code>base_not_https</code></h3><h3 id="no_mount"><code>no_mount</code></h3>';

/** A help text in the layout of the binary's renderHelp. */
function helpText(docs: string, flags: string[], exits: string[]): string {
  return [
    "Do a thing.",
    "",
    "Usage:",
    "  authtempo thing",
    "",
    "Flags:",
    ...flags.map((f) => `  ${f}`),
    "",
    "Exit codes:",
    ...exits.map((x) => `  ${x}`),
    "",
    `Docs: ${docs}`,
    "",
  ].join("\n");
}

const ROOT_EXITS = ["0  Done.", "2  A usage error."];
const ROOT_FLAGS = ["--json      Print JSON.", "-h, --help  Print this help."];
const CHECK_FLAGS = [
  "--target <d1|postgres>  The kind of database.",
  "--url-env <NAME>        The variable.",
  "-n, --dry-run           Apply nothing.",
  "-h, --help              Print this help.",
];
const CHECK_EXITS = ["0  No check failed.", "1  A check failed.", "2  A usage error."];

const ROOT_PAGE = `## The flags

| Flag | What it does |
| --- | --- |
| \`--json\` | Prints JSON. |
| \`-h\`, \`--help\` | Prints the help. |

## The exit codes

| Exit code | What it means |
| --- | --- |
| 0 | Done. |
| 2 | A usage error. |
`;

const CHECK_SOURCE = `## The command

| Flag | What it does |
| --- | --- |
| \`<base url>\` | The origin. |
| \`--target d1\`, \`--target postgres\` | The database. |
| \`--url-env <NAME>\` | The variable. |
| \`-n\`, \`--dry-run\` | Applies nothing. |
| \`-h\`, \`--help\` | Prints the help. |

| Exit code | What it means |
| --- | --- |
| 0 | No check failed. |
| 1 | A check failed. |
| 2 | A usage error. |
`;

const run = (command: string, output: string): HelpRun => ({ command, output, error: null });
const ROOT = run("", helpText("https://authtempo.com/docs/reference/cli/", ROOT_FLAGS, ROOT_EXITS));
const CHECK = run(
  "check",
  helpText("https://authtempo.com/docs/reference/cli/check/", CHECK_FLAGS, CHECK_EXITS),
);
const SOURCES: Record<string, string> = {
  "/docs/reference/cli/": ROOT_PAGE,
  "/docs/reference/cli/check/": CHECK_SOURCE,
};
const source = (url: string) => SOURCES[url] ?? null;

describe("checkCli (plan 11c)", () => {
  it("passes when each help names a built page with its flags and exit codes, and each code has its anchor", () => {
    const r = checkCli(FILES, PAGE, [ROOT, CHECK], ["base_not_https", "no_mount"], source);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ helps: 2, codes: 2, anchors: 2, flags: 6, exits: 5 });
  });

  it("refuses a help link with no page, a link off the CLI pages, and a code with no anchor", () => {
    const r = checkCli(
      FILES,
      PAGE,
      [
        ROOT,
        run(
          "init",
          helpText("https://authtempo.com/docs/reference/cli/init/", ROOT_FLAGS, ROOT_EXITS),
        ),
        run("x", helpText("https://example.com/x/", ROOT_FLAGS, ROOT_EXITS)),
      ],
      ["base_not_https", "jwks_empty"],
      (url) => (url === "/docs/reference/cli/init/" ? ROOT_PAGE : source(url)),
    );
    expect(r.failures).toEqual([
      "help link https://authtempo.com/docs/reference/cli/init/ names no page of the build (docs/reference/cli/init/index.html)",
      "help link https://example.com/x/ is not a page under https://authtempo.com/docs/reference/cli/",
      "check code jwks_empty has no anchor on /docs/reference/cli/check/",
    ]);
  });

  it("refuses a renamed flag, a lost short form, a changed placeholder, and a missing value of a closed set", () => {
    const page = CHECK_SOURCE.replace("`--url-env <NAME>`", "`--url-env <VAR>`")
      .replace("`-n`, `--dry-run`", "`--dry-run`")
      .replace("`--target d1`, ", "")
      .replace("`-h`, `--help`", "`-h`, `--helps`");
    const r = checkCli(FILES, PAGE, [CHECK], ["no_mount"], () => page);
    expect(r.failures).toEqual([
      "/docs/reference/cli/check/: --target lists the values postgres; the help has d1, postgres",
      "/docs/reference/cli/check/: --url-env shows <VAR>; the help shows <NAME>",
      "/docs/reference/cli/check/: --dry-run has the short form none on the page and -n in the help",
      "/docs/reference/cli/check/: the flag table lacks --help",
      "/docs/reference/cli/check/: the flag table lists --helps, which the help lacks",
    ]);
  });

  it("refuses a changed exit line, a missing exit code, and an extra one", () => {
    const changed = run(
      "check",
      helpText("https://authtempo.com/docs/reference/cli/check/", CHECK_FLAGS, [
        "0  No check failed.",
        "1  A check failed. A person must look.",
        "3  A new code.",
      ]),
    );
    const r = checkCli(FILES, PAGE, [changed], ["no_mount"], source);
    expect(r.failures).toEqual([
      '/docs/reference/cli/check/: exit 1 says "A check failed."; the help says "A check failed. A person must look."',
      "/docs/reference/cli/check/: the exit table lacks exit 3",
      "/docs/reference/cli/check/: the exit table lists exit 2, which the help lacks",
    ]);
  });

  it("refuses an exit table with the help's codes in another order", () => {
    const page = CHECK_SOURCE.replace(
      "| 0 | No check failed. |\n| 1 | A check failed. |",
      "| 1 | A check failed. |\n| 0 | No check failed. |",
    );
    const r = checkCli(FILES, PAGE, [CHECK], ["no_mount"], () => page);
    expect(r.failures).toEqual([
      "/docs/reference/cli/check/: the exit table lists the codes 1, 0, 2; the help lists 0, 1, 2",
    ]);
  });

  it("refuses a page with no flag table or no exit table, and a help run that failed", () => {
    const r = checkCli(
      FILES,
      PAGE,
      [{ command: "keys rotate", output: "", error: "exit 1: boom" }, CHECK],
      ["no_mount"],
      () => "## The command\n\nNo table.\n",
    );
    expect(r.failures).toEqual([
      "authtempo keys rotate --help failed: exit 1: boom",
      "/docs/reference/cli/check/: has no flag table (a table whose first header is Flag)",
      "/docs/reference/cli/check/: has no exit table (a table whose first header is Exit code)",
    ]);
  });

  it("fails when it reads no help and no code", () => {
    expect(checkCli(FILES, PAGE, [], [], source).failures).toEqual([
      "read 0 helps",
      "read 0 codes",
      "read 0 flags",
      "read 0 exits",
    ]);
  });
});
