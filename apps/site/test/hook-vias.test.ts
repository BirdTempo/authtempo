import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The hooks guide lists the `via` values of three hook inputs. Each list must
// hold every member of its type in core, so a new value fails here until the
// guide names it. Plan 12i Tasks 5 and 6 added `phone` and `anonymous` to
// the session type, and the guide missed both (ruling 31 join).

const HOOKS = readFileSync(`${REPO}packages/core/src/engine/hooks.ts`, "utf8");
const GUIDE = readFileSync(`${DOCS}docs/guides/hooks.mdx`, "utf8");

/** The string members of the union `name` in hooks.ts. */
function union(name: string): string[] {
  const body = new RegExp(`export type ${name} =([^;]+);`).exec(HOOKS)?.[1];
  if (body === undefined) throw new Error(`no type ${name}`);
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? "").sort();
}

/** The code values of the guide row whose first cell is `label`. */
function row(label: string): string[] {
  const line = GUIDE.split("\n").find((l) => l.startsWith(`| ${label} |`));
  if (line === undefined) throw new Error(`no row ${label}`);
  const cell = line.split("|")[2] ?? "";
  return [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] ?? "").sort();
}

describe("the via rows of the hooks guide", () => {
  it.each([
    ["`via` of a session", "SessionVia"],
    ["`via` of a user update", "UserUpdateVia"],
    ["`via` of a user verify", "UserVerifyVia"],
  ])("%s lists each member of %s", (label, type) => {
    const members = union(type);
    expect(members.length).toBeGreaterThan(4);
    expect(row(label)).toEqual(members);
  });
});

// The sweep ends each left session with the reason of the act that left it
// (12f2 follow-up 3 of plan 12n). The keys of PENDING_STOP_CAUSE in
// access-end.ts are those reasons, so the sweep bullet names each key.
const ACCESS_END = readFileSync(`${REPO}packages/core/src/engine/operator/access-end.ts`, "utf8");

describe("the sweep bullet of the hooks guide", () => {
  it("names each reason of a pending end that access-end.ts holds", () => {
    const body = /const PENDING_STOP_CAUSE[^=]*= \{([^}]*)\};/.exec(ACCESS_END)?.[1];
    if (body === undefined) throw new Error("no PENDING_STOP_CAUSE in access-end.ts");
    const keys = [...body.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1] ?? "").sort();
    expect(keys.length).toBeGreaterThan(4);
    const bullet = GUIDE.split("\n").find((l) => l.startsWith("- The sweep fires two hooks."));
    if (bullet === undefined) throw new Error("no sweep bullet in the hooks guide");
    const reasons = /with the reason of that act: ([^.]*)\./.exec(bullet)?.[1] ?? "";
    expect([...reasons.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] ?? "").sort()).toEqual(keys);
  });
});

// The account delete ends the user's own sessions in one page
// (endOwnSessionsPage of access-end.ts). A page takes at most
// END_ALL_LIMIT.default rows. account-delete.ts gives the page the budget
// only on a store that claims the query limit, and the compat storage
// claims it on D1 only. Each compat storage cascades the user delete after
// the page. So the four places name both cases (ruling 30 of plan 12n).
const SESSIONS = readFileSync(`${REPO}packages/core/src/engine/operator/sessions.ts`, "utf8");
const COMPAT_STORAGE = readFileSync(
  `${REPO}packages/compat-better-auth/src/storage/index.ts`,
  "utf8",
);

/** The text of `path`, with each run of white space as one space. */
const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

// A self delete of a platform operator also ends the impersonation sessions
// that it opened (account-delete.ts). So the page words name the user's own
// sessions (queue item 3 of plan 12n, rr-final of plan 12n).
const guideWords = (n: string) =>
  `On the D1 storage of the compatibility package, that is one page of sessions. On the Postgres and SQLite storages of that package, that is up to ${n} of the user's own sessions. In both cases, the cascade of the Better Auth tables deletes the rest with no hook.`;
const compatWords = (n: string) =>
  `On the D1 storage, a delete ends one page of the user's sessions with \`session.afterEnd\`, such as 8 of 60. On the Postgres and SQLite storages, a delete ends up to ${n} of the user's own sessions with \`session.afterEnd\`. In both cases, the cascade of the user row deletes the rest with no hook and no \`impersonation_stop\` row.`;
const compatOwnWords = (n: string) =>
  `On the D1 storage, a delete ends one page of the user's sessions with \`session.afterEnd\`, such as 8 of 60. On the Postgres and SQLite storages, a delete ends up to ${n} of the user's own sessions with \`session.afterEnd\`. In both cases, the cascade of the user row deletes the rest with no hook and no \`impersonation_stop\` row.`;

describe("the delete residual of the compatibility package", () => {
  it("claims the query limit on the D1 storage only", () => {
    expect(COMPAT_STORAGE.split("queryLimitPerInvocation: true").length - 1).toBe(1);
    const d1 = /options\.dialect === "d1"\) \{([\s\S]*?)return d1;/.exec(COMPAT_STORAGE)?.[1];
    expect(d1).toContain("queryLimitPerInvocation: true");
  });

  it.each([
    ["the hooks guide", `${DOCS}docs/guides/hooks.mdx`, guideWords],
    ["the core README", `${REPO}packages/core/README.md`, guideWords],
    ["the compat page", `${DOCS}docs/reference/compat-better-auth.md`, compatOwnWords],
    ["the compat README", `${REPO}packages/compat-better-auth/README.md`, compatWords],
  ])("%s names both cases, with the page size of sessions.ts", (_, path, words) => {
    const size = /export const END_ALL_LIMIT = \{ default: (\d+),/.exec(SESSIONS)?.[1];
    if (size === undefined) throw new Error("no END_ALL_LIMIT in sessions.ts");
    expect(flat(path)).toContain(words(size));
  });
});
