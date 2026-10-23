import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_URL } from "../helpers.js";
import { SCIM_IP, type ScimWorld, scim, scimAuth, scimToken } from "./helpers.js";

/*
 * The conformance run of plan 12d Task 12 for RFC 7644 sections 3.1 to 3.14
 * (read 2026-10-22, the copy of plan 12d Task 9b). Each test name begins with
 * its section. There is one test per MUST that 12d serves, and one per
 * refusal of the design's section 9.5.
 *
 * The sections with no test, and the reason for each:
 * - 3.4.2.1: this server serves no query of the server root or of a
 *   resource type list beyond /Users and /Groups. The rules of a query
 *   across many resource types do not apply. tooMany never applies, because
 *   a page holds at most 100 resources.
 * - 3.4.2.3: the sort parameters are refused (sort.supported false), so no
 *   sort order rule applies. The refusal has its test.
 * - 3.7.1 to 3.7.4: Bulk is not served (bulk.supported false). The 501 has
 *   its test under 3.7.
 * - 3.8, the ".scim" suffix: a MAY form that this server does not serve.
 *   The Accept header application/scim+json is a MUST and has its test, as
 *   has the UTF-8 rule.
 * - 3.10: the section defines the attribute notation and has no MUST of its
 *   own. The tests of 3.4.2.2, 3.5.2, and 3.9 use the notation.
 * - 3.11: /Me is not served. The 501 has its test.
 * - 3.12, the scimType tooMany and sensitive: no request of this server
 *   leads to them.
 *
 * Two MUSTs of 3.5.2 that this server did not meet before Task 12 have their
 * tests here: the reset of the other primary values, and the mutability
 * answer to a remove of a required attribute.
 */

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
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

async function world() {
  const w = await scimAuth();
  const { token } = await scimToken(w);
  return { ...w, token };
}
type World = ScimWorld & { token: string };

type Answer = { status: number; headers: Headers; body: Record<string, unknown> };

async function call(
  w: World,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const res = await scim(w, w.token, method, path, body, headers);
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: (text === "" ? null : JSON.parse(text)) as Record<string, unknown>,
  };
}

const patch = (...ops: Record<string, unknown>[]) => ({ schemas: [PATCH_URN], Operations: ops });

function userBody(local: string, extra: Record<string, unknown> = {}) {
  const address = `${local}@acme.example`;
  return {
    schemas: [USER_URN],
    userName: address,
    emails: [{ value: address, type: "work", primary: true }],
    ...extra,
  };
}

async function user(w: World, local: string, extra: Record<string, unknown> = {}) {
  const r = await call(w, "POST", "/Users", userBody(local, extra));
  if (r.status !== 201) throw new Error(`create ${local}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

function expectError(r: Answer, status: number, scimType?: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.schemas).toEqual([ERROR_URN]);
  expect(r.body.status).toBe(String(status));
  expect(r.body.scimType).toBe(scimType);
}

describe("RFC 7644 sections 3.1 to 3.14 (plan 12d Task 12)", () => {
  it("3.1 answers application/scim+json", async () => {
    const w = await world();
    const made = await user(w, "ada");
    const list = await call(w, "GET", "/Users");
    const missing = await call(w, "GET", "/Users/unknown-id");
    for (const r of [made, list, missing])
      expect(r.headers.get("content-type")).toBe("application/scim+json");
  });

  it("3.1 names each message by a URN under urn:ietf:params:scim:api: and lists none in /Schemas", async () => {
    const w = await world();
    const list = await call(w, "GET", "/Users");
    const missing = await call(w, "GET", "/Users/unknown-id");
    expect([list.body.schemas, missing.body.schemas]).toEqual([[LIST_URN], [ERROR_URN]]);
    const schemas = await call(w, "GET", "/Schemas");
    const ids = (schemas.body.Resources as { id: string }[]).map((s) => s.id);
    expect(ids.length).toBe(3);
    expect(ids.some((id) => id.startsWith("urn:ietf:params:scim:api:"))).toBe(false);
  });

  it("3.2 and 3.5.1 refuse a PUT that would create a resource", async () => {
    const w = await world();
    const put = await call(w, "PUT", "/Users/01J0000000000000000000NEW", userBody("ada"));
    expectError(put, 404);
    const list = await call(w, "GET", "/Users");
    expect(list.body.totalResults).toBe(0);
  });

  it("3.3 answers 201 with Location and the resource", async () => {
    const w = await world();
    const r = await user(w, "ada", { displayName: "Ada" });
    const meta = r.body.meta as Record<string, unknown>;
    expect(r.headers.get("location")).toBe(meta.location);
    expect(meta.location).toBe(`${BASE_URL}/auth/scim/v2/Users/${String(r.body.id)}`);
    expect(r.body).toMatchObject({ schemas: [USER_URN], userName: "ada@acme.example" });
  });

  it("3.3 ignores the readOnly attributes of the body", async () => {
    const w = await world();
    const r = await user(w, "ada", {
      id: "client-id",
      meta: { resourceType: "Group", created: "2000-01-01T00:00:00.000Z" },
      groups: [{ value: "g1" }],
    });
    expect(r.body.id).not.toBe("client-id");
    expect(r.body.meta).toMatchObject({ resourceType: "User" });
    expect((r.body.meta as Record<string, unknown>).created).not.toBe("2000-01-01T00:00:00.000Z");
    expect(r.body.groups).toBeUndefined();
  });

  it("3.3 answers 409 uniqueness to a duplicate userName", async () => {
    const w = await world();
    await user(w, "ada");
    const again = await call(w, "POST", "/Users", userBody("ada"));
    expectError(again, 409, "uniqueness");
    const groups = [
      await call(w, "POST", "/Groups", { schemas: [GROUP_URN], displayName: "Eng" }),
      await call(w, "POST", "/Groups", { schemas: [GROUP_URN], displayName: "Eng" }),
    ];
    expect(groups[0]?.status).toBe(201);
    if (groups[1]) expectError(groups[1], 409, "uniqueness");
  });

  it("3.3.1 sets meta.resourceType by the endpoint", async () => {
    const w = await world();
    const u = await user(w, "ada");
    const g = await call(w, "POST", "/Groups", { schemas: [GROUP_URN], displayName: "Eng" });
    expect([
      (u.body.meta as Record<string, unknown>).resourceType,
      (g.body.meta as Record<string, unknown>).resourceType,
    ]).toEqual(["User", "Group"]);
  });

  it("3.4.1 answers meta with resourceType, created, lastModified, location, version", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    const got = await call(w, "GET", `/Users/${id}`);
    expect(got.status).toBe(200);
    const meta = got.body.meta as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(
      ["created", "lastModified", "location", "resourceType", "version"].sort(),
    );
    expect(meta.resourceType).toBe("User");
    expect(meta.created).toBe(w.clock.now().toISOString());
    expect(meta.location).toBe(`${BASE_URL}/auth/scim/v2/Users/${id}`);
    expect(meta.version).toBe('W/"1"');
  });

  it("3.4.2 answers a ListResponse with totalResults, startIndex, itemsPerPage, Resources", async () => {
    const w = await world();
    const a = String((await user(w, "ada")).body.id);
    const b = String((await user(w, "bob")).body.id);
    const list = await call(w, "GET", "/Users");
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      schemas: [LIST_URN],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
    });
    expect((list.body.Resources as { id: string }[]).map((r) => r.id)).toEqual([a, b].sort());
  });

  it("3.4.2 answers 200 and totalResults 0 to a query with no match", async () => {
    const w = await world();
    await user(w, "ada");
    const none = await call(w, "GET", `/Users?filter=${encodeURIComponent('userName eq "x@y.z"')}`);
    expect([none.status, none.body.totalResults, none.body.Resources]).toEqual([200, 0, []]);
  });

  it("3.4.2.2 reads the attribute name and the operator in any case", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    for (const filter of ['userName Eq "ada@acme.example"', 'Username eq "ada@acme.example"']) {
      const r = await call(w, "GET", `/Users?filter=${encodeURIComponent(filter)}`);
      expect(
        [r.status, r.body.totalResults, (r.body.Resources as { id: string }[])[0]?.id],
        filter,
      ).toEqual([200, 1, id]);
    }
  });

  it("3.4.2.2 compares userName with no case, as its caseExact false says", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    const r = await call(
      w,
      "GET",
      `/Users?filter=${encodeURIComponent('userName eq "ADA@ACME.EXAMPLE"')}`,
    );
    expect([r.body.totalResults, (r.body.Resources as { id: string }[])[0]?.id]).toEqual([1, id]);
  });

  it("3.4.2.2 refuses an operator it does not serve with invalidFilter", async () => {
    const w = await world();
    for (const filter of [
      'userName co "ada"',
      'userName regex "a"',
      "userName pr",
      "",
      "id eq 1",
    ]) {
      const r = await call(w, "GET", `/Users?filter=${encodeURIComponent(filter)}`);
      expectError(r, 400, "invalidFilter");
    }
  });

  it("3.4.2.3 refuses sortBy and sortOrder with invalidValue", async () => {
    const w = await world();
    for (const query of ["sortBy=userName", "sortOrder=descending"]) {
      expectError(await call(w, "GET", `/Users?${query}`), 400, "invalidValue");
    }
  });

  it("3.4.2.4 pages by startIndex and count", async () => {
    const w = await world();
    const ids: string[] = [];
    for (const local of ["ada", "bob", "cy"]) ids.push(String((await user(w, local)).body.id));
    ids.sort();
    const page = async (query: string) => {
      const r = await call(w, "GET", `/Users?${query}`);
      expect(r.status, query).toBe(200);
      return {
        totalResults: r.body.totalResults,
        startIndex: r.body.startIndex,
        itemsPerPage: r.body.itemsPerPage,
        ids: (r.body.Resources as { id: string }[]).map((x) => x.id),
      };
    };
    // The server MUST NOT return more results than count.
    expect(await page("startIndex=2&count=1")).toEqual({
      totalResults: 3,
      startIndex: 2,
      itemsPerPage: 1,
      ids: [ids[1]],
    });
    // A startIndex below 1 SHALL be read as 1, and a negative count as 0.
    expect(await page("startIndex=0&count=2")).toEqual({
      totalResults: 3,
      startIndex: 1,
      itemsPerPage: 2,
      ids: ids.slice(0, 2),
    });
    expect(await page("count=-5")).toEqual({
      totalResults: 3,
      startIndex: 1,
      itemsPerPage: 0,
      ids: [],
    });
    // The order stays the same from page to page.
    const first = await page("startIndex=1&count=2");
    const second = await page("startIndex=3&count=2");
    expect([...first.ids, ...second.ids]).toEqual(ids);
    // The last page is short: itemsPerPage counts the resources of the page, not count.
    expect([second.itemsPerPage, second.ids.length]).toEqual([1, 1]);
  });

  it("3.4.3 answers 501 to a search by POST", async () => {
    const w = await world();
    for (const path of ["/.search", "/Users/.search", "/Groups/.search"]) {
      const r = await call(w, "POST", path, {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:SearchRequest"],
      });
      expectError(r, 501);
      expect(r.body.detail).toBe("not supported by this server");
    }
  });

  it("3.5.1 replaces every mutable attribute and keeps the read-only ones", async () => {
    const w = await world();
    const made = await user(w, "ada", { nickName: "A", title: "Engineer", externalId: "e1" });
    const id = String(made.body.id);
    const created = (made.body.meta as Record<string, unknown>).created;
    w.clock.advance(1000);
    const put = await call(
      w,
      "PUT",
      `/Users/${id}`,
      userBody("ada", { id: "other-id", title: "Lead", meta: { created: "2000-01-01" } }),
    );
    expect(put.status).toBe(200);
    // nickName and externalId were not asserted, so the replace takes them away.
    expect([put.body.id, put.body.title, put.body.nickName, put.body.externalId]).toEqual([
      id,
      "Lead",
      undefined,
      undefined,
    ]);
    const meta = put.body.meta as Record<string, unknown>;
    expect([meta.created, meta.version]).toEqual([created, 'W/"2"']);
    expect(meta.lastModified).toBe(w.clock.now().toISOString());
  });

  it("3.5.1 refuses a PUT that leaves out the required userName", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    const put = await call(w, "PUT", `/Users/${id}`, { schemas: [USER_URN], nickName: "A" });
    expectError(put, 400, "invalidValue");
    const got = await call(w, "GET", `/Users/${id}`);
    expect(got.body.userName).toBe("ada@acme.example");
  });

  it("3.5.2 refuses a body that is not a PatchOp message", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    const op = { op: "replace", path: "nickName", value: "A" };
    // The PatchOp URN is a MUST; so are Operations with one or more entries and one op per entry.
    expectError(
      await call(w, "PATCH", `/Users/${id}`, { schemas: [USER_URN], Operations: [op] }),
      400,
      "invalidSyntax",
    );
    expectError(await call(w, "PATCH", `/Users/${id}`, patch()), 400, "invalidValue");
    expectError(
      await call(w, "PATCH", `/Users/${id}`, patch({ path: "nickName", value: "A" })),
      400,
      "invalidSyntax",
    );
  });

  it("3.5.2 applies the operations atomically", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    // The second operation reads, and its value fails the schema after both apply.
    const r = await call(
      w,
      "PATCH",
      `/Users/${id}`,
      patch(
        { op: "replace", path: "nickName", value: "A" },
        { op: "replace", path: "emails", value: "x@acme.example" },
      ),
    );
    expectError(r, 400, "invalidValue");
    const got = await call(w, "GET", `/Users/${id}`);
    expect([got.body.nickName, (got.body.meta as Record<string, unknown>).version]).toEqual([
      undefined,
      'W/"1"',
    ]);
  });

  it("3.5.2 refuses a change of a readOnly attribute with mutability", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    for (const path of ["groups", "id", "meta"]) {
      const r = await call(w, "PATCH", `/Users/${id}`, patch({ op: "replace", path, value: [] }));
      expectError(r, 400, "mutability");
    }
  });

  it("3.5.2 answers 200 with the resource, and 200 to a Group PATCH that names attributes", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    const r = await call(
      w,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "add", path: "title", value: "T" }),
    );
    expect([r.status, r.body.id, r.body.title]).toEqual([200, id, "T"]);
    const g = await call(w, "POST", "/Groups", { schemas: [GROUP_URN], displayName: "Eng" });
    const gid = String(g.body.id);
    const rename = patch({ op: "replace", path: "displayName", value: "Ops" });
    // With no attributes parameter the server MAY answer 204.
    expect((await call(w, "PATCH", `/Groups/${gid}`, rename)).status).toBe(204);
    const named = await call(
      w,
      "PATCH",
      `/Groups/${gid}?attributes=displayName`,
      patch({ op: "replace", path: "displayName", value: "Eng" }),
    );
    expect([named.status, named.body.id, named.body.displayName]).toEqual([200, gid, "Eng"]);
  });

  it("3.5.2 sets primary false on the other values when a PATCH sets one primary", async () => {
    const w = await world();
    const id = String(
      (
        await user(w, "ada", {
          emails: [
            { value: "ada@acme.example", type: "work", primary: true },
            { value: "ada.home@acme.example", type: "home" },
          ],
        })
      ).body.id,
    );
    const r = await call(
      w,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "replace", path: 'emails[type eq "home"].primary', value: true }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const emails = r.body.emails as { value: string; primary?: boolean }[];
    expect(emails.map((e) => [e.value, e.primary === true])).toEqual([
      ["ada@acme.example", false],
      ["ada.home@acme.example", true],
    ]);
    const added = await call(
      w,
      "PATCH",
      `/Users/${id}`,
      patch({
        op: "add",
        path: "phoneNumbers",
        value: [
          { value: "+1 555 0100", type: "work", primary: true },
          { value: "+1 555 0101", type: "mobile" },
        ],
      }),
      {},
    );
    expect(added.status).toBe(200);
    const again = await call(
      w,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "add", path: "phoneNumbers", value: [{ value: "+1 555 0102", primary: true }] }),
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const phones = again.body.phoneNumbers as { value: string; primary?: boolean }[];
    expect(phones.filter((p) => p.primary === true).map((p) => p.value)).toEqual(["+1 555 0102"]);
    // A request that itself sends two primary values is refused, and writes nothing.
    const two = await call(
      w,
      "PATCH",
      `/Users/${id}`,
      patch({
        op: "add",
        path: "phoneNumbers",
        value: [
          { value: "+1 555 0103", primary: true },
          { value: "+1 555 0104", primary: true },
        ],
      }),
    );
    expectError(two, 400, "invalidValue");
    const kept = await call(w, "GET", `/Users/${id}`);
    expect((kept.body.phoneNumbers as unknown[]).length).toBe(3);
  });

  it("3.5.2.1 refuses an add with no value", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    expectError(
      await call(w, "PATCH", `/Users/${id}`, patch({ op: "add", path: "title" })),
      400,
      "invalidValue",
    );
  });

  it("3.5.2.2 refuses a remove with no path with noTarget", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    expectError(
      await call(w, "PATCH", `/Users/${id}`, patch({ op: "remove", value: { title: "T" } })),
      400,
      "noTarget",
    );
  });

  it("3.5.2.2 refuses the remove of a required attribute with mutability", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    expectError(
      await call(w, "PATCH", `/Users/${id}`, patch({ op: "remove", path: "userName" })),
      400,
      "mutability",
    );
    const g = await call(w, "POST", "/Groups", { schemas: [GROUP_URN], displayName: "Eng" });
    expectError(
      await call(
        w,
        "PATCH",
        `/Groups/${String(g.body.id)}`,
        patch({ op: "remove", path: "displayName" }),
      ),
      400,
      "mutability",
    );
    // A replace with a bad value keeps invalidValue.
    expectError(
      await call(w, "PATCH", `/Users/${id}`, patch({ op: "replace", path: "userName", value: "" })),
      400,
      "invalidValue",
    );
    expectError(
      await call(
        w,
        "PATCH",
        `/Groups/${String(g.body.id)}`,
        patch({ op: "replace", path: "displayName", value: "" }),
      ),
      400,
      "invalidValue",
    );
  });

  it("3.5.2.2 refuses a replace that sets a required attribute to null with mutability", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    // A null value makes the attribute unassigned, by path or by the no-path form.
    for (const op of [
      { op: "replace", path: "userName", value: null },
      { op: "replace", value: { userName: null } },
    ])
      expectError(await call(w, "PATCH", `/Users/${id}`, patch(op)), 400, "mutability");
    const got = await call(w, "GET", `/Users/${id}`);
    expect(got.body.userName).toBe("ada@acme.example");
    const g = await call(w, "POST", "/Groups", { schemas: [GROUP_URN], displayName: "Eng" });
    const gid = String(g.body.id);
    for (const op of [
      { op: "replace", path: "displayName", value: null },
      { op: "replace", value: { displayName: null } },
    ])
      expectError(await call(w, "PATCH", `/Groups/${gid}`, patch(op)), 400, "mutability");
    expect((await call(w, "GET", `/Groups/${gid}`)).body.displayName).toBe("Eng");
    // A bad value that is not null keeps invalidValue.
    expectError(
      await call(w, "PATCH", `/Users/${id}`, patch({ op: "replace", value: { userName: 7 } })),
      400,
      "invalidValue",
    );
  });

  it("3.5.2 refuses a path with an index and a move with invalidPath", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    for (const op of [
      { op: "replace", path: "emails[0].value", value: "x@acme.example" },
      { op: "move", path: "title", value: "T" },
    ])
      expectError(await call(w, "PATCH", `/Users/${id}`, patch(op)), 400, "invalidPath");
  });

  it("3.6 answers 204 and then 404", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    const del = await scim(w, w.token, "DELETE", `/Users/${id}`);
    expect([del.status, await del.text()]).toEqual([204, ""]);
    // 404 for every operation on the deleted resource, and no row in a query.
    expectError(await call(w, "GET", `/Users/${id}`), 404);
    expectError(await call(w, "PUT", `/Users/${id}`, userBody("ada")), 404);
    expectError(
      await call(w, "PATCH", `/Users/${id}`, patch({ op: "add", path: "title", value: "T" })),
      404,
    );
    expectError(await call(w, "DELETE", `/Users/${id}`), 404);
    const list = await call(w, "GET", "/Users");
    expect(list.body.totalResults).toBe(0);
  });

  it("3.7 answers 501 to Bulk with bulk.supported false", async () => {
    const w = await world();
    const bulk = await call(w, "POST", "/Bulk", {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:BulkRequest"],
      Operations: [],
    });
    expectError(bulk, 501);
    const config = await call(w, "GET", "/ServiceProviderConfig");
    expect(config.body.bulk).toEqual({ supported: false, maxOperations: 0, maxPayloadSize: 0 });
  });

  it("3.8 answers application/scim+json to Accept: application/scim+json", async () => {
    const w = await world();
    const accept = { accept: "application/scim+json" };
    const made = await call(w, "POST", "/Users", userBody("ada"), accept);
    const got = await call(w, "GET", `/Users/${String(made.body.id)}`, undefined, accept);
    const missing = await call(w, "GET", "/Users/unknown-id", undefined, accept);
    expect([made.status, got.status, missing.status]).toEqual([201, 200, 404]);
    for (const r of [made, got, missing])
      expect(r.headers.get("content-type")).toBe("application/scim+json");
    expect(got.body.userName).toBe("ada@acme.example");
  });

  it("3.8 reads and answers JSON in UTF-8", async () => {
    const w = await world();
    const name = { givenName: "Zoë", familyName: "Ünal 山田" };
    const made = await call(w, "POST", "/Users", userBody("zoe", { name }), {
      "content-type": "application/scim+json; charset=utf-8",
    });
    expect(made.status).toBe(201);
    const got = await call(w, "GET", `/Users/${String(made.body.id)}`);
    expect(got.body.name).toEqual(name);
  });

  it("3.9 returns id and schemas with any attributes list", async () => {
    const w = await world();
    const id = String((await user(w, "ada", { title: "T" })).body.id);
    const only = await call(w, "GET", `/Users/${id}?attributes=title`);
    expect(Object.keys(only.body).sort()).toEqual(["id", "meta", "schemas", "title"]);
    // excludedAttributes has no effect on an attribute that is returned always.
    const less = await call(w, "GET", `/Users/${id}?excludedAttributes=id,schemas,title`);
    expect([less.body.id, less.body.schemas, less.body.title]).toEqual([id, [USER_URN], undefined]);
    const list = await call(w, "GET", "/Users?attributes=userName");
    expect(Object.keys((list.body.Resources as Record<string, unknown>[])[0] ?? {}).sort()).toEqual(
      ["id", "meta", "schemas", "userName"],
    );
  });

  it("3.11 answers 501 to /Me", async () => {
    const w = await world();
    expectError(await call(w, "GET", "/Me"), 501);
  });

  it("3.12 answers the Error schema with status as a string", async () => {
    const w = await world();
    const r = await call(w, "GET", "/Users/unknown-id");
    expect(r.body).toEqual({
      schemas: [ERROR_URN],
      status: "404",
      detail: "no User of this organization has the id",
    });
    expect(typeof r.body.status).toBe("string");
    // The route errors come from a second builder: the 501 of /Me is one.
    const me = await call(w, "GET", "/Me");
    expect(me.body).toEqual({
      schemas: [ERROR_URN],
      status: "501",
      detail: "not supported by this server",
    });
  });

  it("3.12 answers 413 to a body above 1 MB", async () => {
    const w = await world();
    const big = JSON.stringify(userBody("ada", { title: "x".repeat(1_048_577) }));
    expectError(await call(w, "POST", "/Users", big), 413);
  });

  it("3.12 refuses a schemas URN that the server does not serve with invalidSyntax", async () => {
    const w = await world();
    const r = await call(w, "POST", "/Users", {
      ...userBody("ada"),
      schemas: [USER_URN, "urn:ietf:params:scim:schemas:extension:CustomExtensionName:2.0:User"],
    });
    expectError(r, 400, "invalidSyntax");
  });

  it("3.12 refuses a password change with invalidValue", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    const r = await call(
      w,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "replace", path: "password", value: "s3cret" }),
    );
    expectError(r, 400, "invalidValue");
    const config = await call(w, "GET", "/ServiceProviderConfig");
    expect(config.body.changePassword).toEqual({ supported: false });
  });

  it("3.13 serves the version v2 in the path and refuses another", async () => {
    const w = await world();
    const v2 = await call(w, "GET", "/Users");
    expect(v2.status).toBe(200);
    const v1 = await w.handle(
      new Request(`${BASE_URL}/auth/scim/v1/Users`, {
        headers: { authorization: `Bearer ${w.token}`, "cf-connecting-ip": SCIM_IP },
      }),
    );
    expect(v1.status).toBe(404);
  });

  it("3.14 answers the version in the ETag header and in meta.version", async () => {
    const w = await world();
    const made = await user(w, "ada");
    const id = String(made.body.id);
    expect(made.headers.get("etag")).toBe('W/"1"');
    const r = await call(
      w,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "add", path: "title", value: "T" }),
    );
    expect([r.headers.get("etag"), (r.body.meta as Record<string, unknown>).version]).toEqual([
      'W/"2"',
      'W/"2"',
    ]);
  });

  it("3.14 answers 412 to a stale If-Match", async () => {
    const w = await world();
    const id = String((await user(w, "ada")).body.id);
    const set = (title: string) => patch({ op: "replace", path: "title", value: title });
    const fresh = await call(w, "PATCH", `/Users/${id}`, set("A"), { "if-match": 'W/"1"' });
    expect(fresh.status).toBe(200);
    const stale = await call(w, "PATCH", `/Users/${id}`, set("B"), { "if-match": 'W/"1"' });
    expectError(stale, 412);
    const got = await call(w, "GET", `/Users/${id}`);
    expect(got.body.title).toBe("A");
  });
});
