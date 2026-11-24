import { applyD1Migrations, env } from "cloudflare:test";
import { shapeDifferences, withoutDefaults } from "@authtempo/core/shape-conformance";
import { describe, expect, it } from "vitest";
import { createD1Adapter, D1_SHAPE_SQL, expectedD1Shape, parseD1Shape } from "../src/index.js";

type Column = { name: string; type: string; notnull: number; dflt_value: unknown };

async function columns(db: D1Database, table: string): Promise<Column[]> {
  return (await db.prepare(`PRAGMA table_info(${table})`).all<Column>()).results.map(
    ({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }),
  );
}

/** The names of the indexes of `table`, in name order. */
async function indexes(db: D1Database, table: string): Promise<string[]> {
  return (await db.prepare(`PRAGMA index_list(${table})`).all<{ name: string }>()).results
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_"))
    .sort();
}

const version = (db: D1Database) =>
  db.prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'").first("value");

const nullable = (name: string, type: string): Column => ({
  name,
  type,
  notnull: 0,
  dflt_value: null,
});

/** The columns that 0018 adds, by table, in the field order of the schema. */
const NEW_COLUMNS: Record<string, Column[]> = {
  ta_operator_audit: [nullable("organization_id", "TEXT")],
  ta_sso_connection: [
    nullable("certificate_ends_at", "INTEGER"),
    nullable("expiry_stage", "INTEGER"),
    nullable("expiry_notice_at", "INTEGER"),
    nullable("last_success_at", "INTEGER"),
    nullable("last_failure_at", "INTEGER"),
    nullable("last_failure_step", "TEXT"),
  ],
  ta_scim_token: [nullable("expiry_stage", "INTEGER"), nullable("expiry_notice_at", "INTEGER")],
  ta_sso_setup_link: [nullable("expiry_stage", "INTEGER"), nullable("expiry_notice_at", "INTEGER")],
};

/** The rows as a Worker of version 17 writes them: only the version 17 columns. */
const rowsOfVersion17 = (db: D1Database) =>
  [
    "INSERT INTO ta_operator_audit (id, created_at, updated_at, actor_kind, actor_id, action, target_user_id, reason, data, ip, user_agent) VALUES ('a17', 1, 1, 'secret', 'ops', 'ban', 'u1', 'spam', '{\"until\":null}', '203.0.113.9', 'curl/8')",
    "INSERT INTO ta_sso_connection (id, created_at, updated_at, organization_id, kind, label, enabled, jit, default_role, config, client_secret, secret_version, mfa, scim_roles, draft, version, setup_link_id) VALUES ('c17', 1, 2, 'o1', 'saml', 'Entra', 1, 0, 'member', '{\"entityId\":\"e1\"}', NULL, 1, NULL, NULL, 0, 2, 'l17')",
    "INSERT INTO ta_scim_token (id, created_at, updated_at, organization_id, name, token_hash, hint, scopes, expires_at, last_used_at, pending, setup_link_id) VALUES ('t17', 1, 1, 'o1', 'Okta', 'h-t17', 'abcd', '[\"users\"]', 5000, 3, 0, 'l17')",
    "INSERT INTO ta_sso_setup_link (id, created_at, updated_at, organization_id, token_hash, hint, steps, kinds, note, created_by, expires_at, revoked_at, ended_at, opened_at, ready_at) VALUES ('l17', 1, 2, 'o1', 'h-l17', 'wxyz', '[\"domain\",\"connection\"]', '[\"saml\"]', 'For IT', 'u1', 604800000, NULL, NULL, 3, NULL)",
  ].map((q) => db.prepare(q));

describe("schema version 18 on D1 (plan 13b)", () => {
  it("makes the new columns and the four indexes on a fresh database", async () => {
    // test/setup.ts applies every shipped file to env.DB.
    expect(await version(env.DB)).toBe("18");
    for (const [table, added] of Object.entries(NEW_COLUMNS))
      expect({ table, added: (await columns(env.DB, table)).slice(-added.length) }).toEqual({
        table,
        added,
      });
    expect(await indexes(env.DB, "ta_operator_audit")).toContain(
      "ix_ta_operator_audit__organization_id__id",
    );
    for (const table of ["ta_sso_connection", "ta_scim_token", "ta_sso_setup_link"])
      expect(await indexes(env.DB, table)).toContain(`ix_${table}__expiry_notice_at`);
  });

  it("migrates a version 17 database to 18, keeps every value, and reads each new field as null", async () => {
    // The rows go in between the files, as a Worker of version 17 writes them.
    const i0018 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0018_"));
    expect(i0018).toBe(17);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0018));
    expect(await version(env.STAGED)).toBe("17");
    await env.STAGED.batch(rowsOfVersion17(env.STAGED));
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0018 + 1));
    expect(await version(env.STAGED)).toBe("18");
    const db = createD1Adapter(env.STAGED);
    expect(await db.findOne("operatorAudit", [{ field: "id", op: "eq", value: "a17" }])).toEqual({
      id: "a17",
      createdAt: new Date(1),
      updatedAt: new Date(1),
      actorKind: "secret",
      actorId: "ops",
      action: "ban",
      targetUserId: "u1",
      reason: "spam",
      data: { until: null },
      ip: "203.0.113.9",
      userAgent: "curl/8",
      organizationId: null,
    });
    expect(await db.findOne("ssoConnection", [{ field: "id", op: "eq", value: "c17" }])).toEqual({
      id: "c17",
      createdAt: new Date(1),
      updatedAt: new Date(2),
      organizationId: "o1",
      kind: "saml",
      label: "Entra",
      enabled: true,
      jit: false,
      defaultRole: "member",
      config: { entityId: "e1" },
      clientSecret: null,
      secretVersion: 1,
      mfa: null,
      scimRoles: null,
      draft: false,
      version: 2,
      setupLinkId: "l17",
      certificateEndsAt: null,
      expiryStage: null,
      expiryNoticeAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureStep: null,
    });
    expect(await db.findOne("scimToken", [{ field: "id", op: "eq", value: "t17" }])).toEqual({
      id: "t17",
      createdAt: new Date(1),
      updatedAt: new Date(1),
      organizationId: "o1",
      name: "Okta",
      tokenHash: "h-t17",
      hint: "abcd",
      scopes: ["users"],
      expiresAt: new Date(5000),
      lastUsedAt: new Date(3),
      pending: false,
      setupLinkId: "l17",
      expiryStage: null,
      expiryNoticeAt: null,
    });
    expect(await db.findOne("ssoSetupLink", [{ field: "id", op: "eq", value: "l17" }])).toEqual({
      id: "l17",
      createdAt: new Date(1),
      updatedAt: new Date(2),
      organizationId: "o1",
      tokenHash: "h-l17",
      hint: "wxyz",
      steps: ["domain", "connection"],
      kinds: ["saml"],
      note: "For IT",
      createdBy: "u1",
      expiresAt: new Date(604800000),
      revokedAt: null,
      endedAt: null,
      openedAt: new Date(3),
      readyAt: null,
      expiryStage: null,
      expiryNoticeAt: null,
    });
  });

  it("holds no update and no delete of an audit row in the 0018 text", () => {
    // An audit row is append-only: no migration changes one, and no backfill names its organization.
    const m0018 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0018_"));
    expect(m0018?.queries.length).toBeGreaterThan(0);
    const writes = (m0018?.queries ?? []).filter((q) =>
      /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+ta_operator_audit\b/i.test(q),
    );
    expect(writes).toEqual([]);
  });

  it("builds the shape that core's schema object gives, as authtempo check --schema reads it", async () => {
    const live = parseD1Shape(
      (await env.DB.prepare(D1_SHAPE_SQL.columns).all()).results,
      (await env.DB.prepare(D1_SHAPE_SQL.indexes).all()).results,
    );
    expect(
      shapeDifferences(withoutDefaults(live), expectedD1Shape(), "the shipped files", "the schema"),
    ).toEqual([]);
  });
});
