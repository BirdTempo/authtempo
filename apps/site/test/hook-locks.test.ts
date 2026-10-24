import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// Ruling 46 of plan 12k. The core README "Hooks" and the hooks guide hold
// one table. It lists the flows that lock a row before a before hook. The
// two copies must match, and a lock that the engine adds before a before
// hook must have its hook in the table. A before hook that awaits a core write of a
// locked row hangs on Postgres, so a missing row hides that hang.

const HEADER = "| Flow | Before hooks | Rows locked before the hook |";
const ENGINE = `${REPO}packages/core/src/engine/`;

/** The body rows of the table under HEADER, as lines. */
function table(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.indexOf(HEADER);
  if (at < 0) throw new Error("no lock table");
  const end = lines.findIndex((l, i) => i > at + 1 && !l.startsWith("|"));
  return lines.slice(at + 2, end < 0 ? undefined : end);
}

/** The hook names of the "Before hooks" cell of each row, by its flow. */
function hooksByFlow(rows: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const cells = row.split("|");
    const hooks = new Set<string>();
    for (const m of (cells[2] ?? "").matchAll(/`([a-z]+\.before[A-Za-z]+)`/g))
      hooks.add(m[1] ?? "");
    out.set(cells[1]?.trim() ?? "", hooks);
  }
  return out;
}

interface Fn {
  name: string;
  text: string;
}

/**
 * The folders of the engine that hold flows: the operator folder of plan
 * 12f, and the SSO and SCIM folders of plan 12d.
 */
const SUBFOLDERS = ["operator", "sso", "scim"] as const;

/**
 * The top-level functions of the engine folder of core and of its
 * SUBFOLDERS. A function starts at a line that opens `function` or
 * `async function`, with or without `export`.
 */
function functions(): Fn[] {
  const out: Fn[] = [];
  const files = [
    ...readdirSync(ENGINE).filter((n) => n.endsWith(".ts")),
    ...SUBFOLDERS.flatMap((d) =>
      readdirSync(`${ENGINE}${d}/`)
        .filter((n) => n.endsWith(".ts"))
        .map((n) => `${d}/${n}`),
    ),
  ];
  for (const f of files) {
    const src = readFileSync(`${ENGINE}${f}`, "utf8");
    for (const text of src.split(/\n(?=(?:export )?(?:async )?function )/)) {
      const m = /^(?:export )?(?:async )?function (\w+)/.exec(text);
      if (m?.[1]) out.push({ name: m[1], text });
    }
  }
  return out;
}

// holdUsers is the batch hold of ruling 25 N3 of plan 12d: lockInOrder of the user rows.
const DIRECT_NAMES = new Set(["holdUser", "holdUsers", "lockOrganization", "lockTeam"]);
/** A direct call of a lock function. */
const DIRECT = /(?<!function )\b(holdUser|holdUsers|lockOrganization|lockTeam)\(/g;
/**
 * A compare-and-set write: an update whose where holds `updatedAt` with
 * `eq`, or the `unchanged(...)` where of profile.ts. The write fails when
 * another request moved the row, so on Postgres it locks the row.
 */
const CAS =
  /\.update\(\s*"(\w+)",\s*(?:unchanged\(|\[[^\]]*?field: "updatedAt"(?: as const)?,\s*op: "eq")/g;
/** A plain call, not a method call and not a definition. */
const CALL = /(?<![\w.])(?<!function )(\w+)\(/g;

/**
 * The lock scan. It finds a lock before a before hook in three forms:
 *
 * 1. A direct call of `holdUser`, `holdUsers`, `lockOrganization`, or `lockTeam`, or a
 *    compare-and-set write (CAS above), earlier in the same function text.
 * 2. A call of a lock helper earlier in the same function text. A lock
 *    helper is a function that holds form 1 or calls another lock helper.
 * 3. A lock in an earlier function of the same flow. The hook can run in a
 *    named closure (`const x = async (...) => {`). Then a form 1 or form 2
 *    lock after the closure and before its last use counts, such as
 *    `ownerWrite(..., x)`. An engine function can call the hook's function
 *    after a form 1 lock. Then that lock counts, and so do the form 1 locks
 *    of its callers.
 *
 * The scan reads text, not the control flow. A lock on another branch
 * before the hook counts, so a listed lock can miss some paths. The scan
 * misses these locks:
 * - a lock outside the engine folder and its SUBFOLDERS;
 * - a lock in an arrow function bound to a top-level `const`, or in a class
 *   method;
 * - a call through a variable or an object field;
 * - a form 2 helper call in a caller of the hook's function;
 * - a closure of another shape;
 * - a lock write with no `updatedAt` compare, other than the three lock
 *   calls.
 */
function lockScan(): string[] {
  const fns = functions();
  const helpers = new Set<string>();
  for (const f of fns)
    if (f.text.search(DIRECT) >= 0 || f.text.search(CAS) >= 0) helpers.add(f.name);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of fns) {
      if (helpers.has(f.name)) continue;
      for (const m of f.text.matchAll(CALL))
        if (m[1] !== f.name && helpers.has(m[1] ?? "")) {
          helpers.add(f.name);
          grew = true;
          break;
        }
    }
  }
  /** The locks of `f` with an index in [from, to), in text order. */
  const locks = (f: Fn, from: number, to: number, viaHelpers = true): string[] => {
    const found: [number, string][] = [];
    for (const m of f.text.matchAll(DIRECT)) found.push([m.index, m[1] ?? ""]);
    for (const m of f.text.matchAll(CAS)) found.push([m.index, `${m[1]} compare-and-set`]);
    if (viaHelpers)
      for (const m of f.text.matchAll(CALL))
        if (m[1] !== f.name && helpers.has(m[1] ?? "") && !DIRECT_NAMES.has(m[1] ?? ""))
          found.push([m.index, m[1] ?? ""]);
    return found
      .filter(([i]) => i >= from && i < to)
      .sort((a, b) => a[0] - b[0])
      .map(([, l]) => l);
  };
  /** The locks that a caller of `f` takes before its call, form 3. */
  const entry = (f: Fn, seen: Set<string>): string[] => {
    const out: string[] = [];
    const call = new RegExp(`(?<![\\w.])(?<!function )${f.name}\\(`, "g");
    for (const g of fns) {
      if (g.name === f.name || seen.has(g.name)) continue;
      for (const m of g.text.matchAll(call)) {
        const before = [...locks(g, 0, m.index, false), ...entry(g, new Set([...seen, g.name]))];
        out.push(...before.map((l) => `${g.name} > ${l}`));
      }
    }
    return out;
  };
  const out: string[] = [];
  for (const f of fns) {
    // The first argument is the observer (plan 12h Task 3), then the hook name.
    for (const m of f.text.matchAll(/runBefore\(\s*[\w.]+,\s*"([a-z]+\.before[A-Za-z]+)"/g)) {
      const at = m.index;
      const found = locks(f, 0, at);
      for (const c of f.text.matchAll(/const (\w+) = async \([^)]*\)(?::[^=]+)? => \{/g)) {
        const open = c.index + c[0].length - 1;
        const close = closing(f.text, open);
        if (at < open || at > close) continue;
        const uses = [...f.text.slice(close).matchAll(new RegExp(`\\b${c[1]}\\b`, "g"))];
        const last = uses.at(-1);
        if (last) found.push(...locks(f, close, close + last.index));
      }
      found.push(...entry(f, new Set([f.name])));
      if (found.length > 0) out.push(`${f.name} ${m[1]}: ${[...new Set(found)].join(", ")}`);
    }
  }
  return out.sort();
}

/** The index of the brace that closes the brace at `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return text.length;
}

describe("the table of locks over a before hook", () => {
  const readme = table(readFileSync(`${REPO}packages/core/README.md`, "utf8"));
  const page = table(readFileSync(`${DOCS}docs/guides/hooks.mdx`, "utf8"));

  it("is the same in the core README and the hooks guide", () => {
    expect(page).toEqual(readme);
  });

  it("names the seventeen flows", () => {
    expect(readme.map((r) => r.split("|")[1]?.trim())).toEqual([
      "Organization create",
      "Member add",
      "Invitation accept",
      "Invite",
      "Member removal or leave",
      "Member role change",
      "Organization delete",
      "Team create",
      "Team delete",
      "Team member add",
      "Team member removal",
      "SCIM group write",
      "Identity unlink",
      "Phone remove",
      "Account delete",
      "Platform role revoke",
      "Impersonation start",
    ]);
  });

  it("holds each before hook that the engine runs after a lock", () => {
    // Each scan line, with the flow of its table row. A changed line means a
    // lock moved: check the row's hooks and locked rows, then this list.
    const expected: [string, string][] = [
      [
        "Invitation accept",
        "acceptInvitation organization.beforeAddMember: holdUser, lockOrganization, lockTeam",
      ],
      [
        "Invitation accept",
        "acceptInvitation organization.beforeUpdateMemberRole: holdUser, lockOrganization, lockTeam",
      ],
      // The member add of ruling 25 N3 of plan 12d: addMember and the SSO sign-in call it.
      // The SCIM writes of plan 12d Task 10 call it through joinWrite, after their user
      // hold, with checked: then it runs no hook. Their joinChecks ran the hook before any lock.
      [
        "Member add",
        "addMemberIn organization.beforeAddMember: holdUser, lockOrganization, joinWrite > scimCreateUser > holdUser, joinWrite > writeChange > holdUser, joinWrite > writeChange > lockOrganization",
      ],
      // The team writes of ruling 25 N3 of plan 12d: the user-caller functions call the
      // tx-level forms after their checks, and take no lock before the call.
      // A SCIM group write (plan 12d Task 11) calls the team functions with no user caller,
      // and then they run no team hook (ruling 54). So its writeGroup paths hold no hook.
      // A group create takes the organization lock after its user hold (ruling 78).
      [
        "Team member add",
        "addTeamMembersIn organization.beforeAddTeamMember: holdUsers, lockTeam, writeGroup > holdUsers, writeGroup > lockOrganization, writeGroup > lockTeam",
      ],
      ["Organization create", "createOrganization organization.beforeAddMember: holdUser"],
      ["Organization create", "createOrganization organization.beforeCreate: holdUser"],
      [
        "Team create",
        "createTeamIn organization.beforeCreateTeam: lockOrganization, writeGroup > holdUsers, writeGroup > lockOrganization",
      ],
      [
        "Account delete",
        "deleteAccountRows organization.beforeDelete: runDelete > user compare-and-set",
      ],
      ["Account delete", "deleteAccountRows user.beforeDelete: runDelete > user compare-and-set"],
      ["Organization delete", "deleteOrganization organization.beforeDelete: lockOrganization"],
      // A SCIM group delete holds the users of a mapped group first (ruling 59 M2 of plan 12d).
      [
        "Team delete",
        "deleteTeamIn organization.beforeDeleteTeam: lockOrganization, lockTeam, writeGroup > holdUsers, writeGroup > lockOrganization",
      ],
      ["Invite", "inviteMember organization.beforeInvite: lockOrganization"],
      // The role plan of a SCIM group write runs the role hook with by null after its locks.
      [
        "SCIM group write",
        "planRoles organization.beforeUpdateMemberRole: writeMembers > writeGroup > holdUsers, writeMembers > writeGroup > lockOrganization, writeMembers > writeGroup > lockTeam",
      ],
      [
        "Impersonation start",
        "prepareSession session.beforeCreate: openSession > startImpersonation > holdUser",
      ],
      [
        "Member removal or leave",
        "removeMember organization.beforeRemoveMember: lockOrganization, ownerWrite, withRoleLoss, holdUser",
      ],
      // Plan 12i Task 5: the phone remove runs the update hook under the guard of the user row.
      ["Phone remove", "removePhone user.beforeUpdate: guardedRemove"],
      [
        "Team member removal",
        "removeTeamMembersIn organization.beforeRemoveTeamMember: lockTeam, writeGroup > holdUsers, writeGroup > lockOrganization, writeGroup > lockTeam",
      ],
      [
        "Platform role revoke",
        "revokePlatformRole organization.beforeRemoveMember: holdUser, ownerLock",
      ],
      [
        "Platform role revoke",
        "revokePlatformRole organization.beforeUpdateMemberRole: holdUser, ownerLock",
      ],
      ["Identity unlink", "unlinkIdentity identity.beforeUnlink: guardedRemove"],
      [
        "Member role change",
        "updateMemberRole organization.beforeUpdateMemberRole: ownerWrite, withRoleLoss",
      ],
    ];
    expect(lockScan()).toEqual(expected.map(([, line]) => line));
    const rows = hooksByFlow(readme);
    for (const [flow, line] of expected) {
      const hook = /^\w+ ([a-z]+\.before[A-Za-z]+):/.exec(line)?.[1] ?? "";
      expect(rows.get(flow)?.has(hook), `${flow}: ${hook}`).toBe(true);
    }
    // Each row of the table has a lock that the scan finds.
    expect([...new Set(expected.map(([flow]) => flow))].sort()).toEqual([...rows.keys()].sort());
  });
});
