import { describe, expect, it } from "vitest";
import { can, effectiveOf } from "../src/access.js";
import type { OrganizationsConfig } from "../src/config.js";
import { deriveRoles, needs, RULE_STATEMENTS, RULES, rankOf } from "../src/engine/ranks.js";
import { makeAuth } from "./helpers.js";

type Rule = keyof typeof RULES;
const RULE_NAMES = Object.keys(RULES) as Rule[];

/**
 * For each role and rule, the statement answer equals the plan 6 rank answer.
 * The statement of `slugChange` is `organization:update`, so its row compares
 * with the `update` rule. `updateOrganization` keeps the owner rank check.
 */
function compare(roles: readonly string[], organizations: OrganizationsConfig) {
  const o = makeAuth({ organizations }).config.organizations;
  if (o === null) throw new Error("organizations is off");
  const rows: string[] = [];
  for (const role of roles)
    for (const rule of RULE_NAMES) {
      const rankRule = rule === "slugChange" ? "update" : rule;
      const rank = rankOf(o.ranks, role) >= needs(o, rankRule);
      const statement = can(effectiveOf(role, o.roles), RULE_STATEMENTS[rule]);
      if (statement !== rank) rows.push(`${role} ${rule}: statements ${statement}, ranks ${rank}`);
    }
  return rows;
}

describe("the default role table", () => {
  it("gives each default role the answer of plan 6 for each rule", () => {
    expect(RULE_NAMES).toHaveLength(10);
    expect(compare(["viewer", "member", "admin", "owner"], {})).toEqual([]);
  });

  it("gives the slug change the update statement and keeps its owner rank", () => {
    expect(RULE_STATEMENTS.slugChange).toEqual({ organization: ["update"] });
    const o = makeAuth({ organizations: {} }).config.organizations;
    if (o === null) throw new Error("organizations is off");
    expect(needs(o, "slugChange")).toBe(4);
  });

  it("gives each default role the core actions of spec 29 item 2", () => {
    // Written by hand from spec 29 item 2: ac:read and member:read viewer,
    // organization:delete owner, each other core action admin.
    const viewer = { member: ["read"], ac: ["read"] };
    const admin = {
      organization: ["update"],
      member: ["read", "create", "update", "delete"],
      invitation: ["read", "create", "cancel"],
      team: ["create", "update", "delete"],
      ac: ["read", "create", "update", "delete"],
      apiToken: ["read", "create", "update", "revoke"],
    };
    expect(deriveRoles({ viewer: 1, member: 2, admin: 3, owner: 4 })).toEqual({
      viewer: { rank: 1, permissions: viewer },
      member: { rank: 2, permissions: viewer },
      admin: { rank: 3, permissions: admin },
      owner: { rank: 4, permissions: { ...admin, organization: ["update", "delete"] } },
    });
  });

  it("gives the same answer on consumerd's rank table", () => {
    const ranks = { learner: 1, guardian: 2, teacher: 2, admin: 3, owner: 4 };
    expect(compare(Object.keys(ranks), { ranks })).toEqual([]);
  });

  it("refuses ranks and roles together, an owner-less roles table, a comma in a role name, and an unknown permission", () => {
    const owner = { rank: 4, permissions: { organization: ["update", "delete"] } };
    expect(() => makeAuth({ organizations: { ranks: { owner: 4 }, roles: { owner } } })).toThrow(
      "organizations takes ranks or roles, not both",
    );
    expect(() =>
      makeAuth({ organizations: { roles: { admin: { rank: 3, permissions: {} } } } }),
    ).toThrow("organizations.roles must name owner");
    expect(() =>
      makeAuth({ organizations: { roles: { owner, "a,b": { rank: 2, permissions: {} } } } }),
    ).toThrow("organizations.roles has a bad role name: a,b");
    expect(() =>
      makeAuth({
        organizations: {
          roles: { owner, editor: { rank: 2, permissions: { project: ["read"] } } },
        },
      }),
    ).toThrow("organizations.roles.editor.permissions: project is not a known resource");
    // The same permission passes when the app declares the resource.
    const o = makeAuth({
      organizations: {
        statements: { project: ["read", "write"] },
        roles: { owner, editor: { rank: 2, permissions: { project: ["read"] } } },
      },
    }).config.organizations;
    expect(o?.ranks).toEqual({ owner: 4, editor: 2 });
    expect(o?.roles.editor?.permissions).toEqual({ project: ["read"] });
    expect(o?.statements.project).toEqual(["read", "write"]);
  });

  it("refuses a core resource in statements", () => {
    expect(() => makeAuth({ organizations: { statements: { member: ["x"] } } })).toThrow(
      "organizations.statements.member is a core resource",
    );
  });
});
