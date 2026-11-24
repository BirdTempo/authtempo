import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrganizationToken,
  createOrganizationTokenFor,
  revokeOrganizationToken,
} from "../src/engine/organization-tokens.js";
import { addMember, createOrganization, removeMember } from "../src/engine/organizations.js";
import { createRole, deleteRole, updateRole } from "../src/engine/roles.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth, post, recordAddress, recordCredential, sessionFor } from "./helpers.js";

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

/** The storage of `inner`, but each create of an audit row throws, in a transaction too. */
function auditCreateFails(inner: StorageAdapter): StorageAdapter {
  const wrap = (s: StorageAdapter): StorageAdapter =>
    new Proxy(s, {
      get(target, prop, receiver) {
        if (prop === "create")
          return (model: string, data: unknown) => {
            if (model === "operatorAudit") throw new Error("the audit insert failed");
            return (target.create as (m: string, d: unknown) => unknown)(model, data);
          };
        if (prop === "transaction")
          return (fn: (tx: StorageAdapter) => Promise<unknown>) =>
            target.transaction((tx) => fn(wrap(tx)));
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return wrap(inner);
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

  it("route acts: each of the five rows holds the IP and the user agent of the request", async () => {
    const w = await world();
    const handle = createRouter(w.config, coreRoutes(w.config));
    const { token } = await sessionFor(w.config, w.u1);
    const ip = recordAddress("203.0.113.7");
    const userAgent = recordAddress("AuditAgent/1.0");
    const headers = {
      cookie: `${w.config.cookieName}=${token}`,
      "cf-connecting-ip": ip,
      "user-agent": userAgent,
    };
    const call = async (path: string, body: unknown) => {
      const res = await handle(post(`/auth${path}`, body, headers));
      expect(res.status, path).toBe(200);
      return res.json() as Promise<Record<string, unknown>>;
    };
    const organizationId = w.o1;
    const made = (await call("/organizations/tokens", {
      organizationId,
      name: "ci",
      permissions: {},
    })) as { token: string; apiToken: { id: string } };
    recordCredential(made.token);
    await call("/organizations/tokens/revoke", { organizationId, id: made.apiToken.id });
    const role = { organizationId, name: "lead" };
    await call("/organizations/roles/create", { ...role, rank: 1, permissions: {} });
    await call("/organizations/roles/update", { ...role, rank: 2 });
    await call("/organizations/roles/delete", role);
    for (const action of [
      "organization_token_create",
      "organization_token_revoke",
      "organization_role_create",
      "organization_role_update",
      "organization_role_delete",
    ]) {
      const rows = await w.auditOf(action);
      expect(rows, action).toHaveLength(1);
      expect({ action, ip: rows[0]?.ip, userAgent: rows[0]?.userAgent }).toEqual({
        action,
        ip,
        userAgent,
      });
    }
  });

  it("compat create: the row of createOrganizationTokenFor has no IP and no user agent", async () => {
    const w = await world();
    const made = await createOrganizationTokenFor(w.config, {
      user: w.u1,
      organizationId: w.o1,
      name: "compat",
      permissions: {},
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const [row] = await w.auditOf("organization_token_create");
    expect({ ip: row?.ip, userAgent: row?.userAgent }).toEqual({ ip: null, userAgent: null });
  });

  describe("audit throw: the audit insert throws, so the act rolls back and no row stays", () => {
    it("token revoke: the token stays", async () => {
      const w = await world();
      const made = await mint(w);
      const config = { ...w.config, storage: auditCreateFails(w.config.storage) };
      await expect(
        revokeOrganizationToken(config, { user: w.u1, organizationId: w.o1, id: made.apiToken.id }),
      ).rejects.toThrow("the audit insert failed");
      const tokens = await w.storage.findMany("organizationToken", []);
      expect(tokens.map((t) => t.id)).toEqual([made.apiToken.id]);
      expect(await w.auditOf("organization_token_revoke")).toEqual([]);
    });

    it("role update: the role keeps its old rank", async () => {
      const w = await world();
      const role = await lead(w);
      const config = { ...w.config, storage: auditCreateFails(w.config.storage) };
      await expect(
        updateRole(config, { user: w.u1, organizationId: w.o1, name: "lead", rank: 2 }),
      ).rejects.toThrow("the audit insert failed");
      const row = await w.storage.findOne("organizationRole", [
        { field: "id", op: "eq", value: role.id },
      ]);
      expect(row?.rank).toBe(1);
      expect(await w.auditOf("organization_role_update")).toEqual([]);
    });
  });
});
