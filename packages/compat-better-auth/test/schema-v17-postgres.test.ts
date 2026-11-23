import { expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { COMPAT_MIGRATION_NAMES, compatPostgresSteps } from "../src/storage/migration.js";
import { BETTER_AUTH_PG } from "./fixtures.js";
import { freshBetterAuthSchema } from "./pg.js";

// Compat migration 0014 on Postgres (plan 13a). The SSO tables are core's own
// tables in a compat database, so 0014 is the text of core 0017. A connection
// and a token of compat 13 read as no draft, at version 1, and not pending.

it("reads a connection of compat 13 as no draft at version 1 after 0014 on Postgres (plan 13a)", async () => {
  const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
  try {
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    // The steps before 0014: a store of compat 13.
    const steps = compatPostgresSteps(s.names);
    const i0014 = steps.findIndex((step) => step.name === "0014_compat_schema_v17");
    expect(i0014).toBe(13);
    for (const step of steps.slice(0, i0014)) await pg.sql.begin((tx) => tx.unsafe(step.text));
    // Rows as core 16 writes them.
    await pg.sql.unsafe(
      "INSERT INTO ta_sso_connection (id, created_at, updated_at, organization_id, kind, label, enabled, jit, default_role, config, client_secret, secret_version, mfa, scim_roles) VALUES ('c16', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'o1', 'oidc', 'Okta', true, true, 'member', '{}', 'sealed', 3, NULL, NULL)",
    );
    await pg.sql.unsafe(
      `INSERT INTO ta_scim_token (id, created_at, updated_at, organization_id, name, token_hash, hint, scopes, expires_at, last_used_at) VALUES ('t16', now(), now(), 'o1', 'Okta', 'h-t16', 'abcd', '["users"]', NULL, NULL)`,
    );
    // The runner applies 0014, then 0015 of plan 13b.
    expect(await s.migrate()).toEqual(["0014_compat_schema_v17", "0015_compat_schema_v18"]);
    expect(COMPAT_MIGRATION_NAMES.at(-2)).toBe("0014_compat_schema_v17");
    const meta = await pg.sql.unsafe<{ key: string; value: string }[]>(
      "SELECT key, value FROM ta_meta ORDER BY key",
    );
    expect([...meta]).toEqual([
      { key: "compat_better_auth", value: "15" },
      { key: "schema_version", value: "18" },
    ]);
    expect(
      await s.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: "c16" }]),
    ).toMatchObject({
      label: "Okta",
      clientSecret: "sealed",
      secretVersion: 3,
      draft: false,
      version: 1,
      setupLinkId: null,
    });
    expect(
      await s.storage.findOne("scimToken", [{ field: "id", op: "eq", value: "t16" }]),
    ).toMatchObject({ tokenHash: "h-t16", pending: false, setupLinkId: null });
    for (const model of ["ssoSetupLink", "ssoTestRun", "ssoSetupSession"] as const)
      expect(await s.storage.findMany(model, [])).toEqual([]);
  } finally {
    await pg.close();
  }
});

// Compat migration 0015 on Postgres (plan 13b). It is the text of core 0018:
// it adds columns and indexes to core's own tables, and no Better Auth table
// changes. An audit row and a connection of compat 14 keep their values.
it("adds the columns of core 18 to a store of compat 14 on Postgres, and changes no Better Auth table (plan 13b)", async () => {
  const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
  try {
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    // The steps before 0015: a store of compat 14.
    const steps = compatPostgresSteps(s.names);
    const i0015 = steps.findIndex((step) => step.name === "0015_compat_schema_v18");
    expect(i0015).toBe(14);
    for (const step of steps.slice(0, i0015)) await pg.sql.begin((tx) => tx.unsafe(step.text));
    // Rows as core 17 writes them.
    await pg.sql.unsafe(
      `INSERT INTO ta_operator_audit (id, created_at, updated_at, actor_kind, actor_id, action, target_user_id, reason, data, ip, user_agent) VALUES ('a17', now(), now(), 'operator', 'op', 'sso_enforce_off', NULL, 'r', '{"organizationId":"o1"}', NULL, NULL)`,
    );
    await pg.sql.unsafe(
      "INSERT INTO ta_sso_connection (id, created_at, updated_at, organization_id, kind, label, enabled, jit, default_role, config, client_secret, secret_version, mfa, scim_roles, draft, version, setup_link_id) VALUES ('c17', now(), now(), 'o1', 'saml', 'Okta', true, true, 'member', '{}', NULL, 1, NULL, NULL, false, 4, NULL)",
    );
    /** The columns of each table that is not a ta_ table. */
    const betterAuth = () =>
      pg.sql.unsafe<{ t: string; c: string; d: string; n: string }[]>(
        "SELECT table_name AS t, column_name AS c, data_type AS d, is_nullable AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name NOT LIKE 'ta\\_%' ORDER BY table_name, ordinal_position",
      );
    const before = [...(await betterAuth())];
    expect(before.length).toBeGreaterThan(0);
    expect(await s.migrate()).toEqual(["0015_compat_schema_v18"]);
    expect([...(await betterAuth())]).toEqual(before);
    const meta = await pg.sql.unsafe<{ key: string; value: string }[]>(
      "SELECT key, value FROM ta_meta ORDER BY key",
    );
    expect([...meta]).toEqual([
      { key: "compat_better_auth", value: "15" },
      { key: "schema_version", value: "18" },
    ]);
    expect(
      await s.storage.findOne("operatorAudit", [{ field: "id", op: "eq", value: "a17" }]),
    ).toMatchObject({ action: "sso_enforce_off", organizationId: null });
    expect(
      await s.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: "c17" }]),
    ).toMatchObject({
      label: "Okta",
      version: 4,
      certificateEndsAt: null,
      expiryStage: null,
      expiryNoticeAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureStep: null,
    });
  } finally {
    await pg.close();
  }
});
