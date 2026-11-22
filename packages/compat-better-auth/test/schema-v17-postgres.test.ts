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
    expect(await s.migrate()).toEqual(["0014_compat_schema_v17"]);
    expect(COMPAT_MIGRATION_NAMES.at(-1)).toBe("0014_compat_schema_v17");
    const meta = await pg.sql.unsafe<{ key: string; value: string }[]>(
      "SELECT key, value FROM ta_meta ORDER BY key",
    );
    expect([...meta]).toEqual([
      { key: "compat_better_auth", value: "14" },
      { key: "schema_version", value: "17" },
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
