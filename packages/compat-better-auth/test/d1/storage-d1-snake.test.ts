import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import type { NamingOptions } from "../../src/storage/names.js";
import { BETTER_AUTH_SQLITE, withoutForeignKeys } from "../fixtures.js";
import { d1MappingSuite } from "./mapping-suite.js";
import { execD1 } from "./schema.js";
import { before17, renamed } from "./sql.js";

// The SQLite counterpart of the Postgres consumer-i fixture: snake_case
// columns, no account.issuer (tables from before 1.7), and here also plural
// table names. Built from Better Auth's own SQLite SQL, without the foreign
// keys (the suites here also run on tables with no keys). The migration
// is the before-1.7 text for these names, from migrationSql("before-1.7").
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

const tables = renamed(withoutForeignKeys(before17(BETTER_AUTH_SQLITE)), naming);
await execD1(tables);
await execD1(
  betterAuthSchemaStorage({ dialect: "d1", db: env.DB, ...naming }).migrationSql("before-1.7"),
);

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
