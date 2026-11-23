import { describe, expect, it } from "vitest";
import { effectiveOf } from "../src/access.js";
import { ConfigError, resolveConfig } from "../src/config.js";
import { SSO_HOOK_POINTS } from "../src/engine/hooks.js";
import { OPERATOR_ACTIONS, ORGANIZATION_AUDIT_REASON } from "../src/engine/operator/audit.js";
import { deriveRoles } from "../src/engine/ranks.js";
import { createScimToken } from "../src/engine/scim/tokens.js";
import { createConnection } from "../src/engine/sso/connections.js";
import { OPERATOR_CONTRACT } from "../src/http/contract/operator.js";
import { ORGANIZATIONS_CONTRACT } from "../src/http/contract/organizations.js";
import { SSO_CONTRACT } from "../src/http/contract/sso.js";
import { ROUTES } from "../src/http/route-list.js";
import { newId } from "../src/primitives/ids.js";
import {
  EXPIRY_KINDS,
  EXPIRY_STAGES,
  type OperatorAuditRow,
  ORGANIZATION_AUDIT_ACTIONS,
  ORGANIZATION_VISIBLE_ACTIONS,
  SCHEMA_VERSION,
  SSO_AUDIT_ACTIONS,
  type SsoSetupLinkRow,
  schema,
} from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { base } from "./every-feature.js";
import { SSO_APP, seedOrganization, ssoAuth } from "./sso/helpers.js";

// Schema version 18 (plan 13b Task 0): the names of the organization audit and the expiry
// notices. Later tasks write and read the new fields. This file holds the names to the contract.

/** The 11 actions of the organization audit, in the order of the contract. */
const ORGANIZATION_ACTIONS = [
  "organization_member_add",
  "organization_member_remove",
  "organization_member_role_change",
  "organization_invitation_create",
  "organization_invitation_accept",
  "organization_invitation_revoke",
  "organization_token_create",
  "organization_token_revoke",
  "organization_role_create",
  "organization_role_update",
  "organization_role_delete",
];

/** The expiry fields of each model, as Task 0 adds them. */
const EXPIRY_FIELDS = {
  ssoConnection: [
    "certificateEndsAt",
    "expiryStage",
    "expiryNoticeAt",
    "lastSuccessAt",
    "lastFailureAt",
    "lastFailureStep",
  ],
  scimToken: ["expiryStage", "expiryNoticeAt"],
  ssoSetupLink: ["expiryStage", "expiryNoticeAt"],
} as const;

/** The value of each named field of a row. */
const valuesOf = (row: Record<string, unknown> | null, fields: readonly string[]) =>
  fields.map((f) => row?.[f]);

describe("schema version 18 (plan 13b)", () => {
  it("version: is schema version 18", () => {
    expect(SCHEMA_VERSION).toBe(18);
  });

  it("audit column: an audit row with a null organizationId reads back null", async () => {
    const storage = createMemoryAdapter();
    const now = new Date("2026-11-23T10:00:00Z");
    const row: OperatorAuditRow = {
      id: newId(now),
      createdAt: now,
      updatedAt: now,
      actorKind: "secret",
      actorId: "support",
      action: "ban",
      targetUserId: "u_1",
      reason: "spam",
      data: null,
      ip: null,
      userAgent: null,
      organizationId: null,
    };
    await storage.create("operatorAudit", row);
    const read = await storage.findOne("operatorAudit", [{ field: "id", op: "eq", value: row.id }]);
    expect(read?.organizationId).toBeNull();
    expect(schema.operatorAudit.fields.organizationId).toMatchObject({ type: "string" });
    expect(schema.operatorAudit.indexes).toContainEqual(["organizationId", "id"]);
  });

  it.each([
    ["operatorAudit", "organizationId", "string"],
    ["ssoConnection", "certificateEndsAt", "date"],
    ["ssoConnection", "expiryStage", "integer"],
    ["ssoConnection", "expiryNoticeAt", "date"],
    ["ssoConnection", "lastSuccessAt", "date"],
    ["ssoConnection", "lastFailureAt", "date"],
    ["ssoConnection", "lastFailureStep", "string"],
    ["scimToken", "expiryStage", "integer"],
    ["scimToken", "expiryNoticeAt", "date"],
    ["ssoSetupLink", "expiryStage", "integer"],
    ["ssoSetupLink", "expiryNoticeAt", "date"],
  ] as const)("nullable: %s.%s is a nullable %s", (model, field, type) => {
    // An act on a user writes a null organization, and a row from before version 18 has no value.
    const fields: Record<string, unknown> = schema[model].fields;
    expect(fields[field]).toEqual({ type, nullable: true });
  });

  it("expiry columns: a connection, a SCIM token, and a link read back each new field null", async () => {
    const w = ssoAuth({ sso: { oidc: true }, scim: {} });
    const organizationId = await seedOrganization(w);
    const connection = await createConnection(w.config, SSO_APP, {
      organizationId,
      kind: "oidc",
      label: "Acme Entra ID",
      issuer: "https://login.idp.example/acme/v2.0",
      clientId: "acme-client",
      clientSecret: "the-client-secret-of-acme-0123456789",
    });
    if (!connection.ok) throw new Error(connection.code);
    const token = await createScimToken(w.config, SSO_APP, { organizationId, name: "Acme IdP" });
    if (!token.ok) throw new Error(token.code);
    const now = new Date("2026-11-23T10:00:00Z");
    const link: SsoSetupLinkRow = {
      id: newId(now),
      createdAt: now,
      updatedAt: now,
      organizationId,
      tokenHash: "hash-1",
      hint: "abcd",
      steps: ["domain"],
      kinds: ["oidc"],
      note: "Pat at Acme IT",
      createdBy: "sso-test",
      expiresAt: new Date(now.getTime() + 72 * 3600_000),
      revokedAt: null,
      endedAt: null,
      openedAt: null,
      readyAt: null,
      expiryStage: null,
      expiryNoticeAt: null,
    };
    await w.storage.create("ssoSetupLink", link);
    const byId = (id: string) => [{ field: "id", op: "eq", value: id }] as const;
    const reads = {
      ssoConnection: await w.storage.findOne("ssoConnection", [...byId(connection.value.id)]),
      scimToken: await w.storage.findOne("scimToken", [...byId(token.value.id)]),
      ssoSetupLink: await w.storage.findOne("ssoSetupLink", [...byId(link.id)]),
    };
    for (const model of ["ssoConnection", "scimToken", "ssoSetupLink"] as const) {
      const fields = EXPIRY_FIELDS[model];
      const read = reads[model] as unknown as Record<string, unknown> | null;
      expect(valuesOf(read, fields), model).toEqual(fields.map(() => null));
      for (const f of fields) expect(schema[model].fields, `${model}.${f}`).toHaveProperty(f);
      expect(schema[model].indexes, model).toContainEqual(["expiryNoticeAt"]);
    }
  });

  it("permission default: of the default ranks, only owner holds audit:read", () => {
    const roles = deriveRoles({ viewer: 1, member: 2, admin: 3, owner: 4 });
    expect(roles.owner?.permissions.audit).toEqual(["read"]);
    for (const role of ["admin", "member", "viewer"])
      expect(roles[role]?.permissions, role).not.toHaveProperty("audit");
  });

  it("roles form: a role holds audit only when the app lists it", () => {
    const config = resolveConfig({
      ...base,
      organizations: {
        roles: {
          owner: { rank: 5, permissions: { audit: ["read"] } },
          lead: { rank: 4, permissions: { member: ["read"] } },
        },
      },
    });
    const roles = config.organizations?.roles ?? {};
    expect(effectiveOf("lead", roles)).not.toHaveProperty("audit");
    expect(effectiveOf("owner", roles).audit).toEqual(["read"]);
  });

  it("app resource audit: a statement named audit throws a ConfigError", () => {
    const make = () =>
      resolveConfig({ ...base, organizations: { statements: { audit: ["view"] } } });
    expect(make).toThrow(ConfigError);
    expect(make).toThrow("organizations.statements.audit is a core resource");
  });

  it("actions: OPERATOR_ACTIONS holds 48, with the 11 organization acts and the link ready act", () => {
    expect(OPERATOR_ACTIONS).toHaveLength(48);
    expect([...ORGANIZATION_AUDIT_ACTIONS]).toEqual(ORGANIZATION_ACTIONS);
    expect(SSO_AUDIT_ACTIONS).toContain("sso_setup_link_ready");
    for (const action of [...ORGANIZATION_ACTIONS, "sso_setup_link_ready"])
      expect(OPERATOR_ACTIONS).toContain(action);
    expect([...ORGANIZATION_VISIBLE_ACTIONS]).toEqual([
      ...SSO_AUDIT_ACTIONS,
      ...ORGANIZATION_AUDIT_ACTIONS,
    ]);
    for (const action of ORGANIZATION_ACTIONS)
      expect(ORGANIZATION_AUDIT_REASON[action as keyof typeof ORGANIZATION_AUDIT_REASON]).toMatch(
        /^[a-z]/,
      );
  });

  it("hook point: SSO_HOOK_POINTS names beforeSignIn, setupReady, and expiring", () => {
    expect(Object.keys(SSO_HOOK_POINTS)).toEqual(["beforeSignIn", "setupReady", "expiring"]);
  });

  it("expiry: names three kinds and the stages 30, 7, and 1 days", () => {
    expect([...EXPIRY_KINDS]).toEqual(["saml_certificate", "scim_token", "setup_link"]);
    expect([...EXPIRY_STAGES]).toEqual([30, 7, 1]);
  });

  it("route: GET /organizations/audit takes a session, in the feature organizations", () => {
    const route = ROUTES.find((r) => r.method === "GET" && r.path === "/organizations/audit");
    expect(route?.auth).toEqual(["session"]);
    expect(route?.feature).toBe("organizations");
    const list = ROUTES.find((r) => r.method === "GET" && r.path === "/organizations/invitations");
    expect(route?.codes).toEqual(list?.codes);
  });

  /** The query schema, read in each test, so that a missing contract fails each row alone. */
  const queryOf = () => ORGANIZATIONS_CONTRACT["GET /organizations/audit"].query.schema;
  const at = { organizationId: "org_1" };
  it("query bounds: takes the query as the router reads it, as strings", () => {
    const query = queryOf();
    expect(query.safeParse(at).success).toBe(true);
    expect(query.safeParse({ ...at, limit: "1" }).success).toBe(true);
    expect(query.safeParse({ ...at, limit: "100" }).success).toBe(true);
    expect(
      query.safeParse({ ...at, after: "a_1", action: "organization_member_add" }).success,
    ).toBe(true);
    const range = { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" };
    expect(query.safeParse({ ...at, ...range }).success).toBe(true);
  });

  it.each([
    ["limit 0", { limit: "0" }],
    ["limit 101", { limit: "101" }],
    ["limit 5 as a number", { limit: 5 }],
    ["from = to", { from: "2026-11-01T00:00:00Z", to: "2026-11-01T00:00:00Z" }],
    ["from after to", { from: "2026-11-02T00:00:00Z", to: "2026-11-01T00:00:00Z" }],
    ["an action of no organization", { action: "user_ban" }],
    ["no organizationId", { organizationId: undefined }],
    ["an unknown key", { other: "x" }],
  ])("query bounds: refuses %s", (_name, extra) => {
    expect(queryOf().safeParse({ ...at, ...extra }).success).toBe(false);
  });

  it("operator read: GET /operator/audit takes organizationId, and its row names it", () => {
    const operator = OPERATOR_CONTRACT["GET /operator/audit"];
    expect(operator.query.schema.safeParse({ organizationId: "org_1" }).success).toBe(true);
    expect(operator.query.schema.safeParse({ organizationId: "" }).success).toBe(false);
    const answer = operator.answer.schema.shape.rows.element.shape;
    expect(Object.keys(answer)).toContain("organizationId");
  });

  it("connection status: each connection of GET /sso/connections has a status", () => {
    const answer = SSO_CONTRACT["GET /sso/connections"].answer.schema.shape.connections.element;
    expect(Object.keys(answer.shape.status.shape)).toEqual([
      "lastSuccessAt",
      "lastFailureAt",
      "lastFailureStep",
      "certificateEndsAt",
      "expiryStage",
    ]);
    const status = answer.shape.status;
    const none = {
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureStep: null,
      certificateEndsAt: null,
      expiryStage: null,
    };
    expect(status.safeParse(none).success).toBe(true);
    for (const stage of [30, 7, 1])
      expect(status.safeParse({ ...none, expiryStage: stage }).success).toBe(true);
    expect(status.safeParse({ ...none, expiryStage: 2 }).success).toBe(false);
  });
});
