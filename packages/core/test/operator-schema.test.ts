import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, schema } from "../src/schema.js";
import { USER_CHILD_MODELS } from "../src/storage/sql.js";

// Schema version 12 (plan 12f Task 1). The writes and reads of the new
// fields and of the audit model are in the conformance suite, so every
// adapter runs them.

describe("schema version 12 (plan 12f)", () => {
  it("has schema version 12 or a later version", () => {
    // Plan 12k moves the version to 13: test/schema-v13.test.ts pins it.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
  });

  it("adds the ban fields and the actor field as the last nullable fields", () => {
    expect(Object.entries(schema.user.fields).slice(-3)).toEqual([
      ["bannedAt", { type: "date", nullable: true }],
      ["banReason", { type: "string", nullable: true }],
      ["banUntil", { type: "date", nullable: true }],
    ]);
    // Plan 12k adds activeTeamId after actorId.
    expect(Object.entries(schema.session.fields).at(-2)).toEqual([
      "actorId",
      { type: "string", nullable: true },
    ]);
  });

  it("defines the audit model with its two indexes", () => {
    // The fields of spec 26 item 8, in that order.
    expect(Object.entries(schema.operatorAudit.fields)).toEqual([
      ["id", { type: "string" }],
      ["createdAt", { type: "date" }],
      ["updatedAt", { type: "date" }],
      ["actorKind", { type: "string" }],
      ["actorId", { type: "string" }],
      ["action", { type: "string" }],
      ["targetUserId", { type: "string", nullable: true }],
      ["reason", { type: "string" }],
      ["data", { type: "json", nullable: true }],
      ["ip", { type: "string", nullable: true }],
      ["userAgent", { type: "string", nullable: true }],
    ]);
    expect(schema.operatorAudit.unique).toEqual([]);
    expect(schema.operatorAudit.indexes).toEqual([["targetUserId"], ["actorId"]]);
  });

  it("keeps the audit model out of the user's child models", () => {
    // Its field is targetUserId, not userId, so the account delete keeps the rows.
    expect(USER_CHILD_MODELS).not.toContain("operatorAudit");
    expect(USER_CHILD_MODELS).toContain("session");
  });
});
