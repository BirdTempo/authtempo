import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { deleteAccount } from "../../src/engine/account-delete.js";
import { addMember, removeMember } from "../../src/engine/organizations.js";
import { createRole, deleteRole } from "../../src/engine/roles.js";
import { createScimToken } from "../../src/engine/scim/tokens.js";
import { createSession, resolveSession } from "../../src/engine/sessions.js";
import { setRoleMap } from "../../src/engine/sso/connections.js";
import type { ScimScope } from "../../src/schema.js";
import { FAST } from "../password-helpers.js";
import { seedOrganization, verifiedDomain } from "../sso/helpers.js";
import { acmeWithSso, type SsoWorld, ssoSignInWorld } from "../sso/sign-in-helpers.js";
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
const ORGANIZATIONS: AuthConfig["organizations"] = {
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
    // A remove by a filter that matches no member has no target (RFC 7644 section 3.12).
    const gone = await userOf(w, "cal");
    const none = await read(
      await scim(
        w,
        w.token,
        "PATCH",
        `/Groups/${group}`,
        patch({ op: "remove", path: `members[value eq "${gone}"]` }),
      ),
    );
    expect([none.status, none.body.scimType]).toEqual([400, "noTarget"]);
  });

  it("keeps the PATCH atomic and the member caps", async () => {
    const w = await world();
    await setMap(w, { Admins: "admin" });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await userOf(w, `u${i}`));
    const group = await groupOf(w, "Admins");
    const before = await counts(w);
    // Ten values: one past PATCH_MEMBERS_MAX (9, from the D1 budget).
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
    expect(over.body.detail).toBe("one request changes at most 9 members of a group");
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
    // Nine values fit.
    const nine = await scim(
      w,
      w.token,
      "PATCH",
      `/Groups/${group}`,
      patch({ op: "add", path: "members", value: ids.slice(0, 9).map((value) => ({ value })) }),
    );
    expect(nine.status).toBe(204);
    expect(await roleOf(w, ids[8] ?? "")).toBe("admin");
  });

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
