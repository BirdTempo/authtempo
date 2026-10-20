import { describe, expect, it } from "vitest";
import { roleHasPermission, type Statements } from "../src/index.js";

// A static role table of the app, as the server config holds it in the `roles` form.
const roles = {
  member: { rank: 1, permissions: { project: ["read"] } },
  admin: { rank: 3, permissions: { project: ["read", "write"], member: ["read", "delete"] } },
};

describe("the access check of the client entry (plan 12k)", () => {
  it("answers each role part of a role string from the static table", () => {
    const write: Statements = { project: ["write"] };
    expect(roleHasPermission(roles, "admin", write)).toBe(true);
    expect(roleHasPermission(roles, "member", write)).toBe(false);
    expect(roleHasPermission(roles, "member,admin", write)).toBe(true);
  });

  it("answers false for an unknown part, an empty request, and a bad role", () => {
    expect(roleHasPermission(roles, "ghost", { project: ["read"] })).toBe(false);
    expect(roleHasPermission(roles, "admin", {})).toBe(false);
    expect(roleHasPermission(roles, null as unknown as string, { project: ["read"] })).toBe(false);
  });
});
