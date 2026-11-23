import { shapeDifferences, withoutDefaults } from "@authtempo/core/shape-conformance";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createPostgresAdapter, expectedPostgresShape, readPostgresShape } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";
import { freshDatabase, freshSchema } from "./db.js";

type Column = {
  column_name: string;
  is_nullable: string;
  data_type: string;
  column_default: string | null;
};

const nullable = (column_name: string, data_type: string): Column => ({
  column_name,
  is_nullable: "YES",
  data_type,
  column_default: null,
});

const AT = "timestamp with time zone";

/** The columns that 0018 adds, by table, in the field order of the schema. */
const NEW_COLUMNS: Record<string, Column[]> = {
  ta_operator_audit: [nullable("organization_id", "text")],
  ta_sso_connection: [
    nullable("certificate_ends_at", AT),
    nullable("expiry_stage", "integer"),
    nullable("expiry_notice_at", AT),
    nullable("last_success_at", AT),
    nullable("last_failure_at", AT),
    nullable("last_failure_step", "text"),
  ],
  ta_scim_token: [nullable("expiry_stage", "integer"), nullable("expiry_notice_at", AT)],
  ta_sso_setup_link: [nullable("expiry_stage", "integer"), nullable("expiry_notice_at", AT)],
};

const columnsOf = async (a: Sql, table: string): Promise<Column[]> => [
  ...(await a.unsafe<Column[]>(
    "SELECT column_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
    [table],
  )),
];

const versionOf = async (a: Sql) =>
  (await a.unsafe<{ value: string }[]>("SELECT value FROM ta_meta WHERE key = 'schema_version'"))[0]
    ?.value;

/** The rows as a writer of version 17 writes them: only the version 17 columns. */
const ROWS_OF_VERSION_17 = [
  `INSERT INTO ta_operator_audit (id, created_at, updated_at, actor_kind, actor_id, action, target_user_id, reason, data, ip, user_agent) VALUES ('a17', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'secret', 'ops', 'ban', 'u1', 'spam', '{"until":null}', '203.0.113.9', 'curl/8')`,
  `INSERT INTO ta_sso_connection (id, created_at, updated_at, organization_id, kind, label, enabled, jit, default_role, config, client_secret, secret_version, mfa, scim_roles, draft, version, setup_link_id) VALUES ('c17', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'o1', 'saml', 'Entra', true, false, 'member', '{"entityId":"e1"}', NULL, 1, NULL, NULL, false, 2, 'l17')`,
  `INSERT INTO ta_scim_token (id, created_at, updated_at, organization_id, name, token_hash, hint, scopes, expires_at, last_used_at, pending, setup_link_id) VALUES ('t17', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'o1', 'Okta', 'h-t17', 'abcd', '["users"]', '2026-03-01T00:00:00Z', '2026-01-03T00:00:00Z', false, 'l17')`,
  `INSERT INTO ta_sso_setup_link (id, created_at, updated_at, organization_id, token_hash, hint, steps, kinds, note, created_by, expires_at, revoked_at, ended_at, opened_at, ready_at) VALUES ('l17', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'o1', 'h-l17', 'wxyz', '["domain","connection"]', '["saml"]', 'For IT', 'u1', '2026-01-08T00:00:00Z', NULL, NULL, '2026-01-03T00:00:00Z', NULL)`,
];

describe("schema version 18 on Postgres (plan 13b)", () => {
  it("makes the new columns and the four indexes on a fresh database", async () => {
    const { a, close } = await freshSchema();
    try {
      for (const m of MIGRATIONS) await a.unsafe(m.sql);
      expect(await versionOf(a)).toBe("18");
      for (const [table, added] of Object.entries(NEW_COLUMNS))
        expect({ table, added: (await columnsOf(a, table)).slice(-added.length) }).toEqual({
          table,
          added,
        });
      const indexes = await a.unsafe<{ indexname: string; indexdef: string }[]>(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND (indexname LIKE '%\\_\\_expiry\\_notice\\_at' OR indexname = 'ix_ta_operator_audit__organization_id__id') ORDER BY indexname",
      );
      expect(indexes.map((r) => `${r.indexname} ${r.indexdef.replace(/^.* USING /, "")}`)).toEqual([
        "ix_ta_operator_audit__organization_id__id btree (organization_id, id)",
        "ix_ta_scim_token__expiry_notice_at btree (expiry_notice_at)",
        "ix_ta_sso_connection__expiry_notice_at btree (expiry_notice_at)",
        "ix_ta_sso_setup_link__expiry_notice_at btree (expiry_notice_at)",
      ]);
    } finally {
      await close();
    }
  });

  it("migrates a version 17 database to 18, keeps every value, and reads each new field as null", async () => {
    const { a, close } = await freshSchema();
    try {
      const i0018 = MIGRATIONS.findIndex((m) => m.name === "0018_schema_v18");
      expect(i0018).toBe(17);
      for (const m of MIGRATIONS.slice(0, i0018)) await a.unsafe(m.sql);
      expect(await versionOf(a)).toBe("17");
      for (const q of ROWS_OF_VERSION_17) await a.unsafe(q);
      await a.unsafe(MIGRATIONS[i0018]?.sql ?? "");
      expect(await versionOf(a)).toBe("18");
      const db = createPostgresAdapter(a);
      const at = (day: string) => new Date(`2026-01-${day}T00:00:00Z`);
      expect(await db.findOne("operatorAudit", [{ field: "id", op: "eq", value: "a17" }])).toEqual({
        id: "a17",
        createdAt: at("01"),
        updatedAt: at("01"),
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
        createdAt: at("01"),
        updatedAt: at("02"),
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
        createdAt: at("01"),
        updatedAt: at("01"),
        organizationId: "o1",
        name: "Okta",
        tokenHash: "h-t17",
        hint: "abcd",
        scopes: ["users"],
        expiresAt: new Date("2026-03-01T00:00:00Z"),
        lastUsedAt: at("03"),
        pending: false,
        setupLinkId: "l17",
        expiryStage: null,
        expiryNoticeAt: null,
      });
      expect(await db.findOne("ssoSetupLink", [{ field: "id", op: "eq", value: "l17" }])).toEqual({
        id: "l17",
        createdAt: at("01"),
        updatedAt: at("02"),
        organizationId: "o1",
        tokenHash: "h-l17",
        hint: "wxyz",
        steps: ["domain", "connection"],
        kinds: ["saml"],
        note: "For IT",
        createdBy: "u1",
        expiresAt: at("08"),
        revokedAt: null,
        endedAt: null,
        openedAt: at("03"),
        readyAt: null,
        expiryStage: null,
        expiryNoticeAt: null,
      });
    } finally {
      await close();
    }
  });

  it("holds no update and no delete of an audit row in the 0018 text", () => {
    // An audit row is append-only: no migration changes one, and no backfill names its organization.
    const m0018 = MIGRATIONS.find((m) => m.name === "0018_schema_v18");
    expect(m0018?.sql).toMatch(/ta_operator_audit/);
    expect(m0018?.sql).not.toMatch(/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+ta_operator_audit\b/i);
  });

  it("builds the shape that core's schema object gives, as authtempo check --schema reads it", async () => {
    const db = await freshDatabase();
    try {
      const live = withoutDefaults(await readPostgresShape(db.sql));
      expect(
        shapeDifferences(live, expectedPostgresShape(), "the shipped files", "the schema"),
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
