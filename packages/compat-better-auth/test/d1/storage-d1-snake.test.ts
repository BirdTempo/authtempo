import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import {
  COMPAT_MIGRATION_0002_SQL,
  COMPAT_MIGRATION_0003_SQL,
  COMPAT_MIGRATION_0004_SQL,
  COMPAT_MIGRATION_0005_SQL,
  compatMigration0006Sql,
  compatMigration0007Sql,
  compatMigration0008Sql,
  compatMigration0009Sql,
  compatMigration0010Sql,
} from "../../src/storage/migration.js";
import { type NamingOptions, resolveNames } from "../../src/storage/names.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { d1MappingSuite } from "./mapping-suite.js";
import { execD1 } from "./schema.js";
import { before17, renamed } from "./sql.js";

// The SQLite counterpart of the Postgres consumer-i fixture: snake_case
// columns, no account.issuer (tables from before 1.7), and here also plural
// table names. Built from Better Auth's own SQLite SQL with its seven foreign
// keys, renamed (plan 9b: every suite here creates each parent row first).
// The migration is the before-1.7 text for these names, from
// migrationSql("before-1.7"). Then 0002 to 0005 run, which are the same for every naming.
// Then 0006 runs, which names the verification table and its column (plan 12b).
// Then 0007 runs, which names the session table and its column (plan 12a).
// Then 0008 runs, which names ta_ tables only (plan 12e).
// Then 0009 runs, which names the user and session tables and their columns (plan 12f).
// Then 0010 runs, which names the session and invitation tables and their columns (plan 12k).
const naming = {
  casing: "snake",
  tables: {
    user: "users",
    session: "sessions",
    account: "accounts",
    verification: "verifications",
    organization: "organizations",
    member: "members",
    invitation: "invitations",
    passkey: "passkeys",
  },
} satisfies Omit<NamingOptions, "pgSchema">;

const tables = renamed(before17(BETTER_AUTH_SQLITE), naming);
await execD1(tables);
await execD1(
  betterAuthSchemaStorage({ dialect: "d1", db: env.DB, ...naming }).migrationSql("before-1.7"),
);
await execD1(COMPAT_MIGRATION_0002_SQL);
await execD1(COMPAT_MIGRATION_0003_SQL.sqlite);
await execD1(COMPAT_MIGRATION_0004_SQL.sqlite);
await execD1(COMPAT_MIGRATION_0005_SQL.sqlite);
await execD1(compatMigration0006Sql("sqlite", resolveNames(naming)));
await execD1(compatMigration0007Sql("sqlite", resolveNames(naming)));
await execD1(compatMigration0008Sql("sqlite"));
await execD1(compatMigration0009Sql("sqlite", resolveNames(naming)));
await execD1(compatMigration0010Sql("sqlite", resolveNames(naming)));

it("builds the tables with snake_case columns and plural names", async () => {
  const cols = await env.DB.prepare(
    `SELECT name FROM pragma_table_info('accounts') ORDER BY cid`,
  ).all<{ name: string }>();
  expect(cols.results.map((c) => c.name)).toContain("provider_id");
  expect(cols.results.map((c) => c.name)).toContain("issuer");
  expect(cols.results.map((c) => c.name)).toContain("ta_linked_at");
  expect(tables).not.toMatch(/"user"|"account"|"providerId"/);
});

d1MappingSuite("snake_case and plural names (consumer-i's casing)", naming);
