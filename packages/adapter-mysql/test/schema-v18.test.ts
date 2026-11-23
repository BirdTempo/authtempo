import { shapeDifferences, withoutDefaults } from "@authtempo/core/shape-conformance";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import { createMysqlAdapter, expectedMysqlShape, readMysqlShape } from "../src/index.js";
import {
  applyMysqlMigrations,
  applyMysqlMigrationsWith,
  MYSQL_MIGRATIONS,
} from "../src/migrations.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";

let db: MysqlDatabase | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

/** One column as information_schema gives it: name, nullable, default, and type. */
type Column = [string, string, string | null, string];

const nullable = (name: string, type: string): Column => [name, "YES", null, type];

/** The columns that 0006 adds, by table, in the field order of the schema. */
const NEW_COLUMNS: Record<string, Column[]> = {
  ta_operator_audit: [nullable("organization_id", "varchar(64)")],
  ta_sso_connection: [
    nullable("certificate_ends_at", "bigint"),
    nullable("expiry_stage", "int"),
    nullable("expiry_notice_at", "bigint"),
    nullable("last_success_at", "bigint"),
    nullable("last_failure_at", "bigint"),
    nullable("last_failure_step", "text"),
  ],
  ta_scim_token: [nullable("expiry_stage", "int"), nullable("expiry_notice_at", "bigint")],
  ta_sso_setup_link: [nullable("expiry_stage", "int"), nullable("expiry_notice_at", "bigint")],
};

async function columnsOf(pool: Pool, table: string): Promise<Column[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, COLUMN_TYPE AS t FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    [table],
  );
  return rows.map((r) => [r.c, r.n, r.d, r.t]);
}

async function versionOf(pool: Pool): Promise<string | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT `value` FROM `ta_meta` WHERE `key` = 'schema_version'",
  );
  return rows[0]?.value as string | undefined;
}

const M0006 = MYSQL_MIGRATIONS.find((m) => m.name === "0006_schema_v18");

/** The rows as a writer of version 17 writes them: only the version 17 columns. */
const ROWS_OF_VERSION_17 = [
  "INSERT INTO ta_operator_audit (id, created_at, updated_at, actor_kind, actor_id, action, target_user_id, reason, data, ip, user_agent) VALUES ('a17', 1, 1, 'secret', 'ops', 'ban', 'u1', 'spam', '{\"until\":null}', '203.0.113.9', 'curl/8')",
  "INSERT INTO ta_sso_connection (id, created_at, updated_at, organization_id, kind, label, enabled, jit, default_role, config, client_secret, secret_version, mfa, scim_roles, draft, version, setup_link_id) VALUES ('c17', 1, 2, 'o1', 'saml', 'Entra', 1, 0, 'member', '{\"entityId\":\"e1\"}', NULL, 1, NULL, NULL, 0, 2, 'l17')",
  "INSERT INTO ta_scim_token (id, created_at, updated_at, organization_id, name, token_hash, hint, scopes, expires_at, last_used_at, pending, setup_link_id) VALUES ('t17', 1, 1, 'o1', 'Okta', 'h-t17', 'abcd', '[\"users\"]', 5000, 3, 0, 'l17')",
  "INSERT INTO ta_sso_setup_link (id, created_at, updated_at, organization_id, token_hash, hint, steps, kinds, note, created_by, expires_at, revoked_at, ended_at, opened_at, ready_at) VALUES ('l17', 1, 2, 'o1', 'h-l17', 'wxyz', '[\"domain\",\"connection\"]', '[\"saml\"]', 'For IT', 'u1', 604800000, NULL, NULL, 3, NULL)",
];

describe("the 0006 text of schema version 18 (plan 13b)", () => {
  it("holds no update and no delete of an audit row", () => {
    // An audit row is append-only: no migration changes one, and no backfill names its organization.
    expect(M0006?.statements.some((s) => s.includes("`ta_operator_audit`"))).toBe(true);
    const writes = (M0006?.statements ?? []).filter((s) =>
      /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+`?ta_operator_audit\b/i.test(s),
    );
    expect(writes).toEqual([]);
  });
});

for (const server of MYSQL_SERVERS) {
  describe(`schema version 18 on MySQL ${server.version} (plan 13b)`, () => {
    it("makes the new columns and the four indexes on a fresh database", async () => {
      db = await freshDatabase(server);
      expect(await versionOf(db.pool)).toBe("18");
      for (const [table, added] of Object.entries(NEW_COLUMNS))
        expect({ table, added: (await columnsOf(db.pool, table)).slice(-added.length) }).toEqual({
          table,
          added,
        });
      const [keys] = await db.pool.query<RowDataPacket[]>(
        "SELECT INDEX_NAME AS i, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS c FROM information_schema.statistics WHERE TABLE_SCHEMA = DATABASE() AND (INDEX_NAME LIKE '%\\_\\_expiry\\_notice\\_at' OR INDEX_NAME = 'ix_ta_operator_audit__organization_id__id') GROUP BY INDEX_NAME ORDER BY INDEX_NAME",
      );
      expect(keys.map((r) => `${r.i} (${r.c})`)).toEqual([
        "ix_ta_operator_audit__organization_id__id (organization_id,id)",
        "ix_ta_scim_token__expiry_notice_at (expiry_notice_at)",
        "ix_ta_sso_connection__expiry_notice_at (expiry_notice_at)",
        "ix_ta_sso_setup_link__expiry_notice_at (expiry_notice_at)",
      ]);
    });

    it("migrates a version 17 database to 18, keeps every value, and reads each new field as null", async () => {
      const d = await freshDatabase(server, { migrate: false });
      db = d;
      const [first] = M0006?.statements ?? [];
      // The runner stops before the first step of 0006: the database is at version 17.
      const stopped = await applyMysqlMigrationsWith(d.pool, async (conn, sql) => {
        if (sql === first) throw new Error("stop before 0006");
        await conn.query(sql);
      }).catch((e: unknown) => e);
      expect(stopped).toMatchObject({ message: "stop before 0006" });
      expect(await versionOf(d.pool)).toBe("17");
      for (const q of ROWS_OF_VERSION_17) await d.pool.query(q);
      expect(await applyMysqlMigrations(d.pool)).toEqual(["0006_schema_v18"]);
      expect(await versionOf(d.pool)).toBe("18");
      const adapter = createMysqlAdapter(d.pool);
      expect(
        await adapter.findOne("operatorAudit", [{ field: "id", op: "eq", value: "a17" }]),
      ).toEqual({
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
      expect(
        await adapter.findOne("ssoConnection", [{ field: "id", op: "eq", value: "c17" }]),
      ).toEqual({
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
      expect(await adapter.findOne("scimToken", [{ field: "id", op: "eq", value: "t17" }])).toEqual(
        {
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
        },
      );
      expect(
        await adapter.findOne("ssoSetupLink", [{ field: "id", op: "eq", value: "l17" }]),
      ).toEqual({
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

    it("builds the shape that core's schema object gives, as authtempo check --schema reads it", async () => {
      db = await freshDatabase(server);
      const live = withoutDefaults(await readMysqlShape(db.pool));
      expect(
        shapeDifferences(live, expectedMysqlShape(), "the shipped files", "the schema"),
      ).toEqual([]);
    });
  });
}
