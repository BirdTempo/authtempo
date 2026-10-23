import { describe, expect, it } from "vitest";
import { parsePatch } from "../../src/engine/scim/patch.js";
import { applyPatch } from "../../src/engine/scim/users.js";

const URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

function body(...operations: unknown[]) {
  return { schemas: [URN], Operations: operations };
}

function at(
  attr: string,
  sub: string | null = null,
  filter: { attr: string; value: string } | null = null,
) {
  return { attr, sub, filter };
}

describe("parsePatch (plan 12d Task 10, RFC 7644 section 3.5.2)", () => {
  it("reads each path form and each provider quirk", () => {
    const rows: [string, unknown, "User" | "Group", unknown[]][] = [
      [
        "a capital op (Entra ID)",
        body({ op: "Replace", path: "displayName", value: "A" }),
        "User",
        [{ op: "replace", path: at("displayName"), value: "A" }],
      ],
      [
        "each op in any case",
        body({ op: "ADD", path: "title", value: "t" }, { op: "remove", path: "title" }),
        "User",
        [
          { op: "add", path: at("title"), value: "t" },
          { op: "remove", path: at("title"), value: null },
        ],
      ],
      [
        "the no-path form, one operation per key (Entra ID)",
        body({
          op: "Replace",
          value: { active: "False", displayName: "A", "name.givenName": "G" },
        }),
        "User",
        [
          { op: "replace", path: at("active"), value: false },
          { op: "replace", path: at("displayName"), value: "A" },
          { op: "replace", path: at("name", "givenName"), value: "G" },
        ],
      ],
      [
        'the strings "False" and "True" of a boolean (Entra ID)',
        body(
          { op: "replace", path: "active", value: "False" },
          { op: "replace", path: "active", value: "True" },
          { op: "replace", path: "active", value: false },
          { op: "replace", path: "active", value: true },
          { op: "replace", path: 'emails[type eq "work"].primary', value: "True" },
          { op: "remove", path: "active" },
        ),
        "User",
        [
          { op: "replace", path: at("active"), value: false },
          { op: "replace", path: at("active"), value: true },
          { op: "replace", path: at("active"), value: false },
          { op: "replace", path: at("active"), value: true },
          {
            op: "replace",
            path: at("emails", "primary", { attr: "type", value: "work" }),
            value: true,
          },
          { op: "remove", path: at("active"), value: null },
        ],
      ],
      [
        "name.givenName",
        body({ op: "replace", path: "name.givenName", value: "G" }),
        "User",
        [{ op: "replace", path: at("name", "givenName"), value: "G" }],
      ],
      [
        "an attribute of the enterprise URN",
        body(
          { op: "replace", path: `${ENTERPRISE}:department`, value: "Eng" },
          {
            op: "add",
            path: "URN:IETF:params:scim:schemas:extension:enterprise:2.0:user:Manager",
            value: "m1",
          },
        ),
        "User",
        [
          { op: "replace", path: at(`${ENTERPRISE}:department`), value: "Eng" },
          { op: "add", path: at(`${ENTERPRISE}:manager`), value: "m1" },
        ],
      ],
      [
        'emails[type eq "work"].value',
        body({ op: "replace", path: 'emails[type eq "work"].value', value: "a@acme.example" }),
        "User",
        [
          {
            op: "replace",
            path: at("emails", "value", { attr: "type", value: "work" }),
            value: "a@acme.example",
          },
        ],
      ],
      [
        "a filter with no sub-attribute, and names in any case",
        body(
          { op: "remove", path: 'PhoneNumbers[TYPE Eq "fax"]' },
          { op: "add", path: "Name.FamilyName", value: "F" },
        ),
        "User",
        [
          {
            op: "remove",
            path: at("phoneNumbers", null, { attr: "type", value: "fax" }),
            value: null,
          },
          { op: "add", path: at("name", "familyName"), value: "F" },
        ],
      ],
      [
        "a complex value",
        body({
          op: "add",
          path: "emails",
          value: [{ value: "a@acme.example", type: "work", primary: true }],
        }),
        "User",
        [
          {
            op: "add",
            path: at("emails"),
            value: [{ value: "a@acme.example", type: "work", primary: true }],
          },
        ],
      ],
      [
        "the member forms of a Group (Entra ID and Okta)",
        body(
          { op: "Add", path: "members", value: [{ value: "u1" }] },
          { op: "Remove", path: "members", value: [{ value: "u2" }] },
          { op: "remove", path: 'members[value eq "u3"]' },
          { op: "replace", path: "displayName", value: "Eng" },
          { op: "replace", value: { externalId: "g1" } },
        ),
        "Group",
        [
          { op: "add", path: at("members"), value: [{ value: "u1" }] },
          { op: "remove", path: at("members"), value: [{ value: "u2" }] },
          { op: "remove", path: at("members", null, { attr: "value", value: "u3" }), value: null },
          { op: "replace", path: at("displayName"), value: "Eng" },
          { op: "replace", path: at("externalId"), value: "g1" },
        ],
      ],
      [
        "100 operations",
        body(...Array.from({ length: 100 }, () => ({ op: "replace", path: "title", value: "t" }))),
        "User",
        Array.from({ length: 100 }, () => ({ op: "replace", path: at("title"), value: "t" })),
      ],
      [
        "a path of 256 characters",
        body({ op: "replace", path: `emails[type eq "${"w".repeat(232)}"].value`, value: "t" }),
        "User",
        [
          {
            op: "replace",
            path: at("emails", "value", { attr: "type", value: "w".repeat(232) }),
            value: "t",
          },
        ],
      ],
      [
        "a value three levels deep",
        body({ op: "replace", value: { members: [{ value: "u1" }] } }),
        "Group",
        [{ op: "replace", path: at("members"), value: [{ value: "u1" }] }],
      ],
    ];
    for (const [name, input, resource, ops] of rows) {
      expect(parsePatch(input, resource), name).toEqual({ ok: true, ops, id: null });
    }
  });

  it("ignores an unknown key of the no-path form of a User, as POST and PUT do (ruling 50)", () => {
    // Entra ID sends the attributes of its own map in this form.
    const input = body({
      op: "Replace",
      value: {
        shoeSize: 1,
        "urn:ietf:params:scim:schemas:extension:CustomExtensionName:2.0:User:badge": "b",
        [`${ENTERPRISE}:badge`]: "b",
        title: "t",
        [`${ENTERPRISE}:department`]: "d",
      },
    });
    expect(parsePatch(input, "User")).toEqual({
      ok: true,
      ops: [
        { op: "replace", path: at("title"), value: "t" },
        { op: "replace", path: at(`${ENTERPRISE}:department`), value: "d" },
      ],
      id: null,
    });
    // A key of a known attribute keeps the path rules.
    expect(parsePatch(body({ op: "add", value: { "nickName.first": "n" } }), "User")).toMatchObject(
      {
        ok: false,
        scimType: "invalidPath",
      },
    );
    // A value of unknown keys alone gives no operation.
    expect(parsePatch(body({ op: "add", value: { shoeSize: 1 } }), "User")).toEqual({
      ok: true,
      ops: [],
      id: null,
    });
  });

  it("takes the id out of the no-path form and ignores meta and groups (Okta)", () => {
    const rows: [string, unknown, "User" | "Group", unknown[], string | null][] = [
      [
        "the Okta group rename",
        body({
          op: "replace",
          value: { id: "abf4dd94-a4c0-4f67-89c9-76b03340cb9b", displayName: "Test SCIMv2" },
        }),
        "Group",
        [{ op: "replace", path: at("displayName"), value: "Test SCIMv2" }],
        "abf4dd94-a4c0-4f67-89c9-76b03340cb9b",
      ],
      [
        "a no-path value with meta and groups",
        body({
          op: "replace",
          value: {
            id: "u1",
            meta: { resourceType: "User" },
            groups: [{ value: "g1" }],
            displayName: "A",
          },
        }),
        "User",
        [{ op: "replace", path: at("displayName"), value: "A" }],
        "u1",
      ],
      [
        "an id that differs from the target goes to the caller",
        body({ op: "replace", value: { ID: "other", displayName: "Eng" } }),
        "Group",
        [{ op: "replace", path: at("displayName"), value: "Eng" }],
        "other",
      ],
      [
        "the same id in two operations",
        body(
          { op: "replace", value: { id: "g1", displayName: "Eng" } },
          { op: "add", value: { id: "g1", externalId: "e1" } },
        ),
        "Group",
        [
          { op: "replace", path: at("displayName"), value: "Eng" },
          { op: "add", path: at("externalId"), value: "e1" },
        ],
        "g1",
      ],
      [
        "the meta of a Group alone",
        body({ op: "replace", value: { meta: {} } }),
        "Group",
        [],
        null,
      ],
    ];
    for (const [name, input, resource, ops, id] of rows) {
      expect(parsePatch(input, resource), name).toEqual({ ok: true, ops, id });
    }
  });

  it("refuses an index, a move, and 101 operations", () => {
    const deep = { op: "replace", value: { members: [{ value: ["u1"] }] } };
    // 101 distinct keys of one no-path value, each a valid path.
    const keys101 = Object.fromEntries(
      Array.from({ length: 101 }, (_, n) => [`emails[type eq "${n}"].value`, "a"]),
    );
    const rows: [string, unknown, "User" | "Group", string, number][] = [
      [
        "an index",
        body({ op: "replace", path: "emails[0]", value: "a" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "an index with a sub",
        body({ op: "replace", path: "emails[0].value", value: "a" }),
        "User",
        "invalidPath",
        400,
      ],
      ["a move", body({ op: "move", path: "title", value: "t" }), "User", "invalidPath", 400],
      [
        "a copy in any case",
        body({ op: "Copy", path: "title", value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "101 operations",
        body(...Array.from({ length: 101 }, () => ({ op: "replace", path: "title", value: "t" }))),
        "User",
        "invalidValue",
        400,
      ],
      ["no operation", body(), "User", "invalidValue", 400],
      [
        "Operations that is not a list",
        { schemas: [URN], Operations: { op: "add" } },
        "User",
        "invalidSyntax",
        400,
      ],
      ["no Operations", { schemas: [URN] }, "User", "invalidSyntax", 400],
      ["a null Operations", { schemas: [URN], Operations: null }, "Group", "invalidSyntax", 400],
      [
        "more than 100 operations from the no-path form",
        body(...Array.from({ length: 99 }, () => ({ op: "replace", path: "title", value: "t" })), {
          op: "replace",
          value: { title: "t", nickName: "n" },
        }),
        "User",
        "invalidValue",
        400,
      ],
      [
        "more than 100 operations from paths after the no-path form",
        body(
          {
            op: "replace",
            value: Object.fromEntries(
              Array.from({ length: 99 }, (_, n) => [`emails[type eq "${n}"].value`, "a"]),
            ),
          },
          { op: "replace", path: "title", value: "t" },
          { op: "replace", path: "nickName", value: "n" },
        ),
        "User",
        "invalidValue",
        400,
      ],
      [
        "one operation with 101 keys",
        body({ op: "replace", value: keys101 }),
        "User",
        "invalidValue",
        400,
      ],
      [
        // The schemas key after the bound would answer mutability, so this
        // row shows that the parser stops at operation 101 (review l1).
        "one operation with 101 keys and then a read-only key",
        body({ op: "replace", value: { ...keys101, schemas: [] } }),
        "User",
        "invalidValue",
        400,
      ],
      ["a body that is not an object", [URN], "User", "invalidSyntax", 400],
      ["a null body", null, "User", "invalidSyntax", 400],
      [
        "another schema URN",
        { schemas: ["urn:example:patch"], Operations: [] },
        "User",
        "invalidSyntax",
        400,
      ],
      [
        "a second schema URN",
        { schemas: [URN, URN], Operations: [] },
        "User",
        "invalidSyntax",
        400,
      ],
      [
        "a schemas text in place of a list",
        { schemas: URN, Operations: [] },
        "User",
        "invalidSyntax",
        400,
      ],
      [
        "another key of the body",
        { ...body({ op: "add", path: "title", value: "t" }), id: "x" },
        "User",
        "invalidSyntax",
        400,
      ],
      ["an operation that is not an object", body("replace"), "User", "invalidSyntax", 400],
      ["a null operation", body(null), "User", "invalidSyntax", 400],
      ["a number operation", body(5), "Group", "invalidSyntax", 400],
      [
        "an array-like schemas object",
        { schemas: { 0: URN, length: 1 }, Operations: [{ op: "add", path: "title", value: "t" }] },
        "User",
        "invalidSyntax",
        400,
      ],
      [
        "another key of an operation",
        body({ op: "add", path: "title", value: "t", from: "x" }),
        "User",
        "invalidSyntax",
        400,
      ],
      [
        "an unknown op",
        body({ op: "test", path: "title", value: "t" }),
        "User",
        "invalidSyntax",
        400,
      ],
      [
        "an op that is not a text",
        body({ op: 1, path: "title", value: "t" }),
        "User",
        "invalidSyntax",
        400,
      ],
      [
        "an unknown attribute",
        body({ op: "replace", path: "shoeSize", value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "an unknown sub-attribute",
        body({ op: "replace", path: "name.nick", value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a sub-attribute of a simple attribute",
        body({ op: "replace", path: "title.value", value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a second sub-attribute",
        body({ op: "replace", path: "name.givenName.x", value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "another filter attribute",
        body({ op: "replace", path: 'emails[value eq "a"].type', value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "another filter operator",
        body({ op: "replace", path: 'emails[type ne "work"].value', value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a filter value that is not a text",
        body({ op: "replace", path: "emails[type eq work].value", value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a NUL in a path filter",
        body({ op: "replace", path: 'emails[type eq "\\u0000"].value', value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a CR LF in a path filter",
        body({ op: "remove", path: 'emails[type eq "a\\r\\nb"]' }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a lone surrogate in a path filter",
        body({ op: "remove", path: 'members[value eq "\\ud800"]' }),
        "Group",
        "invalidPath",
        400,
      ],
      [
        "a filter with no close",
        body({ op: "replace", path: 'emails[type eq "work".value', value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a filter with a second clause",
        body({ op: "remove", path: 'emails[type eq "a" or type eq "b"]' }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a filter on a simple attribute",
        body({ op: "replace", path: 'title[type eq "a"]', value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a filter on a single complex attribute",
        body({ op: "replace", path: 'name[type eq "a"]', value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "text after the filter",
        body({ op: "remove", path: 'emails[type eq "work"]x' }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a sign in place of the close of the filter",
        body({ op: "replace", path: 'emails[type eq "work"x.value', value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a sign in place of the dot after the filter",
        body({ op: "replace", path: 'emails[type eq "work"]xvalue', value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "the member filter on a User",
        body({ op: "remove", path: 'emails[value eq "a"]' }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a type filter on members",
        body({ op: "remove", path: 'members[type eq "User"]' }),
        "Group",
        "invalidPath",
        400,
      ],
      [
        "a sub after the member filter",
        body({ op: "replace", path: 'members[value eq "u"].display', value: "d" }),
        "Group",
        "invalidPath",
        400,
      ],
      [
        "a User attribute on a Group",
        body({ op: "replace", path: "userName", value: "u" }),
        "Group",
        "invalidPath",
        400,
      ],
      [
        "the enterprise URN on a Group",
        body({ op: "replace", path: `${ENTERPRISE}:department`, value: "d" }),
        "Group",
        "invalidPath",
        400,
      ],
      [
        "an unknown enterprise attribute",
        body({ op: "replace", path: `${ENTERPRISE}:shoeSize`, value: "d" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a sub of an enterprise attribute",
        body({ op: "replace", path: `${ENTERPRISE}:manager.value`, value: "m" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "the enterprise URN alone",
        body({ op: "replace", path: ENTERPRISE, value: { department: "d" } }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "the core URN as a prefix",
        body({
          op: "replace",
          path: "urn:ietf:params:scim:schemas:core:2.0:User:title",
          value: "t",
        }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a name of the object prototype",
        body({ op: "replace", path: "__proto__", value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "constructor",
        body({ op: "replace", path: "constructor", value: "t" }),
        "Group",
        "invalidPath",
        400,
      ],
      [
        "a sign that lowercases to an ASCII letter",
        body({ op: "replace", path: "nicKname", value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      ["an empty path", body({ op: "replace", path: "", value: "t" }), "User", "invalidPath", 400],
      [
        "a path that is not a text",
        body({ op: "replace", path: 1, value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      ["a null path", body({ op: "replace", path: null, value: "t" }), "User", "invalidPath", 400],
      [
        "a path of 257 characters",
        body({ op: "replace", path: `emails[type eq "${"w".repeat(233)}"].value`, value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a path over 256 characters",
        body({ op: "replace", path: `emails[type eq "${"w".repeat(240)}"].value`, value: "t" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        // A User ignores such a key (ruling 50 of plan 12d); a Group keeps the refusal.
        "an unknown key of the no-path form of a Group",
        body({ op: "replace", value: { displayName: "t", shoeSize: 1 } }),
        "Group",
        "invalidPath",
        400,
      ],
      [
        "an explicit path to an unknown attribute (Behavior 8)",
        body({ op: "replace", path: "shoeSize", value: 1 }),
        "User",
        "invalidPath",
        400,
      ],
      [
        // The URN alone is the known extension, not an unknown key, so it keeps the refusal.
        "the enterprise URN alone as a key of the no-path form",
        body({ op: "replace", value: { [ENTERPRISE]: { department: "d" } } }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "an explicit path to an unknown attribute of the enterprise extension",
        body({ op: "replace", path: `${ENTERPRISE}:badge`, value: "b" }),
        "User",
        "invalidPath",
        400,
      ],
      [
        "a password path",
        body({ op: "replace", path: "password", value: "p" }),
        "User",
        "invalidValue",
        400,
      ],
      [
        "a password in the no-path form",
        body({ op: "replace", value: { Password: "p" } }),
        "User",
        "invalidValue",
        400,
      ],
      [
        "a read-only attribute",
        body({ op: "replace", path: "groups", value: [] }),
        "User",
        "mutability",
        400,
      ],
      ["the id", body({ op: "replace", path: "id", value: "x" }), "User", "mutability", 400],
      [
        "a meta path of a Group",
        body({ op: "replace", path: "meta", value: {} }),
        "Group",
        "mutability",
        400,
      ],
      [
        "a schemas path",
        body({ op: "replace", path: "schemas", value: [] }),
        "User",
        "mutability",
        400,
      ],
      ["a meta path", body({ op: "remove", path: "meta" }), "User", "mutability", 400],
      [
        "schemas in the no-path form",
        body({ op: "replace", value: { schemas: [], title: "t" } }),
        "User",
        "mutability",
        400,
      ],
      [
        "an id that is not a text in the no-path form",
        body({ op: "replace", value: { id: 5, displayName: "Eng" } }),
        "Group",
        "mutability",
        400,
      ],
      [
        "two ids in the no-path form",
        body(
          { op: "replace", value: { id: "g1", displayName: "Eng" } },
          { op: "replace", value: { id: "g2" } },
        ),
        "Group",
        "mutability",
        400,
      ],
      [
        "groups in the no-path form of a Group",
        body({ op: "replace", value: { groups: [] } }),
        "Group",
        "invalidPath",
        400,
      ],
      [
        "a remove with no path",
        body({ op: "remove", value: { title: "t" } }),
        "User",
        "noTarget",
        400,
      ],
      ["an add with no value", body({ op: "add", path: "title" }), "User", "invalidValue", 400],
      [
        "a no-path value that is not an object",
        body({ op: "replace", value: "t" }),
        "User",
        "invalidValue",
        400,
      ],
      [
        "a no-path value that is a list",
        body({ op: "replace", value: [{ title: "t" }] }),
        "User",
        "invalidValue",
        400,
      ],
      ["an empty no-path value", body({ op: "replace", value: {} }), "User", "invalidValue", 400],
      [
        "another text of a boolean",
        body({ op: "replace", path: "active", value: "false" }),
        "User",
        "invalidValue",
        400,
      ],
      [
        "a number of a boolean",
        body({ op: "replace", path: "active", value: 0 }),
        "User",
        "invalidValue",
        400,
      ],
      [
        "another text of a boolean sub",
        body({ op: "replace", path: 'emails[type eq "w"].primary', value: "yes" }),
        "User",
        "invalidValue",
        400,
      ],
      ["a value four levels deep", body(deep), "Group", "invalidValue", 400],
    ];
    for (const [name, input, resource, scimType, status] of rows) {
      const r = parsePatch(input, resource);
      expect(r.ok, name).toBe(false);
      if (!r.ok) {
        expect([r.status, r.scimType], name).toEqual([status, scimType]);
        expect(r.detail.length, name).toBeGreaterThan(0);
      }
    }
  });
});

describe("applyPatch (plan 12d Task 12, ruling 67)", () => {
  // A core rule applies only to a key of the core User (users.ts, the guard
  // container === doc). No enterprise attribute of RFC 7643 section 4.3 has
  // the name of a core attribute today, so the parser cannot send one. The
  // test calls applyPatch directly, so a later enterprise attribute with such
  // a name cannot take the required or multi-valued rule of the core one.
  it("keeps the rules of the core User off a key of the enterprise extension", () => {
    const resource = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", ENTERPRISE],
      userName: "ada@acme.example",
      [ENTERPRISE]: { userName: "ext", emails: "ext" },
    };
    const result = applyPatch(resource, [
      { op: "remove", path: at(`${ENTERPRISE}:userName`), value: null },
      { op: "add", path: at(`${ENTERPRISE}:emails`), value: "next" },
    ]);
    expect(result).toEqual({
      ok: true,
      value: { ...resource, [ENTERPRISE]: { emails: "next" } },
    });
  });
});
