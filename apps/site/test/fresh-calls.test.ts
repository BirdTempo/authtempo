import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

/** The code spans of a client call, such as `user.delete`, in some lines. */
function calls(lines: readonly string[]): string[] {
  const spans = lines.flatMap((l) => [...l.matchAll(/`([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)`/g)]);
  return spans.map((m) => m[1] ?? "").sort();
}

/** The lines after the line that starts with `from`, up to the line that starts with `to`. */
function between(text: string, from: string, to: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(from));
  const end = lines.findIndex((l, i) => i > at && l.startsWith(to));
  if (at < 0 || end < 0) throw new Error(`no part from "${from}" to "${to}"`);
  return lines.slice(at + 1, end);
}

describe("the calls that can answer session_not_fresh", () => {
  it("are the same on the account settings guide and in the client README", () => {
    const readme = readFileSync(`${REPO}packages/client/README.md`, "utf8");
    const guide = readFileSync(`${DOCS}docs/guides/account-settings.mdx`, "utf8");
    // The README list: its bullets under "A fresh session.", before the withFresh paragraph.
    const listed = calls(
      between(readme, "**A fresh session.**", "`withFresh` gives").filter((l) =>
        /^(- | {2}`)/.test(l),
      ),
    );
    // The guide: the bullets of "The fresh rule" that say "can answer".
    const named = calls(
      between(guide, "## The fresh rule", "## ").filter((l) => l.includes("can answer")),
    );
    // Plan 12k Task 7 adds tokens.update; Task 8 adds the two organization token
    // calls and organizations.members.remove. Plan 12d Task 13 adds sso.domains,
    // sso.connections, and scim.tokens: each of their calls needs a fresh session.
    // Plan 12i Task 2 adds username.set.
    expect(listed).toHaveLength(27);
    expect(named).toEqual(listed);
  });
});
