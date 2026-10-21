import { readFileSync } from "node:fs";
import { HELP, REASON_RULE, reasonProblem } from "@authtempo/cli";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The reason rule of an operator act in each copy (ruling 65 of plan 12f).
// The rule is the class of `hasRefusedChar`, and the CLI error says it in
// words. Each copy holds the same words, so a change on one side fails here.

/** The words of the rule, typed here: the CLI error and each copy must hold them. */
const RULE =
  "1 to 500 characters with no control, format, or separator character and no lone surrogate";

/** A file with its line breaks and runs of spaces as one space. */
const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

/** The count of `RULE` in `text`. */
const count = (text: string) => text.split(RULE).length - 1;

/** Each copy of the rule and its count: the docs pages and the CLI README. */
const COPIES: [string, number][] = [
  [`${DOCS}docs/reference/api.md`, 2],
  [`${DOCS}docs/reference/routes.md`, 9],
  [`${DOCS}docs/guides/operator-tools.mdx`, 1],
  [`${DOCS}docs/concepts/threat-model.md`, 1],
  ...[
    "users-ban",
    "users-unban",
    "users-platform-role",
    "users-second-factor-off",
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
  });

  it("is in the --reason flag of each CLI help", () => {
    const says = HELP.flatMap((h) => h.flags.filter((f) => f.flag === "--reason <text>"));
    expect(says.length).toBe(7);
    for (const f of says) expect(count(f.says), f.says).toBe(1);
  });

  it("is in each docs copy and the CLI README, with no old copy left", () => {
    for (const [path, n] of COPIES) {
      const text = flat(path);
      expect({ path, n: count(text) }).toEqual({ path, n });
      // The old rule named control characters only.
      expect({ path, old: /reason[^|]{0,60}with no control character/i.test(text) }).toEqual({
        path,
        old: false,
      });
    }
  });
});
