import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifiedDomain } from "../sso/helpers.js";
import { type Replayed, replay, type ScimWorld, scim, scimAuth, scimToken } from "./helpers.js";

// The Microsoft Entra ID sequence of plan 12d Task 12. Each request is a file
// of fixtures/entra/ (SOURCE.md names its page and section), sent in the
// order of the page's flow. Each assertion names the file, and checks the
// status and the fields that the page shows in its answer.

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const ENTERPRISE_URN = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const LIST_URN = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_URN = "urn:ietf:params:scim:api:messages:2.0:Error";

beforeEach(() => {
  // A refused request and a kept owner row each write one log line.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The SCIM world with the domains of the page verified through the fake DNS
 * ports: the users of the page are at testuser.com, and its updates move
 * them to microsoft.com and test.microsoft.com.
 */
async function entraWorld() {
  const w = await scimAuth();
  for (const domain of ["testuser.com", "microsoft.com", "test.microsoft.com"])
    await verifiedDomain(w, w.org, domain);
  const { token } = await scimToken(w);
  return { ...w, token };
}
type EntraWorld = ScimWorld & { token: string };

function expectStatus(r: Replayed, status: number) {
  expect(r.status, `${r.file}: ${JSON.stringify(r.body)}`).toBe(status);
}

/** The core User fields of the page's Create User answer. */
const CREATED = {
  externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
  userName: "Test_User_00aa00aa-bb11-cc22-dd33-44ee44ee44ee",
  name: { formatted: "givenName familyName", familyName: "familyName", givenName: "givenName" },
  active: true,
  emails: [
    {
      value: "Test_User_11bb11bb-cc22-dd33-ee44-55ff55ff55ff@testuser.com",
      type: "work",
      primary: true,
    },
  ],
};

/** The created User of 01-create-user.json: its id. */
async function createdUser(w: EntraWorld): Promise<string> {
  const r = await replay(w, w.token, "entra", "01-create-user");
  expectStatus(r, 201);
  return String(r.body.id);
}

/** The Entra member check of a group (Task 9 Behavior 6): the page gives no request text. */
async function memberCheck(w: EntraWorld, groupId: string, userId: string): Promise<number> {
  const filter = `id eq "${groupId}" and members[value eq "${userId}"]`;
  const r = await scim(
    w,
    w.token,
    "GET",
    `/Groups?filter=${encodeURIComponent(filter)}&excludedAttributes=members`,
  );
  expect(r.status).toBe(200);
  const body = (await r.json()) as { totalResults: number };
  return body.totalResults;
}

describe("the Entra ID sequence (plan 12d Task 12)", () => {
  it("replays the user requests of the page in the order of its flow", async () => {
    const w = await entraWorld();
    const created = await replay(w, w.token, "entra", "01-create-user");
    expectStatus(created, 201);
    expect(created.body, created.file).toMatchObject({
      ...CREATED,
      meta: { resourceType: "User" },
    });
    expect(created.body.schemas, created.file).toContain(USER_URN);
    const meta = created.body.meta as Record<string, unknown>;
    expect([typeof meta.created, typeof meta.lastModified], created.file).toEqual([
      "string",
      "string",
    ]);
    const id = String(created.body.id);
    expect(created.headers.get("location"), created.file).toBe(meta.location);

    // The SCIM Validator of the page: a second create of the same payload answers 409.
    const again = await replay(w, w.token, "entra", "01-create-user");
    expectStatus(again, 409);
    expect(again.body.scimType, again.file).toBe("uniqueness");

    const got = await replay(w, w.token, "entra", "02-get-user", { "5d48a0a8e9f04aa38008": id });
    expectStatus(got, 200);
    expect(got.body, got.file).toMatchObject({ id, ...CREATED });

    // The id of the page is not one of this server, so the read answers 404.
    const missing = await replay(w, w.token, "entra", "03-get-user-not-found");
    expectStatus(missing, 404);
    expect([missing.body.schemas, missing.body.status], missing.file).toEqual([[ERROR_URN], "404"]);

    const query = await replay(w, w.token, "entra", "04-get-user-by-query");
    expectStatus(query, 200);
    expect(query.body, query.file).toMatchObject({
      schemas: [LIST_URN],
      totalResults: 1,
      startIndex: 1,
      Resources: [{ id, userName: CREATED.userName, active: true }],
    });

    const zero = await replay(w, w.token, "entra", "05-get-user-by-query-zero");
    expectStatus(zero, 200);
    expect(zero.body, zero.file).toMatchObject({
      schemas: [LIST_URN],
      totalResults: 0,
      Resources: [],
      startIndex: 1,
    });

    const multi = await replay(w, w.token, "entra", "06-update-user-multi-valued", {
      "6764549bef60420686bc": id,
    });
    expectStatus(multi, 200);
    expect(multi.body, multi.file).toMatchObject({
      id,
      name: { familyName: "updatedFamilyName", givenName: "givenName" },
      emails: [{ value: "updatedEmail@microsoft.com", type: "work", primary: true }],
    });

    const single = await replay(w, w.token, "entra", "07-update-user-single-valued", {
      "5171a35d82074e068ce2": id,
    });
    expectStatus(single, 200);
    expect(single.body.userName, single.file).toBe(
      "5b50642d-79fc-4410-9e90-4c077cdd1a59@testuser.com",
    );

    // Disable User, then the SCIM Validator's read: the user stays, with active false.
    const disabled = await replay(w, w.token, "entra", "08-disable-user", {
      "5171a35d82074e068ce2": id,
    });
    expectStatus(disabled, 200);
    expect(disabled.body.active, disabled.file).toBe(false);
    const read = await replay(w, w.token, "entra", "02-get-user", { "5d48a0a8e9f04aa38008": id });
    expectStatus(read, 200);
    expect(read.body.active, read.file).toBe(false);

    const deleted = await replay(w, w.token, "entra", "09-delete-user", {
      "5171a35d82074e068ce2": id,
    });
    expectStatus(deleted, 204);
    const gone = await replay(w, w.token, "entra", "02-get-user", { "5d48a0a8e9f04aa38008": id });
    expectStatus(gone, 404);
  });

  it("matches the User of the page by its work email (ruling 60 P3 of plan 12d)", async () => {
    const w = await entraWorld();
    const id = await createdUser(w);
    // The work email of the page's Create User body.
    const work = CREATED.emails[0]?.value ?? "";
    const find = async (type: string, value: string) => {
      const filter = `emails[type eq "${type}"].value eq "${value}"`;
      const r = await scim(w, w.token, "GET", `/Users?filter=${encodeURIComponent(filter)}`);
      expect(r.status, filter).toBe(200);
      return ((await r.json()) as { Resources: { id: string }[] }).Resources.map((x) => x.id);
    };
    expect(await find("work", work)).toEqual([id]);
    // The type and the address compare with no case.
    expect(await find("Work", work.toUpperCase())).toEqual([id]);
    expect(await find("home", work)).toEqual([]);
    expect(await find("work", "someone@testuser.com")).toEqual([]);
  });

  it("replays the group requests of the page in the order of its flow", async () => {
    const w = await entraWorld();
    const userId = await createdUser(w);
    const created = await replay(w, w.token, "entra", "10-create-group");
    expectStatus(created, 201);
    expect(created.body, created.file).toMatchObject({
      schemas: [GROUP_URN],
      externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
      displayName: "displayName",
      meta: { resourceType: "Group" },
    });
    // The page answers "members": []. An empty list is unassigned (RFC 7643
    // section 2.5), and this server leaves it out.
    expect(created.body.members ?? [], created.file).toEqual([]);
    const groupId = String(created.body.id);

    // The SCIM Validator of the page: a second create of the same payload answers 409.
    const again = await replay(w, w.token, "entra", "10-create-group");
    expectStatus(again, 409);
    expect(again.body.scimType, again.file).toBe("uniqueness");

    const got = await replay(w, w.token, "entra", "11-get-group", {
      "40734ae655284ad3abcc": groupId,
    });
    expectStatus(got, 200);
    expect(got.body, got.file).toMatchObject({
      schemas: [GROUP_URN],
      id: groupId,
      externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
      displayName: "displayName",
      meta: { resourceType: "Group" },
    });
    expect(Object.hasOwn(got.body, "members"), got.file).toBe(false);

    const byName = await replay(w, w.token, "entra", "12-get-group-by-display-name");
    expectStatus(byName, 200);
    expect(byName.body, byName.file).toMatchObject({
      schemas: [LIST_URN],
      totalResults: 1,
      startIndex: 1,
      Resources: [{ id: groupId, displayName: "displayName" }],
    });

    const renamed = await replay(w, w.token, "entra", "13-update-group-name", {
      fa2ce26709934589afc5: groupId,
    });
    expectStatus(renamed, 204);
    const named = await replay(w, w.token, "entra", "11-get-group", {
      "40734ae655284ad3abcc": groupId,
    });
    expect(named.body.displayName, named.file).toBe(
      "1879db59-3bdf-4490-ad68-ab880a269474updatedDisplayName",
    );

    const ids = { a99962b9f99d4c4fac67: groupId, f648f8d5ea4e4cd38e9c: userId };
    const added = await replay(w, w.token, "entra", "14-update-group-add-members", ids);
    expectStatus(added, 204);
    expect(await memberCheck(w, groupId, userId)).toBe(1);
    const removed = await replay(w, w.token, "entra", "15-update-group-remove-members", ids);
    expectStatus(removed, 204);
    expect(await memberCheck(w, groupId, userId)).toBe(0);

    // The two remove forms of the Known issues page, each after a new add.
    for (const [name, pageId] of [
      ["26-known-remove-member-without-flag", "u1091"],
      ["27-known-remove-member-with-flag", "7f4bc1a3-285e-48ae-8202-5accb43efb0e"],
    ] as const) {
      expectStatus(await replay(w, w.token, "entra", "14-update-group-add-members", ids), 204);
      expect(await memberCheck(w, groupId, userId)).toBe(1);
      const r = await replay(w, w.token, "entra", name, { [pageId]: userId }, `/Groups/${groupId}`);
      expectStatus(r, 204);
      expect(await memberCheck(w, groupId, userId), r.file).toBe(0);
    }

    const deleted = await replay(w, w.token, "entra", "16-delete-group", {
      cdb1ce18f65944079d37: groupId,
    });
    expectStatus(deleted, 204);
    const gone = await replay(w, w.token, "entra", "11-get-group", {
      "40734ae655284ad3abcc": groupId,
    });
    expectStatus(gone, 404);

    const schemas = await replay(w, w.token, "entra", "17-discover-schema");
    expectStatus(schemas, 200);
    expect(schemas.body.schemas, schemas.file).toEqual([LIST_URN]);
    const resources = schemas.body.Resources as { id: string }[];
    expect(resources.map((s) => s.id).sort(), schemas.file).toEqual(
      [GROUP_URN, USER_URN, ENTERPRISE_URN].sort(),
    );
  });

  it("replays the PATCH forms of the Known issues page, with and without the flag", async () => {
    const w = await entraWorld();
    const id = await createdUser(w);
    const path = `/Users/${id}`;
    for (const name of [
      "22-known-add-attribute-without-flag",
      "23-known-add-attribute-with-flag",
    ]) {
      const r = await replay(w, w.token, "entra", name, {}, path);
      expectStatus(r, 200);
      expect(r.body.nickName, r.file).toBe("Babs");
    }
    const without = await replay(
      w,
      w.token,
      "entra",
      "24-known-replace-attributes-without-flag",
      {},
      path,
    );
    expectStatus(without, 200);
    expect(without.body, without.file).toMatchObject({
      displayName: "Pvlo",
      externalId: "Eqpj",
      name: { givenName: "Gtfd", familyName: "Pkqf" },
      emails: [{ value: "TestBcwqnm@test.microsoft.com", type: "work" }],
      [ENTERPRISE_URN]: { employeeNumber: "Eqpj" },
    });
    // The flag form: a no-path value whose keys are paths (name.givenName and the enterprise URN path).
    const flag = await replay(
      w,
      w.token,
      "entra",
      "25-known-replace-attributes-with-flag",
      {},
      path,
    );
    expectStatus(flag, 200);
    expect(flag.body, flag.file).toMatchObject({
      displayName: "Bjfe",
      name: { givenName: "Kkom", familyName: "Unua" },
      emails: [{ value: "TestMhvaes@test.microsoft.com", type: "work" }],
      [ENTERPRISE_URN]: { employeeNumber: "Aklq" },
    });
    // The disable without the flag sends active as the text "False".
    const text = await replay(w, w.token, "entra", "20-known-disable-user-without-flag", {}, path);
    expectStatus(text, 200);
    expect(text.body.active, text.file).toBe(false);
    const bool = await replay(w, w.token, "entra", "21-known-disable-user-with-flag", {}, path);
    expectStatus(bool, 200);
    expect(bool.body.active, bool.file).toBe(false);
  });

  it("replays the examples of the sample code section", async () => {
    const w = await entraWorld();
    // Example 1 sends the value with no quotes. RFC 7644 section 3.4.2.2 needs
    // a JSON string, and the protocol section of the same page quotes it.
    const unquoted = await replay(w, w.token, "entra", "30-example-1-query-user");
    expectStatus(unquoted, 400);
    expect(unquoted.body.scimType, unquoted.file).toBe("invalidFilter");
    // Example 2 names "...:enterprise:2.0User", a typo of the page for the
    // enterprise URN. A URN that this server does not serve answers
    // invalidSyntax (ruling 50 of plan 12d).
    const typo = await replay(w, w.token, "entra", "31-example-2-provision-user");
    expectStatus(typo, 400);
    expect(typo.body.scimType, typo.file).toBe("invalidSyntax");

    const id = await createdUser(w);
    const ids = { "a0a0a0a0-bbbb-cccc-dddd-e1e1e1e1e1e1": id };
    const got = await replay(w, w.token, "entra", "32-example-3-get-user", ids);
    expectStatus(got, 200);
    expect(got.body.id, got.file).toBe(id);
    // Example 5 sends the manager as a list of one object with its $ref.
    const manager = await replay(w, w.token, "entra", "33-example-5-update-user", ids);
    expectStatus(manager, 200);
    expect(manager.body[ENTERPRISE_URN], manager.file).toMatchObject({
      manager: { value: "00aa00aa-bb11-cc22-dd33-44ee44ee44ee" },
    });
    const deleted = await replay(w, w.token, "entra", "34-example-6-delete-user", ids);
    expectStatus(deleted, 204);
  });
});
