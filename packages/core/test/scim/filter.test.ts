import { describe, expect, it } from "vitest";
import { parseScimFilter } from "../../src/engine/scim/filter.js";

describe("parseScimFilter (plan 12d Task 9, RFC 7644 section 3.4.2.2)", () => {
  it("reads the subset of the grammar", () => {
    const rows = [
      ['userName eq "a@acme.example"', "User", { attr: "userName", value: "a@acme.example" }],
      ['USERNAME EQ "x"', "User", { attr: "userName", value: "x" }],
      ['externalId eq "e1"', "User", { attr: "externalId", value: "e1" }],
      [
        'emails.value eq "a@acme.example"',
        "User",
        { attr: "emails.value", value: "a@acme.example" },
      ],
      [
        'id eq "01JABCDEFGHJKMNPQRSTVWXYZ0"',
        "User",
        { attr: "id", value: "01JABCDEFGHJKMNPQRSTVWXYZ0" },
      ],
      ['userName eq "a \\"b\\" \\u0063"', "User", { attr: "userName", value: 'a "b" c' }],
      ['userName eq ""', "User", { attr: "userName", value: "" }],
      ['displayName eq "Eng"', "Group", { attr: "displayName", value: "Eng" }],
      ['externalId eq "g1"', "Group", { attr: "externalId", value: "g1" }],
      ['id eq "g"', "Group", { attr: "id", value: "g" }],
      ['id eq "g" and members[value eq "u"]', "Group", { attr: "id", value: "g", member: "u" }],
      ['ID Eq "g" AND Members[Value eQ "u"]', "Group", { attr: "id", value: "g", member: "u" }],
      [`userName eq "${"a".repeat(1010)}"`, "User", { attr: "userName", value: "a".repeat(1010) }],
      [
        'userName eq "\\ud83d\\ude00 \\u00e9"',
        "User",
        { attr: "userName", value: "\u{1f600} \u00e9" },
      ],
    ] as const;
    for (const [text, resource, expected] of rows) {
      expect(parseScimFilter(text, resource), text).toEqual(expected);
    }
  });

  it("refuses every other filter with invalidFilter", () => {
    const rows = [
      ['userName co "a"', "User"],
      ['userName sw "a"', "User"],
      ["userName eq a", "User"],
      ['userName eq "a" or id eq "b"', "User"],
      ['userName eq "a" and id eq "b"', "User"],
      ['not (id eq "a")', "User"],
      ['meta.lastModified gt "2026-01-01"', "User"],
      ["userName eq 1", "User"],
      ["userName eq true", "User"],
      ["userName eq null", "User"],
      ["", "User"],
      ["userName", "User"],
      ['userName  eq "a"', "User"],
      ['userName eq  "a"', "User"],
      [' userName eq "a"', "User"],
      ['userName eq "a" ', "User"],
      ['userName eq "a', "User"],
      ['userName eq "a\\', "User"],
      ['userName eq "a\\q"', "User"],
      ['userName eq "a"b"', "User"],
      ['userName eq "tab\there"', "User"],
      ["userName pr", "User"],
      ['displayName eq "a"', "User"],
      ['emails[type eq "work"].value eq "a"', "User"],
      ['urn:ietf:params:scim:schemas:core:2.0:User:userName eq "a"', "User"],
      ['userName eq "a"', "Group"],
      ['emails.value eq "a"', "Group"],
      ['__proto__ eq "a"', "User"],
      ['constructor eq "a"', "Group"],
      ['id eq "g" and members[value eq "u"]', "User"],
      ['externalId eq "g" and members[value eq "u"]', "Group"],
      ['id eq "g" and members[value eq "u"] ', "Group"],
      ['id eq "g" and members[value eq "u"', "Group"],
      ['id eq "g" and members[display eq "u"]', "Group"],
      ['id eq "g" and members[value co "u"]', "Group"],
      ['id eq "g" and members[value eq u]', "Group"],
      ['id eq "g"  and members[value eq "u"]', "Group"],
      ['id eq "g" or members[value eq "u"]', "Group"],
      ['id eq "g" xor members[value eq "u"]', "Group"],
      ['id eq "g" and memberz[value eq "u"]', "Group"],
      ['id eq "g" and members[value eq "u"] and members[value eq "v"]', "Group"],
      [`userName eq "${"a".repeat(1011)}"`, "User"],
      // An escape gives a control character or a lone surrogate (review m2).
      ['id eq "\\u0000"', "User"],
      ['externalId eq "a\\r\\nb"', "User"],
      ['userName eq "\\ud800"', "User"],
      ['userName eq "a\\udc00"', "User"],
      ['displayName eq "\\u007f"', "Group"],
      ['externalId eq "\\u001f"', "Group"],
      ['id eq "g" and members[value eq "\\u0000"]', "Group"],
    ] as const;
    for (const [text, resource] of rows) {
      expect(parseScimFilter(text, resource), text).toBeNull();
    }
  });
});
