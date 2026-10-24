import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { deleteAccount } from "../../src/engine/account-delete.js";
import { addMember, removeMember } from "../../src/engine/organizations.js";
import { createRole, deleteRole } from "../../src/engine/roles.js";
import { scimPatchGroup } from "../../src/engine/scim/groups.js";
import { createScimToken } from "../../src/engine/scim/tokens.js";
import { scimDeleteUser } from "../../src/engine/scim/users.js";
import { createSession, resolveSession } from "../../src/engine/sessions.js";
import { setRoleMap, updateConnection } from "../../src/engine/sso/connections.js";
import type { ScimScope } from "../../src/schema.js";
import type { StorageAdapter } from "../../src/storage/port.js";
import { seedPlatform } from "../helpers.js";
import { FAST } from "../password-helpers.js";
import { SSO_APP, seedOrganization, verifiedDomain } from "../sso/helpers.js";
import {
  acmeWithSso,
  oidcConnection,
  type SsoWorld,
  ssoSignInWorld,
} from "../sso/sign-in-helpers.js";
import { SCIM_APP, scim } from "./helpers.js";

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const BASE = "https://api.example.com/auth/scim/v2";

beforeEach(() => {
  // A kept owner row and a failed after hook each write one log line.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The organization config of the SSO worlds, with teams and dynamic roles on. */
const ORGANIZATIONS: NonNullable<AuthConfig["organizations"]> = {
  platformRole: "operator",
  platformOrganization: "platform-co",
  ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
  teams: {},
  dynamicRoles: { maxPerOrganization: 5 },
};

/**
 * The SSO sign-in world of Task 5 with `scim` on: the organization `acme`,
 * its verified domain `acme.example`, one OIDC connection, and a SCIM token
 * with every scope. `groups` is `scim.groups`.
 */
async function world(
  groups: "roles" | "teams" | "both" = "roles",
  extra: Partial<AuthConfig> = {},
) {
  const w = ssoSignInWorld({
    password: { hash: FAST, uniformSignUp: false, requireVerified: false },
    organizations: ORGANIZATIONS,
    scim: { groups },
    account: { deleteConfirm: false },
    ...extra,
  });
  const acme = await acmeWithSso(w);
  const token = await tokenOf(w, acme.organizationId);
  return { ...w, ...acme, token };
}
type World = Awaited<ReturnType<typeof world>>;

async function tokenOf(w: SsoWorld, organizationId: string, scopes?: ScimScope[]) {
  const made = await createScimToken(w.config, SCIM_APP, {
    organizationId,
    name: "directory",
    ...(scopes === undefined ? {} : { scopes }),
  });
  if (!made.ok) throw new Error(made.code);
  return made.value.token;
}

/** The status and the body of an answer. */
async function read(res: Response) {
  const text = await res.text();
  return {
    status: res.status,
    body: (text === "" ? null : JSON.parse(text)) as Record<string, unknown>,
  };
}

/** A SCIM User of the organization, through the route: its id. */
async function userOf(w: World, local: string): Promise<string> {
  const r = await read(
    await scim(w, w.token, "POST", "/Users", {
      schemas: [USER_URN],
      userName: `${local}@acme.example`,
    }),
  );
  if (r.status !== 201) throw new Error(`user ${local}: ${r.status}`);
  return String(r.body.id);
}

/** A Group through the route: its id. */
async function groupOf(w: World, displayName: string, members: string[] = []): Promise<string> {
  const r = await read(
    await scim(w, w.token, "POST", "/Groups", {
      schemas: [GROUP_URN],
      displayName,
      members: members.map((value) => ({ value })),
    }),
  );
  if (r.status !== 201)
    throw new Error(`group ${displayName}: ${r.status} ${JSON.stringify(r.body)}`);
  return String(r.body.id);
}

const patch = (...ops: Record<string, unknown>[]) => ({ schemas: [PATCH_URN], Operations: ops });

/** The role of the member row of a SCIM User in acme, or null. */
async function roleOf(w: World, scimUserId: string): Promise<string | null> {
  const su = await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: scimUserId }]);
  const member = await w.storage.findOne("member", [
    { field: "organizationId", op: "eq", value: w.organizationId },
    { field: "userId", op: "eq", value: su?.userId ?? "" },
  ]);
  return member?.role ?? null;
}

async function setMap(w: World, map: Record<string, string> | null) {
  const r = await setRoleMap(w.config, SCIM_APP, { organizationId: w.organizationId, map });
  if (!r.ok) throw new Error(r.code);
}

/** The owner of acme, as `seedOrganization` made it. */
async function owner(w: World) {
  const row = await w.storage.findOne("user", [
    { field: "email", op: "eq", value: "owner@acme.example" },
  ]);
  if (!row) throw new Error("no owner");
  return row;
}

/** The counts of the rows that a refused group write must not touch. */
async function counts(w: World) {
  const out: Record<string, number> = {};
  for (const m of ["scimGroup", "scimGroupMember", "member", "team", "teamMember"] as const)
    out[m] = (await w.storage.findMany(m, [])).length;
  out.audit = (
    await w.storage.findMany("operatorAudit", [
      { field: "action", op: "in", value: ["scim_group_create", "scim_group_update"] },
    ])
  ).length;
  return out;
}

describe("the SCIM Groups (plan 12d Task 11)", () => {
  it("creates a group and gives its members the mapped role", async () => {
    const w = await world();
    await setMap(w, { Admins: "admin" });
    const ada = await userOf(w, "ada");
    const bob = await userOf(w, "bob");
    const r = await read(
      await scim(w, w.token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: "Admins",
        externalId: "ext-1",
        members: [{ value: ada }, { value: bob, type: "User", display: "Bob" }],
      }),
    );
    expect(r.status).toBe(201);
    const id = String(r.body.id);
    // Each member holds value, $ref, and type (ruling 53 P6).
    expect(r.body).toMatchObject({
      schemas: [GROUP_URN],
      displayName: "Admins",
      externalId: "ext-1",
      meta: { resourceType: "Group", location: `${BASE}/Groups/${id}`, version: 'W/"1"' },
    });
    expect(r.body.members).toEqual(
      [ada, bob].sort().map((value) => ({ value, $ref: `${BASE}/Users/${value}`, type: "User" })),
    );
    expect([await roleOf(w, ada), await roleOf(w, bob)]).toEqual(["admin", "admin"]);
    const audit = await w.storage.findMany("operatorAudit", [
      { field: "action", op: "eq", value: "scim_group_create" },
    ]);
    expect(audit.map((a) => [a.actorKind, a.targetUserId, a.data])).toEqual([
      [
        "scim",
        null,
        {
          organizationId: w.organizationId,
          scimGroupId: id,
          changed: ["displayName", "externalId", "members"],
          membersAdded: 2,
          membersRemoved: 0,
        },
      ],
    ]);
    // A User answer names its groups, read-only.
    const user = await read(await scim(w, w.token, "GET", `/Users/${ada}`));
    expect(user.body.groups).toEqual([
      { value: id, $ref: `${BASE}/Groups/${id}`, display: "Admins", type: "direct" },
    ]);
  });

  it("takes the highest rank of the mapped groups, else the default role", async () => {
    const w = await world();
    // The lower role comes first by name, so the first mapped role is not the answer.
    await setMap(w, { Readers: "viewer", Staff: "admin" });
    const ada = await userOf(w, "ada");
    const readers = await groupOf(w, "Readers", [ada]);
    const staff = await groupOf(w, "Staff", [ada]);
    expect(await roleOf(w, ada)).toBe("admin");
    const out = (g: string) =>
      scim(
        w,
        w.token,
        "PATCH",
        `/Groups/${g}`,
        patch({ op: "remove", path: "members", value: [{ value: ada }] }),
      );
    expect((await out(staff)).status).toBe(204);
    expect(await roleOf(w, ada)).toBe("viewer");
    expect((await out(readers)).status).toBe(204);
    expect(await roleOf(w, ada)).toBe("member");
  });

  it("never gives or takes the owner role", async () => {
    const w = await world();
    const map = await setRoleMap(w.config, SCIM_APP, {
      organizationId: w.organizationId,
      map: { Owners: "owner" },
    });
    expect(map).toMatchObject({ ok: false, code: "invalid_body" });
    await setMap(w, { Viewers: "viewer" });
    // The owner of acme becomes a SCIM User through the link of the address.
    const boss = (await owner(w)).id;
    const linked = await userOf(w, "owner");
    const viewers = await groupOf(w, "Viewers", [linked]);
    expect(await roleOf(w, linked)).toBe("owner");
    const r = await scim(
      w,
      w.token,
      "PATCH",
      `/Groups/${viewers}`,
      patch({ op: "replace", path: "displayName", value: "Readers" }),
    );
    expect(r.status).toBe(204);
    expect(await roleOf(w, linked)).toBe("owner");
    expect(
      (
        await w.storage.findMany("member", [
          { field: "organizationId", op: "eq", value: w.organizationId },
          { field: "role", op: "eq", value: "owner" },
        ])
      ).map((m) => m.userId),
    ).toEqual([boss]);
  });

  it("refuses a nested group and a member of another organization", async () => {
    const w = await world();
    await setMap(w, { Admins: "admin" });
    const ada = await userOf(w, "ada");
    const group = await groupOf(w, "Admins", [ada]);
    // A User of another organization, through the token of that organization.
    const other = await acmeOther(w);
    const before = await counts(w);
    for (const body of [
      patch({ op: "add", path: "members", value: [{ value: group }] }),
      patch({ op: "add", path: "members", value: [{ value: other }] }),
      patch({ op: "add", path: "members", value: [{ value: ada, type: "Group" }] }),
    ]) {
      const r = await read(await scim(w, w.token, "PATCH", `/Groups/${group}`, body));
      expect([r.status, r.body.scimType]).toEqual([400, "invalidValue"]);
    }
    const create = await read(
      await scim(w, w.token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: "Mixed",
        members: [{ value: ada }, { value: other }],
      }),
    );
    expect([create.status, create.body.scimType]).toEqual([400, "invalidValue"]);
    expect(await counts(w)).toEqual(before);
  });

  it("answers the Entra member check filter", async () => {
    const w = await world();
    const ada = await userOf(w, "ada");
    const bob = await userOf(w, "bob");
    const group = await groupOf(w, "Staff", [ada]);
    const check = async (user: string) =>
      read(
        await scim(
          w,
          w.token,
          "GET",
          `/Groups?filter=${encodeURIComponent(`id eq "${group}" and members[value eq "${user}"]`)}&excludedAttributes=members`,
        ),
      );
    const hit = await check(ada);
    expect(hit.body.totalResults).toBe(1);
    expect((hit.body.Resources as Record<string, unknown>[])[0]).not.toHaveProperty("members");
    expect((await check(bob)).body.totalResults).toBe(0);
    // excludedAttributes=members keeps a read cheap too (Behavior 5).
    const one = await read(
      await scim(w, w.token, "GET", `/Groups/${group}?excludedAttributes=members`),
    );
    expect([one.status, one.body.displayName, one.body.members]).toEqual([200, "Staff", undefined]);
    const byName = await read(
      await scim(
        w,
        w.token,
        "GET",
        `/Groups?filter=${encodeURIComponent('displayName eq "STAFF"')}`,
      ),
    );
    expect(byName.body.totalResults).toBe(1);
  });

  it("removes a member by the filter path", async () => {
    const w = await world();
    await setMap(w, { Admins: "admin" });
    const ada = await userOf(w, "ada");
    const bob = await userOf(w, "bob");
    const group = await groupOf(w, "Admins", [ada, bob]);
    const res = await scim(
      w,
      w.token,
      "PATCH",
      `/Groups/${group}`,
      patch({ op: "remove", path: `members[value eq "${ada}"]` }),
    );
    // RFC 7644 section 3.5.2: the server MAY answer 204 with no body (Behavior 4).
    expect([res.status, await res.text()]).toEqual([204, ""]);
    expect([await roleOf(w, ada), await roleOf(w, bob)]).toEqual(["member", "admin"]);
    // With attributes in the query, the PATCH answers the group.
    const shown = await read(
      await scim(
        w,
        w.token,
        "PATCH",
        `/Groups/${group}?attributes=members`,
        patch({ op: "add", path: "members", value: [{ value: ada }] }),
      ),
    );
    expect(shown.status).toBe(200);
    expect((shown.body.members as { value: string }[]).map((m) => m.value)).toEqual(
      [ada, bob].sort(),
    );
  });

  it("answers a remove of a non-member as a removal, and writes nothing (ruling 57 item 5)", async () => {
    const changes: string[] = [];
    const w = await world("both", {
      hooks: { scim: { afterChange: (e) => void changes.push(e.action) } },
    });
    await setMap(w, { Admins: "admin" });
    const ada = await userOf(w, "ada");
    const cal = await userOf(w, "cal");
    const group = await groupOf(w, "Admins", [ada]);
    const before = await counts(w);
    const version = async () =>
      (await read(await scim(w, w.token, "GET", `/Groups/${group}`))).body.meta;
    const meta = await version();
    changes.length = 0;
    // An IdP sends a removal again after a time-out: by the filter path, or by a list of values.
    for (const body of [
      patch({ op: "remove", path: `members[value eq "${cal}"]` }),
      patch({ op: "remove", path: "members", value: [{ value: cal }] }),
    ]) {
      const res = await scim(w, w.token, "PATCH", `/Groups/${group}`, body);
      expect([res.status, await res.text()]).toEqual([204, ""]);
    }
    const shown = await read(
      await scim(
        w,
        w.token,
        "PATCH",
        `/Groups/${group}?attributes=members`,
        patch({ op: "remove", path: `members[value eq "${cal}"]` }),
      ),
    );
    expect(shown.status).toBe(200);
    expect((shown.body.members as { value: string }[]).map((m) => m.value)).toEqual([ada]);
    // No new version, no audit row, no hook.
    expect(await version()).toEqual(meta);
    expect(await counts(w)).toEqual(before);
    expect(changes).toEqual([]);
    expect(await roleOf(w, ada)).toBe("admin");
  });

  it("keeps the PATCH atomic and the member caps", async () => {
    const w = await world();
    await setMap(w, { Admins: "admin" });
    const ids: string[] = [];
    for (let i = 0; i < 1001; i++) ids.push(await userOf(w, `u${i}`));
    const group = await groupOf(w, "Admins");
    const before = await counts(w);
    // 1001 values: one past PATCH_MEMBERS_MAX (1000, the Okta batch, ruling 84 of plan 12d).
    const over = await read(
      await scim(
        w,
        w.token,
        "PATCH",
        `/Groups/${group}`,
        patch({ op: "add", path: "members", value: ids.map((value) => ({ value })) }),
      ),
    );
    expect([over.status, over.body.scimType]).toEqual([400, "invalidValue"]);
    expect(over.body.detail).toBe("one request names at most 1000 members of a group");
    // A valid add and a failed operation in one PATCH: nothing changes.
    const half = await read(
      await scim(
        w,
        w.token,
        "PATCH",
        `/Groups/${group}`,
        patch(
          { op: "add", path: "members", value: [{ value: ids[0] }] },
          { op: "replace", path: "displayName", value: "" },
        ),
      ),
    );
    expect([half.status, half.body.scimType]).toEqual([400, "invalidValue"]);
    expect(await counts(w)).toEqual(before);
    // 1000 values fit.
    const fit = await scim(
      w,
      w.token,
      "PATCH",
      `/Groups/${group}`,
      patch({ op: "add", path: "members", value: ids.slice(0, 1000).map((value) => ({ value })) }),
    );
    expect(fit.status).toBe(204);
    expect(await roleOf(w, ids[999] ?? "")).toBe("admin");
  }, 60_000);

  it("counts the member values of the request: a PUT and a PATCH replace of 1000 members over 1000 others pass (ruling 85 of plan 12d)", async () => {
    const w = await world();
    await setMap(w, { Admins: "admin" });
    const ids: string[] = [];
    for (let i = 0; i < 3001; i++) {
      // The token takes 1200 calls in 10 minutes: a new window every 1000 Users.
      if (i % 1000 === 0) w.clock.advance(600_000);
      ids.push(await userOf(w, `u${i}`));
    }
    const first = ids.slice(0, 1000);
    const second = ids.slice(1000, 2000);
    const third = ids.slice(2000, 3000);
    const members = (list: readonly string[]) => list.map((value) => ({ value }));
    const group = await groupOf(w, "Admins", first);
    const listed = async () =>
      (await w.storage.findMany("scimGroupMember", [{ field: "groupId", op: "eq", value: group }]))
        .map((m) => m.scimUserId)
        .sort();
    // A PUT of 1000 members that replaces the 1000 members of the group: 2000 changes.
    const put = await read(
      await scim(w, w.token, "PUT", `/Groups/${group}`, {
        schemas: [GROUP_URN],
        displayName: "Admins",
        members: members(second),
      }),
    );
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await listed()).toEqual([...second].sort());
    expect(await roleOf(w, first[0] ?? "")).toBe("member");
    expect(await roleOf(w, second[999] ?? "")).toBe("admin");
    // A PATCH replace of the member list names 1000 values and takes away 1000 others.
    const replace = await scim(
      w,
      w.token,
      "PATCH",
      `/Groups/${group}`,
      patch({ op: "replace", path: "members", value: members(third) }),
    );
    expect(replace.status).toBe(204);
    expect(await listed()).toEqual([...third].sort());
    // One past the cap in a PUT body.
    const before = await counts(w);
    const big = await read(
      await scim(w, w.token, "PUT", `/Groups/${group}`, {
        schemas: [GROUP_URN],
        displayName: "Admins",
        members: members([...third, ids[3000] ?? ""]),
      }),
    );
    expect([big.status, big.body.detail]).toEqual([
      400,
      "one request names at most 1000 members of a group",
    ]);
    // A group of 1001 members: a remove with no value takes away 1001 members.
    const one = await scim(
      w,
      w.token,
      "PATCH",
      `/Groups/${group}`,
      patch({ op: "add", path: "members", value: members([ids[3000] ?? ""]) }),
    );
    expect(one.status).toBe(204);
    const grown = await counts(w);
    const all = await read(
      await scim(w, w.token, "PATCH", `/Groups/${group}`, patch({ op: "remove", path: "members" })),
    );
    expect([all.status, all.body.detail]).toEqual([
      400,
      "one request takes away at most 1000 members of a group",
    ]);
    expect(await counts(w)).toEqual(grown);
    expect(grown).not.toEqual(before);
  }, 120_000);

  it("refuses a second group with the same displayName", async () => {
    const w = await world();
    await groupOf(w, "Staff");
    const r = await read(
      await scim(w, w.token, "POST", "/Groups", { schemas: [GROUP_URN], displayName: "staff" }),
    );
    expect([r.status, r.body.scimType]).toEqual([409, "uniqueness"]);
  });

  it("answers 409 role_not_found for a mapped role that is gone, and writes nothing", async () => {
    const w = await world();
    const boss = await owner(w);
    const made = await createRole(w.config, {
      user: boss,
      organizationId: w.organizationId,
      name: "web",
      permissions: { member: ["read"] },
    });
    expect(made.ok).toBe(true);
    await setMap(w, { Web: "web" });
    const gone = await deleteRole(w.config, {
      user: boss,
      organizationId: w.organizationId,
      name: "web",
    });
    expect(gone.ok).toBe(true);
    const ada = await userOf(w, "ada");
    const before = await counts(w);
    const r = await read(
      await scim(w, w.token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: "Web",
        members: [{ value: ada }],
      }),
    );
    expect([r.status, r.body.detail]).toEqual([409, "role_not_found"]);
    expect(await counts(w)).toEqual(before);
    expect(await roleOf(w, ada)).toBe("member");
  });

  it("gives back the role of the groups at a reactivate, and no team", async () => {
    const w = await world("both");
    await setMap(w, { Admins: "admin" });
    const ada = await userOf(w, "ada");
    await groupOf(w, "Admins", [ada]);
    const active = (value: boolean) =>
      scim(w, w.token, "PATCH", `/Users/${ada}`, patch({ op: "replace", path: "active", value }));
    expect((await active(false)).status).toBe(200);
    expect(await roleOf(w, ada)).toBeNull();
    expect(await w.storage.findMany("teamMember", [])).toEqual([]);
    expect((await active(true)).status).toBe(200);
    expect(await roleOf(w, ada)).toBe("admin");
    // The teams come back at the next member change of each group (ruling 53 P7).
    expect(await w.storage.findMany("teamMember", [])).toEqual([]);
  });

  it("deletes the scimGroupMember rows of a user at the account delete", async () => {
    const w = await world();
    const ada = await userOf(w, "ada");
    const group = await groupOf(w, "Staff", [ada]);
    const su = await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: ada }]);
    const s = await createSession(w.config, {
      userId: su?.userId ?? "",
      ip: null,
      userAgent: null,
    });
    const session = await resolveSession(w.config, s.token);
    if (!session) throw new Error("no session");
    expect(await deleteAccount(w.config, { session, ip: null, userAgent: null })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await w.storage.findMany("scimGroupMember", [])).toEqual([]);
    const r = await read(await scim(w, w.token, "GET", `/Groups/${group}`));
    expect([r.status, r.body.members]).toEqual([200, undefined]);
  });

  it("refuses a group write with a read scope", async () => {
    const w = await world();
    // The cap of two live tokens: the world holds one, and this is the second.
    const reader = await tokenOf(w, w.organizationId, ["scim.users.write", "scim.groups.read"]);
    const r = await scim(w, reader, "POST", "/Groups", { schemas: [GROUP_URN], displayName: "X" });
    expect(r.status).toBe(403);
    expect((await scim(w, reader, "GET", "/Groups")).status).toBe(200);
    expect(await w.storage.findMany("scimGroup", [])).toEqual([]);
  });
});

describe("the teams of the SCIM Groups (plan 12d Task 11 Behavior 3)", () => {
  it("keeps one 12k team per group", async () => {
    const w = await world("teams");
    const ada = await userOf(w, "ada");
    const bob = await userOf(w, "bob");
    const group = await groupOf(w, "Core", [ada]);
    const row = await w.storage.findOne("scimGroup", [{ field: "id", op: "eq", value: group }]);
    const team = await w.storage.findOne("team", [
      { field: "id", op: "eq", value: row?.teamId ?? "" },
    ]);
    expect([team?.name, team?.organizationId]).toEqual(["Core", w.organizationId]);
    const userIdOf = async (id: string) =>
      (await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: id }]))?.userId;
    const teamMembers = async () =>
      (
        await w.storage.findMany("teamMember", [
          { field: "teamId", op: "eq", value: team?.id ?? "" },
        ])
      )
        .map((m) => m.userId)
        .sort();
    expect(await teamMembers()).toEqual([await userIdOf(ada)]);
    const add = await scim(
      w,
      w.token,
      "PATCH",
      `/Groups/${group}`,
      patch(
        { op: "add", path: "members", value: [{ value: bob }] },
        { op: "replace", path: "displayName", value: "Platform" },
      ),
    );
    expect(add.status).toBe(204);
    expect(await teamMembers()).toEqual([await userIdOf(ada), await userIdOf(bob)].sort());
    expect(
      (await w.storage.findOne("team", [{ field: "id", op: "eq", value: team?.id ?? "" }]))?.name,
    ).toBe("Platform");
    // With teams only, the role map is not read.
    await setMap(w, { Platform: "admin" });
    const out = await scim(
      w,
      w.token,
      "PATCH",
      `/Groups/${group}`,
      patch({ op: "remove", path: `members[value eq "${ada}"]` }),
    );
    expect(out.status).toBe(204);
    expect(await teamMembers()).toEqual([await userIdOf(bob)]);
    expect(await roleOf(w, bob)).toBe("member");
    expect((await scim(w, w.token, "DELETE", `/Groups/${group}`)).status).toBe(204);
    expect(await w.storage.findMany("team", [])).toHaveLength(0);
    expect(await w.storage.findMany("teamMember", [])).toEqual([]);
    expect(await w.storage.findMany("scimGroupMember", [])).toEqual([]);
  });

  it("fires no team hook at a SCIM team write, and reports it through hooks.scim.afterChange", async () => {
    const seen: string[] = [];
    const team = (name: string) => () => void seen.push(name);
    const w = await world("both", {
      hooks: {
        organization: {
          beforeCreateTeam: team("beforeCreateTeam"),
          afterCreateTeam: team("afterCreateTeam"),
          beforeUpdateTeam: team("beforeUpdateTeam"),
          afterUpdateTeam: team("afterUpdateTeam"),
          beforeDeleteTeam: team("beforeDeleteTeam"),
          afterDeleteTeam: team("afterDeleteTeam"),
          beforeAddTeamMember: team("beforeAddTeamMember"),
          afterAddTeamMember: team("afterAddTeamMember"),
          beforeRemoveTeamMember: team("beforeRemoveTeamMember"),
          afterRemoveTeamMember: team("afterRemoveTeamMember"),
          beforeUpdateMemberRole: (e) => void seen.push(`beforeUpdateMemberRole ${e.role}`),
        },
        scim: { afterChange: (e) => void seen.push(`scim ${e.resource} ${e.action}`) },
      },
    });
    await setMap(w, { Core: "admin" });
    const ada = await userOf(w, "ada");
    const bob = await userOf(w, "bob");
    seen.length = 0;
    const group = await groupOf(w, "Core", [ada]);
    for (const body of [
      patch({ op: "add", path: "members", value: [{ value: bob }] }),
      patch({ op: "remove", path: `members[value eq "${ada}"]` }),
      patch({ op: "replace", path: "displayName", value: "Platform" }),
    ])
      expect((await scim(w, w.token, "PATCH", `/Groups/${group}`, body)).status).toBe(204);
    expect((await scim(w, w.token, "DELETE", `/Groups/${group}`)).status).toBe(204);
    // The member role hooks run with by null (ruling 54); no team hook runs.
    expect(seen).toEqual([
      "beforeUpdateMemberRole admin",
      "scim Group create",
      "beforeUpdateMemberRole admin",
      "scim Group update",
      "beforeUpdateMemberRole member",
      "scim Group update",
      "beforeUpdateMemberRole member",
      "scim Group update",
      "scim Group delete",
    ]);
  });

  it("leaves the team rows of a member that a user caller removes from the organization", async () => {
    const w = await world("teams");
    const ada = await userOf(w, "ada");
    const group = await groupOf(w, "Core", [ada]);
    const su = await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: ada }]);
    const removed = await removeMember(w.config, {
      user: await owner(w),
      organizationId: w.organizationId,
      userId: su?.userId ?? "",
    });
    expect(removed.ok).toBe(true);
    // The 12k cascade takes the team row; the SCIM group keeps its member.
    expect(await w.storage.findMany("teamMember", [])).toEqual([]);
    expect(await w.storage.findMany("scimGroupMember", [])).toHaveLength(1);
    // The member comes back by a user caller; the next group write does not add a team row twice.
    const back = await addMember(w.config, {
      user: await owner(w),
      organizationId: w.organizationId,
      userId: su?.userId ?? "",
      role: "member",
    });
    expect(back.ok).toBe(true);
    const bob = await userOf(w, "bob");
    const r = await scim(
      w,
      w.token,
      "PATCH",
      `/Groups/${group}`,
      patch({ op: "add", path: "members", value: [{ value: bob }] }),
    );
    expect(r.status).toBe(204);
    expect(await w.storage.findMany("teamMember", [])).toHaveLength(1);
  });
});

describe("the review fixes of the SCIM Groups (ruling 59 of plan 12d)", () => {
  it("stops a group add of a User that a SCIM delete took after the reads (m1)", async () => {
    const w = await world();
    const ada = await userOf(w, "ada");
    const group = await groupOf(w, "Staff");
    const caller = { organizationId: w.organizationId, actor: SCIM_APP };
    const inner = w.config.storage;
    let armed = true;
    let deleted = -1;
    // The SCIM delete of ada ends after the reads of the group write and before its
    // transaction. No foreign key ties a scimGroupMember row to its scimUser row, so
    // the read after the inserts is the one check.
    const storage = new Proxy(inner, {
      get(t, p) {
        if (p === "transaction")
          return async (fn: (tx: StorageAdapter) => Promise<unknown>) => {
            if (armed) {
              armed = false;
              deleted = (await scimDeleteUser(w.config, caller, ada, null)).status;
            }
            return t.transaction(fn);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as StorageAdapter;
    const r = await scimPatchGroup(
      { ...w.config, storage },
      caller,
      group,
      patch({ op: "add", path: "members", value: [{ value: ada }] }),
      null,
    );
    expect(deleted).toBe(204);
    expect(r.status).toBe(409);
    expect(await inner.findMany("scimGroupMember", [])).toEqual([]);
  });

  it("keeps the platform role of a member in a mapped group (m2)", async () => {
    // The platform role ranks below the owner here, so the owner rule does not keep it.
    const w = ssoSignInWorld({
      password: { hash: FAST, uniformSignUp: false, requireVerified: false },
      organizations: {
        ...ORGANIZATIONS,
        ranks: { viewer: 1, member: 2, operator: 2, admin: 3, owner: 4 },
      },
      scim: { groups: "roles" },
    });
    const { root, platformOrg } = await seedPlatform(w);
    await verifiedDomain(w, platformOrg.id, "platform-co.example");
    await oidcConnection(w, platformOrg.id, "platform");
    const token = await tokenOf(w, platformOrg.id);
    const op = await w.seedUser("op@platform-co.example");
    const added = await addMember(w.config, {
      user: root,
      organizationId: platformOrg.id,
      userId: op.id,
      role: "operator",
    });
    if (!added.ok) throw new Error(added.code);
    const made = await read(
      await scim(w, token, "POST", "/Users", {
        schemas: [USER_URN],
        userName: "op@platform-co.example",
      }),
    );
    expect(made.status).toBe(201);
    const map = await setRoleMap(w.config, SCIM_APP, {
      organizationId: platformOrg.id,
      map: { Admins: "admin" },
    });
    expect(map.ok).toBe(true);
    const group = await read(
      await scim(w, token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: "Admins",
        members: [{ value: String(made.body.id) }],
      }),
    );
    expect(group.status).toBe(201);
    const member = await w.storage.findOne("member", [
      { field: "organizationId", op: "eq", value: platformOrg.id },
      { field: "userId", op: "eq", value: op.id },
    ]);
    expect(member?.role).toBe("operator");
  });

  it("reads the role map of the enabled connection that the organization made first (m2)", async () => {
    const w = await world();
    w.clock.advance(1000);
    const later = await oidcConnection(w, w.organizationId, "beta");
    const mapped = await updateConnection(w.config, SSO_APP, {
      id: later,
      scimRoles: { Admins: "viewer" },
    });
    expect(mapped.ok).toBe(true);
    // The map of the first connection: setRoleMap writes it there.
    await setMap(w, { Admins: "admin" });
    const ada = await userOf(w, "ada");
    const group = await groupOf(w, "Admins", [ada]);
    expect(await roleOf(w, ada)).toBe("admin");
    // With the first connection off, the map of the later one applies at the next member change.
    const off = await updateConnection(w.config, SSO_APP, { id: w.connectionId, enabled: false });
    expect(off.ok).toBe(true);
    const bob = await userOf(w, "bob");
    const res = await scim(
      w,
      w.token,
      "PATCH",
      `/Groups/${group}`,
      patch({ op: "add", path: "members", value: [{ value: bob }] }),
    );
    expect(res.status).toBe(204);
    // A new map applies to the members whose roles a write computes (ruling 53 P8).
    expect([await roleOf(w, ada), await roleOf(w, bob)]).toEqual(["admin", "viewer"]);
  });

  it("answers 409 last_team to the delete of the group of the last team (m2)", async () => {
    const w = await world("teams", {
      organizations: { ...ORGANIZATIONS, teams: { keepLastTeam: true } },
    });
    const ada = await userOf(w, "ada");
    const group = await groupOf(w, "Core", [ada]);
    const before = await counts(w);
    const r = await read(await scim(w, w.token, "DELETE", `/Groups/${group}`));
    expect([r.status, r.body.detail]).toEqual([409, "last_team"]);
    expect(await counts(w)).toEqual(before);
  });

  it("counts every added person against membersPerTeam (m2)", async () => {
    const w = await world("teams", {
      organizations: { ...ORGANIZATIONS, limits: { membersPerTeam: 2 } },
    });
    const ada = await userOf(w, "ada");
    const bob = await userOf(w, "bob");
    const cal = await userOf(w, "cal");
    const group = await groupOf(w, "Core", [ada]);
    const before = await counts(w);
    const r = await read(
      await scim(
        w,
        w.token,
        "PATCH",
        `/Groups/${group}`,
        patch({ op: "add", path: "members", value: [{ value: bob }, { value: cal }] }),
      ),
    );
    expect([r.status, r.body.detail]).toEqual([409, "team_member_limit"]);
    expect(await counts(w)).toEqual(before);
  });

  it("answers 400 invalidValue to the delete of a mapped group past 1000 members (l1)", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 1001; i++) ids.push(await userOf(w, `u${i}`));
    const group = await groupOf(w, "Admins");
    for (let i = 0; i < ids.length; i += 1000) {
      const r = await scim(
        w,
        w.token,
        "PATCH",
        `/Groups/${group}`,
        patch({
          op: "add",
          path: "members",
          value: ids.slice(i, i + 1000).map((value) => ({ value })),
        }),
      );
      expect(r.status).toBe(204);
    }
    // The map comes last: a rename or a delete now computes 1001 roles (ruling 84 of plan 12d).
    await setMap(w, { Admins: "admin" });
    const before = await counts(w);
    const r = await read(await scim(w, w.token, "DELETE", `/Groups/${group}`));
    expect([r.status, r.body.scimType]).toEqual([400, "invalidValue"]);
    expect(await counts(w)).toEqual(before);
  }, 60_000);

  it("ends a list page with members before 10000 member rows (Info)", async () => {
    const w = await world();
    const a = await groupOf(w, "Alpha");
    const b = await groupOf(w, "Beta");
    const c = await groupOf(w, "Gamma");
    // 5001 Users in both Alpha and Beta, and one in Gamma: 10003 member rows. The rows
    // come through storage, as 556 PATCH requests of 9 members each would write them.
    const now = w.clock.now();
    for (let i = 0; i < 5001; i++) {
      const user = await w.seedUser(`m${i}@acme.example`);
      await w.storage.create("member", {
        id: `mb-${i}`,
        organizationId: w.organizationId,
        userId: user.id,
        role: "member",
        createdAt: now,
        updatedAt: now,
      });
      const su = await w.storage.create("scimUser", {
        id: `su-${String(i).padStart(5, "0")}`,
        organizationId: w.organizationId,
        userId: user.id,
        userName: `m${i}@acme.example`,
        userNameKey: `m${i}@acme.example`,
        externalId: null,
        active: true,
        displayName: null,
        data: {},
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      for (const g of i === 0 ? [a, b, c] : [a, b])
        await w.storage.create("scimGroupMember", {
          id: `gm-${g}-${i}`,
          groupId: g,
          scimUserId: su.id,
          createdAt: now,
          updatedAt: now,
        });
    }
    const page = async (query: string) => {
      const r = await read(await scim(w, w.token, "GET", `/Groups?${query}`));
      const list = r.body.Resources as { id: string; members?: unknown[] }[];
      return {
        total: r.body.totalResults,
        items: Number(r.body.itemsPerPage),
        groups: list.map((g) => [g.id, g.members?.length ?? 0]),
      };
    };
    // The page order is by id. Each page holds whole groups, at most 10000 member rows.
    const order = [a, b, c].sort().map((id) => [id, id === c ? 1 : 5001] as const);
    const fits = (from: number) => {
      const out: (readonly [string, number])[] = [];
      let rows = 0;
      for (const g of order.slice(from)) {
        if (out.length > 0 && rows + g[1] > 10000) break;
        out.push(g);
        rows += g[1];
      }
      return out;
    };
    // In each order, the first page ends before the third group.
    const first = await page("startIndex=1&count=100");
    expect(first).toEqual({ total: 3, items: fits(0).length, groups: fits(0) });
    expect(first.items).toBeLessThan(3);
    const next = first.items + 1;
    expect(await page(`startIndex=${next}&count=100`)).toEqual({
      total: 3,
      items: fits(next - 1).length,
      groups: fits(next - 1),
    });
    // Without members, a page holds every group.
    expect(await page("excludedAttributes=members")).toMatchObject({ total: 3, items: 3 });
  }, 120_000);
});

/** A User of the organization `other`, with its own verified domain: its id. */
async function acmeOther(w: World): Promise<string> {
  const { organizationId } = await acmeWithSsoOf(w, "other");
  const token = await tokenOf(w, organizationId);
  const r = await read(
    await scim(w, token, "POST", "/Users", { schemas: [USER_URN], userName: "eve@other.example" }),
  );
  if (r.status !== 201) throw new Error(`other user: ${r.status}`);
  return String(r.body.id);
}

/** The organization `slug` with the verified domain `<slug>.example`. */
async function acmeWithSsoOf(w: World, slug: string) {
  const organizationId = await seedOrganization(w, slug);
  await verifiedDomain(w, organizationId, `${slug}.example`);
  return { organizationId };
}

describe("the provider shapes of the SCIM Groups (plan 12d Task 12)", () => {
  const ADSCIM = "http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group";

  it("accepts the Microsoft group URN of the Entra group create, and no other URN", async () => {
    const w = await world();
    // The Create Group request of "Develop and plan provisioning for a SCIM
    // endpoint" (Microsoft Learn, read 2026-10-22T14:47:53Z).
    const entra = await read(
      await scim(w, w.token, "POST", "/Groups", {
        schemas: [GROUP_URN, ADSCIM],
        externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
        displayName: "displayName",
        meta: { resourceType: "Group" },
      }),
    );
    expect([entra.status, entra.body.schemas, entra.body.displayName]).toEqual([
      201,
      [GROUP_URN],
      "displayName",
    ]);
    for (const schemas of [[GROUP_URN, "urn:example:custom:2.0:Group"], [ADSCIM]]) {
      const r = await read(
        await scim(w, w.token, "POST", "/Groups", { schemas, displayName: "Other" }),
      );
      expect([r.status, r.body.scimType], JSON.stringify(schemas)).toEqual([400, "invalidSyntax"]);
    }
    const rows = await w.storage.findMany("scimGroup", [
      { field: "organizationId", op: "eq", value: w.organizationId },
    ]);
    expect(rows.map((g) => g.displayName)).toEqual(["displayName"]);
  });
});
