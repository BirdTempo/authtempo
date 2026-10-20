import { expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import {
  COMPAT_MIGRATION_0002_SQL,
  COMPAT_MIGRATION_0003_SQL,
  COMPAT_MIGRATION_0004_SQL,
  COMPAT_MIGRATION_0005_SQL,
  compatMigration0006Sql,
  compatMigration0007Sql,
  compatMigrationSql,
} from "../src/storage/migration.js";
import { resolveNames } from "../src/storage/names.js";
import { BETTER_AUTH_PG } from "./fixtures.js";
import { freshBetterAuthSchema } from "./pg.js";

// Compat migration 0008 on Postgres (plan 12e). A client and a token row of
// version 10 read every default of version 11 through the compat storage.

it("reads a version 10 client and token row with every default after 0008 on Postgres (plan 12e)", async () => {
  const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
  try {
    // The runner's texts of 0001 to 0007, in its order: a database of compat version 7.
    const names = resolveNames();
    for (const text of [
      compatMigrationSql("postgres", names),
      COMPAT_MIGRATION_0002_SQL,
      COMPAT_MIGRATION_0003_SQL.postgres,
      COMPAT_MIGRATION_0004_SQL.postgres,
      COMPAT_MIGRATION_0005_SQL.postgres,
      compatMigration0006Sql("postgres", names),
      compatMigration0007Sql("postgres", names),
    ])
      await pg.sql.begin((tx) => tx.unsafe(text));
    // A writer of version 10 names only the version 10 columns.
    await pg.sql.unsafe(
      `INSERT INTO ta_oauth_client (id, created_at, updated_at, kind, name, redirect_uris, last_seen_at) VALUES ('cl_10', now(), now(), 'registered', NULL, '["https://app.example.com/cb"]'::jsonb, now())`,
    );
    await pg.sql.unsafe(
      `INSERT INTO ta_oauth_token (id, created_at, updated_at, token_hash, family_id, user_id, client_id, scopes, resource, expires_at, used_at) VALUES ('t10', now(), now(), 'h10', 'f10', 'u10', 'cl_10', '["offline_access"]'::jsonb, 'https://api.example.com/mcp', now() + interval '1 day', NULL)`,
    );
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    expect(await s.migrate()).toEqual(["0008_compat_schema_v11"]);
    const client = await s.storage.findOne("oauthClient", [
      { field: "id", op: "eq", value: "cl_10" },
    ]);
    expect(client).toMatchObject({
      authMethod: "none",
      secretHash: null,
      secretExpiresAt: null,
      previousSecretHash: null,
      previousSecretUntil: null,
      jwks: null,
      jwksUri: null,
      grantTypes: ["authorization_code", "refresh_token"],
      credentialsScopes: [],
      introspect: false,
      postLogoutRedirectUris: [],
      backchannelLogoutUri: null,
      backchannelLogoutSessionRequired: false,
      subjectType: "public",
      dpopBound: false,
    });
    const token = await s.storage.findOne("oauthToken", [{ field: "id", op: "eq", value: "t10" }]);
    expect(token).toMatchObject({ parentId: null, dpopJkt: null });
  } finally {
    await pg.close();
  }
});
