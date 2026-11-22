import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

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

const CONFIG = { issuer: "https://idp.example.com", clientId: "c1" };

/** The rows of the SSO tables as a Worker of version 16 writes them: only the version 16 columns. */
const rowsOfVersion16 = (db: D1Database) => [
  db
    .prepare(
      "INSERT INTO ta_sso_connection (id, created_at, updated_at, organization_id, kind, label, enabled, jit, default_role, config, client_secret, secret_version, mfa, scim_roles) VALUES ('c16', 1, 2, 'o1', 'oidc', 'Okta', 1, 1, 'member', ?, 'sealed', 3, NULL, NULL)",
    )
    .bind(JSON.stringify(CONFIG)),
  db.prepare(
    "INSERT INTO ta_sso_domain (id, created_at, updated_at, organization_id, domain, challenge, claimed_domain, connection_id, enforce, include_subdomains, verified_at, checked_at, failures, first_failure_at, expires_at) VALUES ('d16', 1, 1, 'o1', 'example.com', 'ch', 'example.com', 'c16', 0, 0, 5, 5, 0, NULL, NULL)",
  ),
  db.prepare(
    "INSERT INTO ta_scim_token (id, created_at, updated_at, organization_id, name, token_hash, hint, scopes, expires_at, last_used_at) VALUES ('t16', 1, 1, 'o1', 'Okta', 'h-t16', 'abcd', '[\"users\"]', NULL, NULL)",
  ),
];

describe("schema version 17 on D1 (plan 13a)", () => {
  it("migrates a version 16 database to 17 and reads a connection of version 16 as no draft at version 1", async () => {
    // The rows go in between the files, as a Worker of version 16 writes them.
    const i0017 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0017_"));
    expect(i0017).toBe(16);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0017));
    await expect(createD1Adapter(env.STAGED).findMany("ssoConnection", [])).rejects.toMatchObject({
      name: "StorageError",
      code: "schema_mismatch",
      fields: ["16"],
    });
    await env.STAGED.batch(rowsOfVersion16(env.STAGED));
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0017 + 1));
    expect(await version(env.STAGED)).toBe("17");
    // The new columns come last, in the field order of the schema. The defaults live here only.
    expect((await columns(env.STAGED, "ta_sso_connection")).slice(-3)).toEqual([
      { name: "draft", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "version", type: "INTEGER", notnull: 1, dflt_value: "1" },
      { name: "setup_link_id", type: "TEXT", notnull: 0, dflt_value: null },
    ]);
    expect((await columns(env.STAGED, "ta_sso_domain")).at(-1)).toEqual({
      name: "setup_link_id",
      type: "TEXT",
      notnull: 0,
      dflt_value: null,
    });
    expect((await columns(env.STAGED, "ta_scim_token")).slice(-2)).toEqual([
      { name: "pending", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "setup_link_id", type: "TEXT", notnull: 0, dflt_value: null },
    ]);
    // The gate passes. Each row keeps its values and reads the defaults.
    const db = createD1Adapter(env.STAGED);
    expect(await db.findOne("ssoConnection", [{ field: "id", op: "eq", value: "c16" }])).toEqual({
      id: "c16",
      createdAt: new Date(1),
      updatedAt: new Date(2),
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
    expect(await db.findOne("ssoDomain", [{ field: "id", op: "eq", value: "d16" }])).toMatchObject({
      domain: "example.com",
      connectionId: "c16",
      setupLinkId: null,
    });
    expect(await db.findOne("scimToken", [{ field: "id", op: "eq", value: "t16" }])).toMatchObject({
      tokenHash: "h-t16",
      scopes: ["users"],
      pending: false,
      setupLinkId: null,
    });
    // A Worker of version 16 that writes after the migration names no new column: the defaults fill it.
    await env.STAGED.prepare(
      "INSERT INTO ta_sso_connection (id, created_at, updated_at, organization_id, kind, label, enabled, jit, default_role, config, client_secret, secret_version, mfa, scim_roles) VALUES ('c16b', 1, 1, 'o1', 'saml', 'Entra', 0, 0, 'member', '{}', NULL, 1, NULL, NULL)",
    ).run();
    expect(
      await db.findOne("ssoConnection", [{ field: "id", op: "eq", value: "c16b" }]),
    ).toMatchObject({
      draft: false,
      version: 1,
      setupLinkId: null,
    });
  });

  it("makes the three setup tables with their keys on a fresh database", async () => {
    // test/setup.ts applies every shipped file to env.DB.
    expect(await version(env.DB)).toBe("17");
    expect(await indexes(env.DB, "ta_sso_setup_link")).toEqual([
      "ix_ta_sso_setup_link__organization_id",
      "ux_ta_sso_setup_link__token_hash",
    ]);
    expect(await indexes(env.DB, "ta_sso_test_run")).toEqual(["ix_ta_sso_test_run__connection_id"]);
    expect(await indexes(env.DB, "ta_sso_setup_session")).toEqual([
      "ix_ta_sso_setup_session__link_id",
      "ux_ta_sso_setup_session__token_hash",
    ]);
    for (const table of ["ta_sso_setup_link", "ta_sso_test_run", "ta_sso_setup_session"])
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")).toBe(0);
  });
});
