import { readFileSync } from "node:fs";
import { type Auth, createAuth } from "@authtempo/core";
import { CORE_STATEMENTS } from "@authtempo/core/access";
import { describe, expect, it } from "vitest";
import { API, APP, call, harness, signIn } from "../samples/support/harness.ts";
import { DOCS } from "../scripts/lib/paths.ts";

// The two tables of the roles guide copy the code (plan 12k, ruling 36 m1).
// A change on one side only fails this test.
const PAGE = `${DOCS}docs/guides/roles-and-permissions.mdx`;

// The default ranks of `organizations`. The derivation table names roles, not ranks.
const RANKS: Readonly<Record<string, number>> = { viewer: 1, member: 2, admin: 3, owner: 4 };

/** The lines after the line `from`, up to the next line that starts with `to`. */
function section(text: string, from: string, to: string): string[] {
  const lines = text.split("\n");
  const at = lines.indexOf(from);
  if (at < 0) throw new Error(`no line "${from}"`);
  const end = lines.findIndex((l, i) => i > at && l.startsWith(to));
  return lines.slice(at + 1, end < 0 ? undefined : end);
}

/** The body rows of the first table in the lines, as lists of cells. */
function tableRows(lines: readonly string[]): string[][] {
  const table = lines.filter((l) => l.startsWith("| "));
  // The first row is the head, and the second is the rule.
  return table.slice(2).map((l) =>
    l
      .slice(2, -2)
      .split(" | ")
      .map((c) => c.trim()),
  );
}

/** The names in backticks of one cell. */
function names(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

/** Each `resource:action` of a statement set, sorted. */
function flat(set: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(set)
    .flatMap(([resource, actions]) => actions.map((a) => `${resource}:${a}`))
    .sort();
}

describe("the tables of the roles guide", () => {
  const text = readFileSync(PAGE, "utf8");

  it("the resource table is CORE_STATEMENTS", () => {
    const rows = tableRows(section(text, "### Statements", "### "));
    const page = Object.fromEntries(
      rows.map(([resource = "", actions = ""]) => [names(resource)[0] ?? "", names(actions)]),
    );
    expect(Object.keys(page)).toHaveLength(6);
    expect(page).toEqual(CORE_STATEMENTS);
  });

  it("the derivation table is auth.permissionsOf for each default role", async () => {
    const rows = tableRows(section(text, "### The derivation table", "### "));
    const lowest = rows.flatMap(([actions = "", role = ""]) =>
      names(actions).map((a) => ({ action: a, rank: RANKS[names(role)[0] ?? ""] ?? 0 })),
    );
    expect(lowest.filter((r) => r.rank === 0)).toEqual([]);

    const h = harness();
    const auth: Auth = createAuth({
      baseURL: API,
      appURL: APP,
      trustedOrigins: [APP],
      secret: h.secret,
      storage: h.storage,
      mail: h.mail,
      organizations: {},
    });
    const owner = await signIn(auth, h, "owner@example.com");
    const created = await call(
      auth,
      "POST",
      "/auth/organizations/create",
      { slug: "acme", name: "Acme" },
      { cookie: owner },
    );
    const { organization } = (await created.json()) as { organization: { id: string } };
    const cookies: Record<string, string> = { owner };
    for (const role of ["viewer", "member", "admin"]) {
      const cookie = await signIn(auth, h, `${role}@example.com`);
      const session = await call(auth, "GET", "/auth/session", undefined, { cookie });
      const { user } = (await session.json()) as { user: { id: string } };
      const added = await call(
        auth,
        "POST",
        "/auth/organizations/members/add",
        { organizationId: organization.id, userId: user.id, role },
        { cookie: owner },
      );
      expect(added.status).toBe(200);
      cookies[role] = cookie;
    }

    for (const [role, rank] of Object.entries(RANKS)) {
      const caller = await auth.caller(
        new Request(API, { headers: { cookie: cookies[role] ?? "" } }),
      );
      if (!caller) throw new Error(`no caller for ${role}`);
      const r = await auth.permissionsOf(caller, organization.id);
      if (!r.ok) throw new Error(`permissionsOf answered ${r.code} for ${role}`);
      const page = lowest
        .filter((x) => rank >= x.rank)
        .map((x) => x.action)
        .sort();
      expect({ role, held: flat(r.value.permissions) }).toEqual({ role, held: page });
    }
  });
});
