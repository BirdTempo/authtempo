import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// Ruling 46 of plan 12k: the core README "Hooks" and the hooks guide hold one
// table of the flows that lock a row before a before hook. The two copies
// must match, and a lock that the engine adds before a before hook must
// have its hook in the table. A before hook that awaits a core write of a
// locked row hangs on Postgres, so a missing row hides that hang.

const HEADER = "| Flow | Before hooks | Rows locked before the hook |";
const LOCKS = /\b(?:holdUser|lockOrganization|lockTeam)\(/;
const ENGINE = `${REPO}packages/core/src/engine/`;

/** The body rows of the table under HEADER, as lines. */
function table(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.indexOf(HEADER);
  if (at < 0) throw new Error("no lock table");
  const end = lines.findIndex((l, i) => i > at + 1 && !l.startsWith("|"));
  return lines.slice(at + 2, end < 0 ? undefined : end);
}

/** The hook names of the "Before hooks" cells. */
function hooksOf(rows: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows)
    for (const m of (row.split("|")[2] ?? "").matchAll(/`([a-z]+\.before[A-Za-z]+)`/g))
      out.add(m[1] ?? "");
  return out;
}

/**
 * The before hooks that an engine function runs after a lock call in the
 * same function. A function starts at a line that opens a top-level
 * `function` or `async function`.
 */
function lockedHooks(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(ENGINE).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(`${ENGINE}${f}`, "utf8");
    for (const fn of src.split(/\n(?=(?:export )?(?:async )?function )/)) {
      for (const m of fn.matchAll(/runBefore\(\s*"([a-z]+\.before[A-Za-z]+)"/g)) {
        if (LOCKS.test(fn.slice(0, m.index))) out.add(m[1] ?? "");
      }
    }
  }
  return out;
}

describe("the table of locks over a before hook", () => {
  const readme = table(readFileSync(`${REPO}packages/core/README.md`, "utf8"));
  const page = table(readFileSync(`${DOCS}docs/guides/hooks.mdx`, "utf8"));

  it("is the same in the core README and the hooks guide", () => {
    expect(page).toEqual(readme);
  });

  it("names the twelve flows", () => {
    expect(readme.map((r) => r.split("|")[1]?.trim())).toEqual([
      "Organization create",
      "Member add",
      "Invitation accept",
      "Invite",
      "Member removal or leave",
      "Owner demotion",
      "Team create",
      "Team delete",
      "Team member add",
      "Team member removal",
      "Identity unlink",
      "Account delete",
    ]);
  });

  it("holds each before hook that the engine runs after a lock call", () => {
    const found = lockedHooks();
    // The scan must find the hooks of the lock calls; an empty scan proves nothing.
    expect([...found].sort()).toEqual([
      "organization.beforeAddMember",
      "organization.beforeAddTeamMember",
      "organization.beforeCreate",
      "organization.beforeCreateTeam",
      "organization.beforeDeleteTeam",
      "organization.beforeInvite",
      "organization.beforeRemoveMember",
      "organization.beforeRemoveTeamMember",
      "organization.beforeUpdateMemberRole",
    ]);
    const listed = hooksOf(readme);
    expect([...found].filter((h) => !listed.has(h))).toEqual([]);
  });
});
