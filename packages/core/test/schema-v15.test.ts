import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, schema } from "../src/schema.js";

// Schema version 15 (plan 12i Task 1). The writes and reads of the new
// fields and of the null and unique rules are in the conformance suite, so
// every adapter runs them.

describe("schema version 15 (plan 12i)", () => {
  it("is schema version 15", () => {
    expect(SCHEMA_VERSION).toBe(15);
  });

  it("makes the address nullable and adds four user fields as the last fields", () => {
    expect(schema.user.fields.email).toEqual({ type: "string", nullable: true });
    expect(Object.entries(schema.user.fields).slice(-4)).toEqual([
      ["username", { type: "string", nullable: true }],
      ["displayUsername", { type: "string", nullable: true }],
      ["phone", { type: "string", nullable: true }],
      ["isAnonymous", { type: "boolean" }],
    ]);
    expect(schema.user.unique).toEqual([["email"], ["username"], ["phone"]]);
    // The read of the anonymous step of the sweep (ruling 25 H1).
    expect(schema.user.indexes).toEqual([["isAnonymous", "createdAt"]]);
  });

  it("adds the three passkey extension flags as the last passkey fields", () => {
    expect(Object.entries(schema.passkey.fields).slice(-3)).toEqual([
      ["discoverable", { type: "boolean", nullable: true }],
      ["prf", { type: "boolean" }],
      ["largeBlob", { type: "boolean" }],
    ]);
    expect(schema.passkey.unique).toEqual([["credentialId"]]);
  });
});
