import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, schema } from "../src/schema.js";

// Schema version 13 (plan 12k Task 1). The writes and reads of the new
// fields and models are in the conformance suite, so every adapter runs them.

describe("schema version 13 (plan 12k)", () => {
  it("has schema version 13 or a later version", () => {
    // Plan 12d moves the version to 14: test/sso-schema.test.ts pins it.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(13);
  });

  it("adds the new fields of session, invitation, and apiToken as the last nullable fields", () => {
    expect(Object.entries(schema.session.fields).at(-1)).toEqual([
      "activeTeamId",
      { type: "string", nullable: true },
    ]);
    expect(Object.entries(schema.invitation.fields).at(-1)).toEqual([
      "teamIds",
      { type: "json", nullable: true },
    ]);
    expect(Object.entries(schema.apiToken.fields).slice(-10)).toEqual([
      ["organizationId", { type: "string", nullable: true }],
      ["permissions", { type: "json", nullable: true }],
      ["metadata", { type: "json", nullable: true }],
      ["rateLimitSeconds", { type: "integer", nullable: true }],
      ["rateLimitMax", { type: "integer", nullable: true }],
      ["remaining", { type: "integer", nullable: true }],
      ["refillAmount", { type: "integer", nullable: true }],
      ["refillSeconds", { type: "integer", nullable: true }],
      ["lastRefillAt", { type: "date", nullable: true }],
      ["retiredAt", { type: "date", nullable: true }],
    ]);
  });

  it("defines the five models with their keys", () => {
    // Plan 12d adds its six models after them.
    expect(Object.keys(schema).slice(-11, -6)).toEqual([
      "organizationRole",
      "team",
      "teamMember",
      "organizationToken",
      "movedToken",
    ]);
    // One record per key of a source (plan 12k Task 12 review, M2).
    expect([schema.movedToken.unique, schema.movedToken.indexes]).toEqual([
      [["source", "sourceId"]],
      [],
    ]);
    expect(Object.keys(schema.movedToken.fields)).not.toContain("userId");
    expect([schema.organizationRole.unique, schema.organizationRole.indexes]).toEqual([
      [["organizationId", "name"]],
      [],
    ]);
    expect([schema.team.unique, schema.team.indexes]).toEqual([[], [["organizationId"]]]);
    expect([schema.teamMember.unique, schema.teamMember.indexes]).toEqual([
      [["teamId", "userId"]],
      [["userId"], ["organizationId", "userId"]],
    ]);
    expect([schema.organizationToken.unique, schema.organizationToken.indexes]).toEqual([
      [["tokenHash"]],
      [["organizationId"]],
    ]);
    // No userId field: the account delete leaves the token (owner decision 2 of 2026-10-14).
    expect(Object.keys(schema.organizationToken.fields)).not.toContain("userId");
    expect(schema.organizationRole.fields.permissions).toEqual({ type: "json" });
    expect(schema.organizationToken.fields.permissions).toEqual({ type: "json" });
  });
});
