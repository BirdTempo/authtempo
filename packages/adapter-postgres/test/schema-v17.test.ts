import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";
import { freshSchema } from "./db.js";

type Column = {
  column_name: string;
  is_nullable: string;
  data_type: string;
  column_default: string | null;
};

const CONFIG = { issuer: "https://idp.example.com", clientId: "c1" };

/** The rows of the SSO tables as a writer of version 16 writes them: only the version 16 columns. */
const ROWS_OF_VERSION_16 = [
  `INSERT INTO ta_sso_connection (id, created_at, updated_at, organization_id, kind, label, enabled, jit, default_role, config, client_secret, secret_version, mfa, scim_roles) VALUES ('c16', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'o1', 'oidc', 'Okta', true, true, 'member', '${JSON.stringify(CONFIG)}', 'sealed', 3, NULL, NULL)`,
  "INSERT INTO ta_sso_domain (id, created_at, updated_at, organization_id, domain, challenge, claimed_domain, connection_id, enforce, include_subdomains, verified_at, checked_at, failures, first_failure_at, expires_at) VALUES ('d16', now(), now(), 'o1', 'example.com', 'ch', 'example.com', 'c16', false, false, now(), now(), 0, NULL, NULL)",
  `INSERT INTO ta_scim_token (id, created_at, updated_at, organization_id, name, token_hash, hint, scopes, expires_at, last_used_at) VALUES ('t16', now(), now(), 'o1', 'Okta', 'h-t16', 'abcd', '["users"]', NULL, NULL)`,
];

describe("schema version 17 on Postgres (plan 13a)", () => {
  it("migrates a version 16 database to 17 and reads a connection of version 16 as no draft at version 1", async () => {
    const { a, close } = await freshSchema();
    try {
      const i0017 = MIGRATIONS.findIndex((m) => m.name === "0017_schema_v17");
      expect(i0017).toBe(16);
      for (const m of MIGRATIONS.slice(0, i0017)) await a.unsafe(m.sql);
      await expect(createPostgresAdapter(a).findMany("ssoConnection", [])).rejects.toMatchObject({
        name: "StorageError",
        code: "schema_mismatch",
        fields: ["16"],
      });
      for (const q of ROWS_OF_VERSION_16) await a.unsafe(q);
      await a.unsafe(MIGRATIONS[i0017]?.sql ?? "");
      const version = await a.unsafe<{ value: string }[]>(
        "SELECT value FROM ta_meta WHERE key = 'schema_version'",
      );
      expect(version[0]?.value).toBe("17");
      const columnsOf = async (table: string) => [
        ...(await a.unsafe<Column[]>(
          `SELECT column_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}' ORDER BY ordinal_position`,
        )),
      ];
      // The new columns come last, in the field order of the schema. The defaults live here only.
      expect((await columnsOf("ta_sso_connection")).slice(-3)).toEqual([
        { column_name: "draft", is_nullable: "NO", data_type: "boolean", column_default: "false" },
        { column_name: "version", is_nullable: "NO", data_type: "integer", column_default: "1" },
        {
          column_name: "setup_link_id",
          is_nullable: "YES",
          data_type: "text",
          column_default: null,
        },
      ]);
      expect((await columnsOf("ta_sso_domain")).at(-1)).toEqual({
        column_name: "setup_link_id",
        is_nullable: "YES",
        data_type: "text",
        column_default: null,
      });
      expect((await columnsOf("ta_scim_token")).slice(-2)).toEqual([
        {
          column_name: "pending",
          is_nullable: "NO",
          data_type: "boolean",
          column_default: "false",
        },
        {
          column_name: "setup_link_id",
          is_nullable: "YES",
          data_type: "text",
          column_default: null,
        },
      ]);
      // The gate passes. Each row keeps its values and reads the defaults.
      const db = createPostgresAdapter(a);
      expect(await db.findOne("ssoConnection", [{ field: "id", op: "eq", value: "c16" }])).toEqual({
        id: "c16",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
        organizationId: "o1",
        kind: "oidc",
        label: "Okta",
        enabled: true,
        jit: true,
        defaultRole: "member",
        config: CONFIG,
        clientSecret: "sealed",
        secretVersion: 3,
        mfa: null,
        scimRoles: null,
        draft: false,
        version: 1,
        setupLinkId: null,
      });
      expect(
        await db.findOne("ssoDomain", [{ field: "id", op: "eq", value: "d16" }]),
      ).toMatchObject({ domain: "example.com", connectionId: "c16", setupLinkId: null });
      expect(
        await db.findOne("scimToken", [{ field: "id", op: "eq", value: "t16" }]),
      ).toMatchObject({ tokenHash: "h-t16", scopes: ["users"], pending: false, setupLinkId: null });
    } finally {
      await close();
    }
  });

  it("makes the three setup tables with their keys on a fresh database", async () => {
    const { a, close } = await freshSchema();
    try {
      for (const m of MIGRATIONS) await a.unsafe(m.sql);
      const version = await a.unsafe<{ value: string }[]>(
        "SELECT value FROM ta_meta WHERE key = 'schema_version'",
      );
      expect(version[0]?.value).toBe("17");
      const indexes = await a.unsafe<{ tablename: string; indexname: string }[]>(
        "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN ('ta_sso_setup_link', 'ta_sso_test_run', 'ta_sso_setup_session') ORDER BY tablename, indexname",
      );
      expect(indexes.map((r) => `${r.tablename} ${r.indexname}`)).toEqual([
        "ta_sso_setup_link ix_ta_sso_setup_link__organization_id",
        "ta_sso_setup_link ta_sso_setup_link_pkey",
        "ta_sso_setup_link ux_ta_sso_setup_link__token_hash",
        "ta_sso_setup_session ix_ta_sso_setup_session__link_id",
        "ta_sso_setup_session ta_sso_setup_session_pkey",
        "ta_sso_setup_session ux_ta_sso_setup_session__token_hash",
        "ta_sso_test_run ix_ta_sso_test_run__connection_id",
        "ta_sso_test_run ta_sso_test_run_pkey",
      ]);
      const db = createPostgresAdapter(a);
      for (const model of ["ssoSetupLink", "ssoTestRun", "ssoSetupSession"] as const)
        expect(await db.findMany(model, [])).toEqual([]);
    } finally {
      await close();
    }
  });
});
