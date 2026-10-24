import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAccount } from "../../src/engine/account-delete.js";
import { ORGANIZATION_REST } from "../../src/engine/organization-rest.js";
import { deleteOrganization } from "../../src/engine/organizations.js";
import { sweepExpired } from "../../src/engine/sweep.js";
import { IN_CHUNK } from "../../src/storage/batch.js";
import { type ScimWorld, scim, scimAuth, scimToken } from "./helpers.js";

// The SCIM Groups go with their organization (ruling 53 P9 and ruling 74
// of plan 12d): the organization delete removes the scimGroup and
// scimGroupMember rows. One delete binds at most 50 group ids on D1, and the
// delete takes 500 groups. More groups answer delete_too_large, and nothing
// goes. The account delete takes the organization row and its SCIM token,
// and the sweep takes the groups, 50 at a time (ruling 78 of plan 12d).

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Acme with the SCIM User ada and `n` Groups, each with ada as its member. */
async function acmeWithGroups(n: number) {
  const w = await scimAuth();
  const { token } = await scimToken(w);
  const made = await scim(w, token, "POST", "/Users", {
    schemas: [USER_URN],
    userName: "ada@acme.example",
  });
  const ada = String(((await made.json()) as { id: string }).id);
  for (let i = 0; i < n; i++) {
    const g = await scim(w, token, "POST", "/Groups", {
      schemas: [GROUP_URN],
      displayName: `Group ${i}`,
      members: [{ value: ada }],
    });
    expect(g.status).toBe(201);
  }
  return { w, token, ada };
}

/** The pending rows of the solo organizations of an account delete. */
const pendingRests = async (w: ScimWorld) =>
  (
    await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: ORGANIZATION_REST },
    ])
  ).length;

const rows = async (w: ScimWorld) => ({
  organizations: (await w.storage.findMany("organization", [])).length,
  groups: (await w.storage.findMany("scimGroup", [])).length,
  members: (await w.storage.findMany("scimGroupMember", [])).length,
  scimUsers: (await w.storage.findMany("scimUser", [])).length,
});

describe("the SCIM Groups of a deleted organization (ruling 74 of plan 12d)", () => {
  it("deletes the scimGroup and scimGroupMember rows with the organization", async () => {
    const { w } = await acmeWithGroups(3);
    expect(await rows(w)).toEqual({ organizations: 1, groups: 3, members: 3, scimUsers: 1 });
    const gone = await deleteOrganization(w.config, { user: w.owner.user, organizationId: w.org });
    expect(gone).toEqual({ ok: true, value: { ok: true } });
    expect(await rows(w)).toEqual({ organizations: 0, groups: 0, members: 0, scimUsers: 0 });
  });

  it("answers delete_too_large for 501 groups, and deletes nothing", async () => {
    const { w } = await acmeWithGroups(501);
    const before = await rows(w);
    expect(before).toEqual({ organizations: 1, groups: 501, members: 501, scimUsers: 1 });
    const refused = await deleteOrganization(w.config, {
      user: w.owner.user,
      organizationId: w.org,
    });
    expect(refused).toMatchObject({ ok: false, code: "delete_too_large" });
    expect(await rows(w)).toEqual(before);
    const res = await w.handle(
      new Request("https://api.example.com/auth/organizations/delete", {
        method: "POST",
        headers: {
          cookie: `__Host-tempo_session=${w.owner.token}`,
          "content-type": "application/json",
          origin: "https://api.example.com",
        },
        body: JSON.stringify({ organizationId: w.org }),
      }),
    );
    expect([res.status, await res.json()]).toEqual([409, { error: "delete_too_large" }]);
    expect(await rows(w)).toEqual(before);
  }, 30_000);

  it("takes a solo organization with groups at an account delete, and the sweep the rest", async () => {
    const { w, token, ada } = await acmeWithGroups(2);
    // The deactivate removes ada's member row, so the owner is the only member. Her group
    // rows stay.
    const off = await scim(w, token, "PATCH", `/Users/${ada}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(off.status).toBe(200);
    expect(await rows(w)).toEqual({ organizations: 1, groups: 2, members: 2, scimUsers: 1 });
    const done = await deleteAccount(w.config, { session: w.owner, ip: null, userAgent: null });
    expect(done).toEqual({ ok: true, value: { ok: true } });
    // The act takes the organization and its SCIM token (ruling 78 of plan 12d). The groups
    // and the SCIM User wait for the sweep, and no request reaches them.
    expect(await rows(w)).toEqual({ organizations: 0, groups: 2, members: 2, scimUsers: 1 });
    expect((await scim(w, token, "GET", "/Groups")).status).toBe(401);
    const owner = [{ field: "id" as const, op: "eq" as const, value: w.owner.user.id }];
    expect(await w.storage.findOne("user", owner)).toBeNull();
    expect((await sweepExpired(w.config)).organizationRows).toBe(1);
    expect(await rows(w)).toEqual({ organizations: 0, groups: 0, members: 0, scimUsers: 0 });
    expect(await pendingRests(w)).toBe(0);
  });

  it("takes the groups of a solo organization in chunks of 50 at the sweep", async () => {
    const { w, token, ada } = await acmeWithGroups(IN_CHUNK + 1);
    const off = await scim(w, token, "PATCH", `/Users/${ada}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(off.status).toBe(200);
    const done = await deleteAccount(w.config, { session: w.owner, ip: null, userAgent: null });
    expect(done).toEqual({ ok: true, value: { ok: true } });
    // The first sweep takes one chunk of groups, and the row waits.
    expect((await sweepExpired(w.config)).organizationRows).toBe(0);
    expect(await rows(w)).toEqual({ organizations: 0, groups: 1, members: 1, scimUsers: 1 });
    expect(await pendingRests(w)).toBe(1);
    expect((await sweepExpired(w.config)).organizationRows).toBe(1);
    expect(await rows(w)).toEqual({ organizations: 0, groups: 0, members: 0, scimUsers: 0 });
    expect(await pendingRests(w)).toBe(0);
  }, 30_000);
});
