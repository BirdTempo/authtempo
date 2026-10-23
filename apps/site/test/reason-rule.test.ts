import { readFileSync } from "node:fs";
import { HELP, REASON_RULE, reasonProblem } from "@authtempo/cli";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The reason rule of an operator act in each copy (ruling 65 of plan 12f).
// The rule is the class of `hasRefusedChar`, and the CLI error says it in
// words. Each copy holds the same words, so a change on one side fails here.
// The words state the class exactly (ruling 66): a space and U+00A0 pass,
// the two joiners pass, and the length counts UTF-16 code units.

/** The words of the rule, typed here: the CLI error and each copy must hold them. */
const RULE =
  "1 to 500 UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D";

/** A file with its line breaks and runs of spaces as one space. */
const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

/** The count of `RULE` in `text`. */
const count = (text: string) => text.split(RULE).length - 1;

/** Each copy of the rule and its count: the docs pages and the CLI README. */
const COPIES: [string, number][] = [
  [`${DOCS}docs/reference/api.md`, 2],
  // Plan 12d Task 2b adds the override of enforce: 9 became 10.
  // Plan 12f2 Task 5 adds the rows of the operator update and delete: 10 became 12.
  [`${DOCS}docs/reference/routes.md`, 12],
  [`${DOCS}docs/guides/operator-tools.mdx`, 1],
  [`${DOCS}docs/concepts/threat-model.md`, 1],
  ...[
    "users-ban",
    "users-unban",
    "users-platform-role",
    "users-second-factor-off",
    "users-update",
    "users-delete",
    "sessions-end",
    "sessions-end-all",
    "create-admin",
  ].map((p): [string, number] => [`${DOCS}docs/reference/cli/${p}.md`, 1]),
  [`${REPO}packages/cli/README.md`, 1],
];

describe("the reason rule in each copy (ruling 65 of plan 12f)", () => {
  it("is the rule that the CLI error says", () => {
    expect(REASON_RULE).toBe(RULE);
    expect(reasonProblem("Ticket ‮ 42")).toBe(`--reason is ${RULE}`);
    expect(reasonProblem("Ticket 42")).toBeNull();
    // Each character that the words let pass, and each that they refuse.
    for (const ok of ["Ticket\u00a042", "a\u200cb", "a\u200db", "\u{1f600}".repeat(250)])
      expect(reasonProblem(ok), JSON.stringify(ok)).toBeNull();
    for (const bad of ["a\u0085b", "a\u2028b", "a\u2029b", "a\ud800b", "a\u200bb", "x".repeat(501)])
      expect(reasonProblem(bad), JSON.stringify(bad)).toBe(`--reason is ${RULE}`);
  });

  it("is in the --reason flag of each CLI help", () => {
    const says = HELP.flatMap((h) => h.flags.filter((f) => f.flag === "--reason <text>"));
    // Plan 12f2 Task 6 adds users update and users delete: 7 became 9.
    expect(says.length).toBe(9);
    for (const f of says) expect(count(f.says), f.says).toBe(1);
  });

  it("is in each docs copy and the CLI README, with no old copy left", () => {
    for (const [path, n] of COPIES) {
      const text = flat(path);
      expect({ path, n: count(text) }).toEqual({ path, n });
      // Each old rule counted characters, not UTF-16 code units.
      expect({ path, old: /\b500 characters with no control/i.test(text) }).toEqual({
        path,
        old: false,
      });
    }
  });
});
