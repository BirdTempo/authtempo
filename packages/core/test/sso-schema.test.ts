import { describe, expect, it } from "vitest";
import { OPERATOR_ACTIONS } from "../src/engine/operator/audit.js";
import {
  SCHEMA_VERSION,
  SSO_AUDIT_ACTIONS,
  schema,
  type VerificationPurpose,
} from "../src/schema.js";
import { USER_CHILD_MODELS } from "../src/storage/sql.js";

// Schema version 14 (plan 12d Task 1). The writes and reads of the six
// models are in the conformance suite, so every adapter runs them.

const BASE = ["id", "createdAt", "updatedAt"];

describe("schema version 14 (plan 12d)", () => {
  it("is schema version 14 or a later version", () => {
    // Plan 12i moves the version to 15: test/schema-v15.test.ts pins it.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
  });

  it("holds the six models with their keys", () => {
    expect(Object.keys(schema).slice(-6)).toEqual([
      "ssoConnection",
      "ssoDomain",
      "scimToken",
      "scimUser",
      "scimGroup",
      "scimGroupMember",
    ]);
    expect(Object.entries(schema.ssoConnection.fields).slice(3)).toEqual([
      ["organizationId", { type: "string" }],
      ["kind", { type: "string" }],
      ["label", { type: "string" }],
      ["enabled", { type: "boolean" }],
      ["jit", { type: "boolean" }],
      ["defaultRole", { type: "string" }],
      ["config", { type: "json" }],
      ["clientSecret", { type: "string", nullable: true }],
      ["secretVersion", { type: "integer" }],
      ["mfa", { type: "json", nullable: true }],
      ["scimRoles", { type: "json", nullable: true }],
    ]);
    expect(Object.entries(schema.ssoDomain.fields).slice(3)).toEqual([
      ["organizationId", { type: "string" }],
      ["domain", { type: "string" }],
      ["challenge", { type: "string" }],
      ["claimedDomain", { type: "string", nullable: true }],
      ["connectionId", { type: "string", nullable: true }],
      ["enforce", { type: "boolean" }],
      ["includeSubdomains", { type: "boolean" }],
      ["verifiedAt", { type: "date", nullable: true }],
      ["checkedAt", { type: "date", nullable: true }],
      ["failures", { type: "integer" }],
      ["firstFailureAt", { type: "date", nullable: true }],
      ["expiresAt", { type: "date", nullable: true }],
    ]);
    expect(Object.entries(schema.scimToken.fields).slice(3)).toEqual([
      ["organizationId", { type: "string" }],
      ["name", { type: "string" }],
      ["tokenHash", { type: "string" }],
      ["hint", { type: "string" }],
      ["scopes", { type: "json" }],
      ["expiresAt", { type: "date", nullable: true }],
      ["lastUsedAt", { type: "date", nullable: true }],
    ]);
    expect(Object.entries(schema.scimUser.fields).slice(3)).toEqual([
      ["organizationId", { type: "string" }],
      ["userId", { type: "string" }],
      ["userName", { type: "string" }],
      ["userNameKey", { type: "string" }],
      ["externalId", { type: "string", nullable: true }],
      ["active", { type: "boolean" }],
      ["displayName", { type: "string", nullable: true }],
      ["data", { type: "json" }],
      ["version", { type: "integer" }],
    ]);
    expect(Object.entries(schema.scimGroup.fields).slice(3)).toEqual([
      ["organizationId", { type: "string" }],
      ["displayName", { type: "string" }],
      ["displayNameKey", { type: "string" }],
      ["externalId", { type: "string", nullable: true }],
      ["teamId", { type: "string", nullable: true }],
      ["version", { type: "integer" }],
    ]);
    expect(Object.entries(schema.scimGroupMember.fields).slice(3)).toEqual([
      ["groupId", { type: "string" }],
      ["scimUserId", { type: "string" }],
    ]);
    for (const model of [
      "ssoConnection",
      "ssoDomain",
      "scimToken",
      "scimUser",
      "scimGroup",
      "scimGroupMember",
    ] as const)
      expect({ model, base: Object.keys(schema[model].fields).slice(0, 3) }).toEqual({
        model,
        base: BASE,
      });
    expect([schema.ssoConnection.unique, schema.ssoConnection.indexes]).toEqual([
      [],
      [["organizationId"]],
    ]);
    expect([schema.ssoDomain.unique, schema.ssoDomain.indexes]).toEqual([
      [["organizationId", "domain"], ["claimedDomain"]],
      [["connectionId"]],
    ]);
    expect([schema.scimToken.unique, schema.scimToken.indexes]).toEqual([
      [["tokenHash"]],
      [["organizationId"]],
    ]);
    expect([schema.scimUser.unique, schema.scimUser.indexes]).toEqual([
      [
        ["organizationId", "userId"],
        ["organizationId", "userNameKey"],
      ],
      [["organizationId", "externalId"]],
    ]);
    expect([schema.scimGroup.unique, schema.scimGroup.indexes]).toEqual([
      [["organizationId", "displayNameKey"]],
      [["organizationId", "externalId"]],
    ]);
    expect([schema.scimGroupMember.unique, schema.scimGroupMember.indexes]).toEqual([
      [["groupId", "scimUserId"]],
      [["scimUserId"]],
    ]);
  });

  it("puts scimUser among the user child models", () => {
    expect(USER_CHILD_MODELS).toContain("scimUser");
    for (const model of ["ssoConnection", "ssoDomain", "scimToken", "scimGroup", "scimGroupMember"])
      expect(USER_CHILD_MODELS).not.toContain(model);
  });

  it("names the two new purposes and the audit actions", () => {
    // VerificationPurpose is a type with no list at run time. The compile of
    // this file fails when a purpose is not in the type (test typecheck).
    const purposes: VerificationPurpose[] = ["saml-request", "saml-assertion"];
    expect(purposes).toEqual(["saml-request", "saml-assertion"]);
    expect(SSO_AUDIT_ACTIONS).toEqual([
      "sso_connection_create",
      "sso_connection_update",
      "sso_connection_delete",
      "sso_domain_add",
      "sso_domain_verify",
      "sso_domain_update",
      "sso_domain_delete",
      "sso_domain_lost",
      "sso_enforce_off",
      "scim_token_create",
      "scim_token_revoke",
      "scim_user_create",
      "scim_user_update",
      "scim_user_deactivate",
      "scim_user_delete",
      "scim_group_create",
      "scim_group_update",
      "scim_group_delete",
    ]);
    for (const action of SSO_AUDIT_ACTIONS)
      expect({ action, count: OPERATOR_ACTIONS.filter((a) => a === action).length }).toEqual({
        action,
        count: 1,
      });
    expect(OPERATOR_ACTIONS).toHaveLength(28);
  });
});
