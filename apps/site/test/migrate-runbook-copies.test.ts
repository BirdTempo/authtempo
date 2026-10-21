import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The final review of plan 12k: the key cutover runbook has two copies, the
// compat README and the site's Better Auth guide. This test holds them equal.

/** The numbered steps of the part of `text` from the line `from` to the next line that starts `until`. */
function stepsOf(text: string, from: string, until: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(from);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith(until));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => /^\d+\. /.test(l));
}

describe("the two copies of the key cutover runbook", () => {
  it("hold the same eight steps", () => {
    const site = stepsOf(
      readFileSync(`${DOCS}docs/migrate/better-auth.mdx`, "utf8"),
      "## Cutover of API tokens",
      "## ",
    );
    const readme = stepsOf(
      readFileSync(`${REPO}packages/compat-better-auth/README.md`, "utf8"),
      "### Cutover of API keys",
      "#",
    );
    expect(site).toHaveLength(8);
    expect(readme).toEqual(site);
  });
});
