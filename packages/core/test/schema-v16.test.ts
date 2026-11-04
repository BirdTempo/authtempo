import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, schema } from "../src/schema.js";

// Schema version 16 (plan 12p Task 1). The fill of the live rows is in each
// adapter's schema-v16 test and in the compat migration test. The writes and
// reads of the field are in the conformance suite, so every adapter runs them.

describe("schema version 16 (plan 12p)", () => {
  it("is schema version 16", () => {
    expect(SCHEMA_VERSION).toBe(16);
  });

  it("adds proved to the session as its last field, a boolean that is never null", () => {
    expect(Object.entries(schema.session.fields).at(-1)).toEqual(["proved", { type: "boolean" }]);
    // The keys of the session do not change.
    expect(schema.session.unique).toEqual([["tokenHash"]]);
    expect(schema.session.indexes).toEqual([["userId"], ["activeOrganizationId"]]);
  });
});
