import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrganizationToken,
  createOrganizationTokenFor,
  revokeOrganizationToken,
} from "../src/engine/organization-tokens.js";
import { addMember, createOrganization, removeMember } from "../src/engine/organizations.js";
import { createRole, deleteRole, updateRole } from "../src/engine/roles.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { makeAuth, recordCredential, sessionFor } from "./helpers.js";

// Plan 13b Task 5: the token and role acts of an organization each write one audit row in their
// transaction. The organization is `o1` and its owner is `u1`.

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Organization `o1` with dynamic roles, made by its owner `u1`. */
async function world() {
  const w = makeAuth({ organizations: { dynamicRoles: {} } });
  const u1 = await w.seedUser("u1@example.test");
  const made = await createOrganization(w.config, { user: u1, slug: "o1", name: "O1" });
  if (!made.ok) throw new Error(made.code);
  const o1 = made.value.organization.id;
  const auditOf = (action: string) =>
    w.storage.findMany("operatorAudit", [{ field: "action", op: "eq", value: action }]);
  return { ...w, u1, o1, auditOf };
}
type W = Awaited<ReturnType<typeof world>>;

/** A token of `o1` that `u1` makes through a session. */
async function mint(w: W) {
  const made = await createOrganizationToken(w.config, {
    session: await sessionFor(w.config, w.u1),
    organizationId: w.o1,
    name: "ci",
    permissions: { member: ["read"] },
  });
  if (!made.ok) throw new Error(made.code);
  recordCredential(made.value.token);
  return made.value;
}

/** A stored role `lead` of `o1` that `u1` makes. */
async function lead(w: W) {
  const made = await createRole(w.config, {
    user: w.u1,
    organizationId: w.o1,
    name: "lead",
    rank: 1,
    permissions: { member: ["read"] },
  });
  if (!made.ok) throw new Error(made.code);
  return made.value;
}

/** The fields of a row that each act of this task shares: the actor `u1`, the column `o1`, no target. */
const byOwner = (w: W) => ({
  actorKind: "user",
  actorId: w.u1.id,
  organizationId: w.o1,
  targetUserId: null,
});

describe("the audit rows of the token and role acts (plan 13b Task 5)", () => {
  describe("each act: org o1, owner u1, one row as the table says", () => {
    it("organization_token_create: data { tokenId, hint, permissions }", async () => {
      const w = await world();
      const made = await mint(w);
      const rows = await w.auditOf("organization_token_create");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ...byOwner(w),
        reason: "an organization created a token",
        data: {
          tokenId: made.apiToken.id,
          hint: made.apiToken.hint,
          permissions: { member: ["read"] },
        },
      });
      expect(Object.keys(rows[0]?.data ?? {}).sort()).toEqual(["hint", "permissions", "tokenId"]);
    });

    it("organization_token_revoke: data { tokenId }", async () => {
      const w = await world();
      const made = await mint(w);
      const revoked = await revokeOrganizationToken(w.config, {
        user: w.u1,
        organizationId: w.o1,
        id: made.apiToken.id,
      });
      expect(revoked.ok).toBe(true);
      const rows = await w.auditOf("organization_token_revoke");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ...byOwner(w), reason: "an organization revoked a token" });
      expect(rows[0]?.data).toEqual({ tokenId: made.apiToken.id });
    });

    it("organization_role_create: data { roleId, name, rank }", async () => {
      const w = await world();
      const role = await lead(w);
      const rows = await w.auditOf("organization_role_create");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ...byOwner(w), reason: "an organization created a role" });
      expect(rows[0]?.data).toEqual({ roleId: role.id, name: "lead", rank: 1 });
    });

    it("organization_role_update: data { roleId, changed } with the field names only", async () => {
      const w = await world();
      const role = await lead(w);
      const updated = await updateRole(w.config, {
        user: w.u1,
        organizationId: w.o1,
        name: "lead",
        rank: 2,
        permissions: { member: ["read"] },
      });
      expect(updated.ok).toBe(true);
      const rows = await w.auditOf("organization_role_update");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ...byOwner(w), reason: "an organization changed a role" });
      // The permissions did not change, so only the rank is named, and no value is in the row.
      expect(rows[0]?.data).toEqual({ roleId: role.id, changed: ["rank"] });
    });

    it("organization_role_delete: data { roleId, name }", async () => {
      const w = await world();
      const role = await lead(w);
      const deleted = await deleteRole(w.config, {
        user: w.u1,
        organizationId: w.o1,
        name: "lead",
      });
      expect(deleted.ok).toBe(true);
      const rows = await w.auditOf("organization_role_delete");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ...byOwner(w), reason: "an organization deleted a role" });
      expect(rows[0]?.data).toEqual({ roleId: role.id, name: "lead" });
    });
  });

  it("no token: the create row holds no token value and no hash, only the hint", async () => {
    const w = await world();
    const made = await mint(w);
    const [row] = await w.auditOf("organization_token_create");
    const text = JSON.stringify(row);
    expect(text).not.toContain(made.token);
    expect(text).not.toContain(await sha256Hex(made.token));
    expect(row?.data?.hint).toBe(made.apiToken.hint);
  });

  it("compat create: createOrganizationTokenFor writes one row with the user of the input", async () => {
    const w = await world();
    const made = await createOrganizationTokenFor(w.config, {
      user: w.u1,
      organizationId: w.o1,
      name: "compat",
      permissions: {},
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const rows = await w.auditOf("organization_token_create");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...byOwner(w), data: { tokenId: made.value.apiToken.id } });
  });

  it("member remove with tokens: a removal with revokeTokens writes no token revoke row", async () => {
    const w = await world();
    const u2 = await w.seedUser("u2@example.test");
    const added = await addMember(w.config, {
      user: w.u1,
      organizationId: w.o1,
      userId: u2.id,
      role: "admin",
    });
    if (!added.ok) throw new Error(added.code);
    const made = await createOrganizationToken(w.config, {
      session: await sessionFor(w.config, u2),
      organizationId: w.o1,
      name: "u2-ci",
      permissions: {},
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const removed = await removeMember(w.config, {
      user: w.u1,
      session: (await sessionFor(w.config, w.u1)).session,
      organizationId: w.o1,
      userId: u2.id,
      revokeTokens: true,
    });
    expect(removed.ok).toBe(true);
    // The token went with the member.
    expect(await w.storage.findMany("organizationToken", [])).toEqual([]);
    // The member remove row of Task 4 names the tokens; the token act writes no row of its own.
    expect(await w.auditOf("organization_token_revoke")).toEqual([]);
  });
});
