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
  `On the D1 storage, a delete ends one page of the user's sessions with \`session.afterEnd\`, such as 8 of 60. On the Postgres and SQLite storages, a delete ends up to ${n} of the user's own sessions with \`session.afterEnd\`. In both cases, the cascade of the user row deletes the rest with no hook.`;

// On a cascading store the delete reads the user's live impersonation
// sessions before its page, at most STOPS_LIMIT of access-end.ts. The
// pending-end row names those that the page does not end, and the sweep
// writes their stop rows (decisions 3 to 5 of plan 12o). Each place of the
// residual names the rule, with the limit of the code. The limit counts each
// live impersonation session of the user, also those that the page ends.
// Minor 2 of the Task 2 review of plan 12o set these words.
const stopsWords = (limit: string) =>
  `With the impersonation tool on, the delete records the impersonation sessions that the cascade ends. The sweep writes their \`impersonation_stop\` rows from its next run. A delete of a user with more than ${limit} live impersonation sessions answers \`delete_too_large\` and changes nothing.`;
const AUDIT = readFileSync(`${REPO}packages/core/src/engine/operator/audit.ts`, "utf8");
const ACCOUNT_DELETE = readFileSync(`${REPO}packages/core/src/engine/account-delete.ts`, "utf8");

/** STOPS_LIMIT of access-end.ts. */
function stopsLimit(): string {
  const limit = /export const STOPS_LIMIT = (\d+);/.exec(ACCESS_END)?.[1];
  if (limit === undefined) throw new Error("no STOPS_LIMIT in access-end.ts");
  return limit;
}

describe("the delete residual of the compatibility package", () => {
  it("claims the query limit on the D1 storage only", () => {
    expect(COMPAT_STORAGE.split("queryLimitPerInvocation: true").length - 1).toBe(1);
    const d1 = /options\.dialect === "d1"\) \{([\s\S]*?)return d1;/.exec(COMPAT_STORAGE)?.[1];
    expect(d1).toContain("queryLimitPerInvocation: true");
  });

  it.each([
    ["the hooks guide", `${DOCS}docs/guides/hooks.mdx`, guideWords],
    ["the core README", `${REPO}packages/core/README.md`, guideWords],
    ["the compat page", `${DOCS}docs/reference/compat-better-auth.md`, compatWords],
    ["the compat README", `${REPO}packages/compat-better-auth/README.md`, compatWords],
  ])(
    "%s names both cases, with the page size of sessions.ts, and the stop rows of the sweep",
    (_, path, words) => {
      const size = /export const END_ALL_LIMIT = \{ default: (\d+),/.exec(SESSIONS)?.[1];
      if (size === undefined) throw new Error("no END_ALL_LIMIT in sessions.ts");
      expect(flat(path)).toContain(`${words(size)} ${stopsWords(stopsLimit())}`);
    },
  );

  it("the operator tools guide and the API page name the stop rows of the sweep, with endedAt of writeStopRow", () => {
    const writer = /export async function writeStopRow\([\s\S]*?\n\}/.exec(AUDIT)?.[0] ?? "";
    expect(writer).toMatch(/\{ endedAt \}/);
    expect(flat(`${DOCS}docs/guides/operator-tools.mdx`)).toContain(
      `On a storage whose user delete cascades, an account delete records the impersonation sessions that the cascade ends. The sweep writes their stop rows from its next run. Such a row also holds \`endedAt\` in \`data\`, the time of the delete. A delete of a user with more than ${stopsLimit()} live impersonation sessions answers \`delete_too_large\`.`,
    );
    expect(flat(`${DOCS}docs/reference/api.md`)).toContain(
      "Its `data` is `{ sessionId, cause }`, and `operator.afterAction` gets it after the commit. A row that the sweep writes after an account delete also holds `endedAt`, the time of the delete.",
    );
  });

  it("the operator tools guide names the one read of the audit table by the sweep, with its bound", () => {
    // Ruling 19 of plan 12o. The sweep step of a pending-end row with stops
    // reads the user's stop rows. It skips a session that another flow ended.
    // audit.ts stays the one reader of the table. Ruling 24 of plan 12o: the
    // guide names the bound of the read, the skew before the delete and the
    // newest rows of the limit.
    const reader = /export async function stoppedSessions\([\s\S]*?\n\}/.exec(AUDIT)?.[0] ?? "";
    expect(reader).toContain('{ field: "targetUserId", op: "eq", value: userId }');
    expect(reader).toContain('{ field: "action", op: "eq", value: "impersonation_stop" }');
    expect(reader).toContain('{ field: "createdAt", op: "gte", value: since }');
    expect(reader).toContain('{ sort: { field: "id", dir: "desc" }, limit }');
    const step = /export async function endPendingRows\([\s\S]*?\n\}/.exec(ACCESS_END)?.[0] ?? "";
    expect(step).toMatch(/owed\.length > 0 &&[\s\S]*await stoppedSessions\(/);
    expect(step).toContain("const since = new Date(at - ACCESS_END_SKEW_MS);");
    expect(step).toContain(
      "const stopped = await stoppedSessions(tx, row.identifier, since, STOPPED_READ_LIMIT);",
    );
    expect(step).toContain("due = owed.filter((x) => !stopped.has(x.sessionId));");
    expect(ACCESS_END.split('"operatorAudit"').length - 1).toBe(0);
    const skew = /export const ACCESS_END_SKEW_MS = (\d+)_000;/.exec(ACCESS_END)?.[1];
    if (skew === undefined) throw new Error("no ACCESS_END_SKEW_MS in access-end.ts");
    expect(ACCESS_END).toContain("const STOPPED_READ_LIMIT = 2 * STOPS_LIMIT;");
    const newest = 2 * Number(stopsLimit());
    expect(flat(`${DOCS}docs/guides/operator-tools.mdx`)).toContain(
      `Core never updates or deletes a row. The sweep reads the table only for a user whose delete recorded impersonation sessions. It reads the stop rows of that user from ${skew} s before the delete, at most the newest ${newest}. It writes no second stop row for a session that one of these rows names.`,
    );
  });

  it("the errors page names the second cause of delete_too_large, with STOPS_LIMIT", () => {
    expect(flat(`${DOCS}docs/reference/errors.md`)).toContain(
      `There an account delete answers it when the user has more than ${stopsLimit()} live impersonation sessions, with the impersonation tool on.`,
    );
  });

  it("the errors page names each compat storage as one whose user delete cascades", () => {
    // Low 3 of the Task 2 review of plan 12o. Each storage of the compat
    // package goes through cascading(), which sets userDeleteCascades. Only
    // such a store reads the impersonation sessions and refuses past the limit.
    const kinds = COMPAT_STORAGE.split('kind: "authtempo-compat-database"').length - 1;
    expect(kinds).toBeGreaterThan(2);
    expect(COMPAT_STORAGE.split("storage: cascading(").length - 1).toBe(kinds);
    expect(COMPAT_STORAGE).toContain("storage.userDeleteCascades = true;");
    expect(ACCOUNT_DELETE).toContain(
      "const cascades = config.storage.userDeleteCascades === true;",
    );
    expect(ACCOUNT_DELETE).toContain("const readsStops = cascades && proof.stops !== null;");
    expect(ACCOUNT_DELETE).toContain(
      'if (impersonated.length > STOPS_LIMIT) stopWith("delete_too_large");',
    );
    expect(flat(`${DOCS}docs/reference/errors.md`)).toContain(
      "A storage whose user delete cascades, such as each storage of the compatibility package, has a second cause.",
    );
  });

  it("the errors page names the remedy past the limit with the endUser call of the operator API", () => {
    // Low 3 of the Task 2 review of plan 12o. api.operator is operatorApi of
    // create-auth.ts, and its sessions.endUser answers `more` until no session stays.
    const CREATE_AUTH = readFileSync(`${REPO}packages/core/src/create-auth.ts`, "utf8");
    const OPERATOR_INDEX = readFileSync(
      `${REPO}packages/core/src/engine/operator/index.ts`,
      "utf8",
    );
    expect(CREATE_AUTH).toContain("operator: operatorApi(config),");
    expect(OPERATOR_INDEX).toMatch(
      /sessions: \{\s*endUser: entry\(\(i\) => endUserSessions\(config, i\)\),/,
    );
    const answer = /export interface EndUserSessionsAnswer \{[^}]*\}/.exec(SESSIONS)?.[0] ?? "";
    expect(answer).toContain("more: boolean;");
    expect(flat(`${DOCS}docs/reference/errors.md`)).toContain(
      `For an account with more than ${stopsLimit()} live impersonation sessions, call \`api.operator.sessions.endUser\` until \`more\` is false, or wait until those sessions expire.`,
    );
  });
});
