import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifiedDomain } from "../sso/helpers.js";
import { type Replayed, replay, type ScimWorld, scim, scimAuth, scimToken } from "./helpers.js";

// The Okta sequence of plan 12d Task 12. Each request is a file of
// fixtures/okta/ (SOURCE.md names its section of the Okta SCIM 2.0 protocol
// reference), sent in the order of the page's flow. Each assertion names the
// file, and checks the status and the fields that the page shows in its answer.

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const LIST_URN = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

/** The ids of the page: the user of the flow, its group, and the second member. */
const PAGE_USER = "23a35c27-23d3-4c03-b4c5-6443c09e7173";
const PAGE_GROUP = "abf4dd94-a4c0-4f67-89c9-76b03340cb9b";
const PAGE_SECOND = "89bb1940-b905-4575-9e7f-6f887cfb368e";

beforeEach(() => {
  // A refused request and a kept owner row each write one log line.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The SCIM world with okta.local, the domain of the page's users, verified through the fake DNS ports. */
async function oktaWorld() {
  const w = await scimAuth();
  await verifiedDomain(w, w.org, "okta.local");
  const { token } = await scimToken(w);
  return { ...w, token };
}
type OktaWorld = ScimWorld & { token: string };

function expectStatus(r: Replayed, status: number) {
  expect(r.status, `${r.file}: ${JSON.stringify(r.body)}`).toBe(status);
}

/** A SCIM User at okta.local through the route, not from the page: its id. */
async function another(w: OktaWorld, local: string): Promise<string> {
  const r = await scim(w, w.token, "POST", "/Users", {
    schemas: [USER_URN],
    userName: `${local}@okta.local`,
  });
  expect(r.status).toBe(201);
  return String(((await r.json()) as { id: string }).id);
}

/** The member ids of a group, in the order of the answer. */
async function membersOf(w: OktaWorld, groupId: string): Promise<string[]> {
  const r = await scim(w, w.token, "GET", `/Groups/${groupId}`);
  expect(r.status).toBe(200);
  const body = (await r.json()) as { members?: { value: string }[] };
  return (body.members ?? []).map((m) => m.value);
}

describe("the Okta sequence (plan 12d Task 12)", () => {
  it("replays the user requests of the page in the order of its flow", async () => {
    const w = await oktaWorld();
    // The two reads of the save: lists with integer counts (the page asks for integers).
    for (const name of ["01-list-users-at-setup", "02-list-groups-at-setup"]) {
      const r = await replay(w, w.token, "okta", name);
      expectStatus(r, 200);
      expect(r.body, r.file).toMatchObject({
        schemas: [LIST_URN],
        totalResults: 0,
        startIndex: 1,
        itemsPerPage: 0,
        Resources: [],
      });
    }
    const find = await replay(w, w.token, "okta", "03-find-user");
    expectStatus(find, 200);
    expect(find.body, find.file).toMatchObject({ totalResults: 0, Resources: [] });

    // The create holds the password that Okta always sends (plan 12d Task 12 P2).
    const created = await replay(w, w.token, "okta", "04-create-user");
    expectStatus(created, 201);
    const fields = {
      schemas: [USER_URN],
      userName: "test.user@okta.local",
      name: { givenName: "Test", familyName: "User" },
      emails: [{ primary: true, value: "test.user@okta.local", type: "work" }],
      displayName: "Test User",
      locale: "en-US",
      externalId: "00ujl29u0le5T6Aj10h7",
      active: true,
      meta: { resourceType: "User" },
    };
    expect(created.body, created.file).toMatchObject(fields);
    expect(created.body.password, created.file).toBeUndefined();
    // The page answers "groups": []. An empty list is unassigned (RFC 7643
    // section 2.5), and this server leaves it out.
    expect(created.body.groups ?? [], created.file).toEqual([]);
    const id = String(created.body.id);

    // The page: a create of a user that exists answers 409 with the error schema.
    const exists = await replay(w, w.token, "okta", "05-create-user-custom-attributes");
    expectStatus(exists, 409);
    expect([exists.body.status, exists.body.scimType], exists.file).toEqual(["409", "uniqueness"]);

    const list = await replay(w, w.token, "okta", "06-list-users");
    expectStatus(list, 200);
    expect(list.body, list.file).toMatchObject({
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [{ id }],
    });
    const found = await replay(w, w.token, "okta", "03-find-user");
    expect(found.body, found.file).toMatchObject({ totalResults: 1, Resources: [{ id }] });

    const ids = { [PAGE_USER]: id };
    const got = await replay(w, w.token, "okta", "07-get-user", ids);
    expectStatus(got, 200);
    expect(got.body, got.file).toMatchObject({ id, ...fields });

    // The PUT of the page holds id, groups, and meta, which are read-only.
    const put = await replay(w, w.token, "okta", "08-replace-user", ids);
    expectStatus(put, 200);
    expect(put.body, put.file).toMatchObject({
      id,
      userName: "test.user@okta.local",
      name: { givenName: "Another", middleName: "Excited", familyName: "User" },
      emails: [
        {
          primary: true,
          value: "test.user@okta.local",
          type: "work",
          display: "test.user@okta.local",
        },
      ],
      active: true,
    });

    const off = await replay(w, w.token, "okta", "09-deactivate-user", ids);
    expectStatus(off, 200);
    expect([off.body.id, off.body.active], off.file).toEqual([id, false]);
    const after = await replay(w, w.token, "okta", "07-get-user", ids);
    expect(after.body.active, after.file).toBe(false);
  });

  it("replays the group requests of the page in the order of its flow", async () => {
    const w = await oktaWorld();
    const user = String((await replay(w, w.token, "okta", "04-create-user")).body.id);
    const second = await another(w, "second.user");
    const ids = { [PAGE_USER]: user, [PAGE_GROUP]: "", [PAGE_SECOND]: second };

    const created = await replay(w, w.token, "okta", "10-create-group");
    expectStatus(created, 201);
    expect(created.body, created.file).toMatchObject({
      schemas: [GROUP_URN],
      displayName: "Test SCIMv2",
      meta: { resourceType: "Group" },
    });
    expect(created.body.members ?? [], created.file).toEqual([]);
    const group = String(created.body.id);
    ids[PAGE_GROUP] = group;

    const list = await replay(w, w.token, "okta", "11-list-groups");
    expectStatus(list, 200);
    expect(list.body, list.file).toMatchObject({
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [{ id: group, displayName: "Test SCIMv2" }],
    });
    const find = await replay(w, w.token, "okta", "12-find-group");
    expectStatus(find, 200);
    expect(find.body, find.file).toMatchObject({
      totalResults: 1,
      Resources: [{ id: group, displayName: "Test SCIMv2" }],
    });
    const got = await replay(w, w.token, "okta", "13-get-group", ids);
    expectStatus(got, 200);
    expect(got.body, got.file).toMatchObject({ schemas: [GROUP_URN], id: group });

    // The PATCH rename sends the group id in its value. The page allows 204.
    const rename = await replay(w, w.token, "okta", "14-rename-group-patch", ids);
    expectStatus(rename, 204);

    // The PUT rename of an app of the App Integration Wizard: the id in the
    // body is not the id of the path, and is read-only.
    const put = await replay(w, w.token, "okta", "15-rename-group-put", {
      U0FP0NMEE: group,
      "some-member-1": user,
      "some-member-2": second,
    });
    expectStatus(put, 200);
    expect(put.body, put.file).toMatchObject({ id: group, displayName: "Tour Guides" });
    expect(await membersOf(w, group)).toEqual([user, second].sort());

    // A remove by the filter path and an add in one PATCH.
    const update = await replay(w, w.token, "okta", "16-update-members-patch", ids);
    expectStatus(update, 204);
    expect(await membersOf(w, group)).toEqual([user]);

    const putMembers = await replay(w, w.token, "okta", "17-update-members-put", ids);
    expectStatus(putMembers, 200);
    expect(putMembers.body, putMembers.file).toMatchObject({
      id: group,
      displayName: "Test SCIMv2",
      members: [{ value: user }],
    });

    const replace = await replay(w, w.token, "okta", "18-replace-members-patch", ids);
    expectStatus(replace, 204);
    expect(await membersOf(w, group)).toEqual([user, second].sort());

    const deleted = await replay(w, w.token, "okta", "19-delete-group", ids);
    expectStatus(deleted, 204);
    const gone = await replay(w, w.token, "okta", "13-get-group", ids);
    expectStatus(gone, 404);
  });

  it("refuses a full push of ten members: the known gap of ruling 57 item 2", async () => {
    // Okta sends up to 1000 members in one group PATCH (ruling 57 item 2 of
    // plan 12d). This server takes PATCH_MEMBERS_MAX (9) values per request
    // on every store, from the D1 budget. The 12d final fix wave owns the
    // fix (a multi-row insert, then a larger cap). This test names the gap.
    const w = await oktaWorld();
    const group = String((await replay(w, w.token, "okta", "10-create-group")).body.id);
    const users: string[] = [];
    for (let i = 0; i < 10; i++) users.push(await another(w, `member${i}`));
    const push = (values: string[]) =>
      scim(w, w.token, "PATCH", `/Groups/${group}`, {
        schemas: [PATCH_URN],
        Operations: [{ op: "replace", path: "members", value: values.map((value) => ({ value })) }],
      });
    const ten = await push(users);
    expect(ten.status).toBe(400);
    expect(((await ten.json()) as { scimType: string }).scimType).toBe("invalidValue");
    expect(await membersOf(w, group)).toEqual([]);
    const nine = await push(users.slice(0, 9));
    expect(nine.status).toBe(204);
    expect(await membersOf(w, group)).toEqual(users.slice(0, 9).sort());
  });
});
