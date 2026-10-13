import { applyD1Migrations, env } from "cloudflare:test";
import { betterAuthSchemaStorage } from "@authtempo/compat-better-auth";
import { expect, it } from "vitest";
import betterAuthSqlite from "../../../compat-better-auth/test/fixtures/better-auth-1.7.2.sqlite.sql?raw";
import { runImport } from "../../worker/src/run.js";
import identities from "../fixtures/supabase-identities.csv?raw";
import users from "../fixtures/supabase-users.csv?raw";

/**
 * `TARGET=compat` serves Better Auth's default table and column names only
 * (I-2 of the plan 9b2 final review). An app with custom names has no Worker
 * path yet. This file pins that the Worker refuses such a table set before
 * any write, so it never writes the wrong columns.
 *
 * The tables are the SQLite counterpart of the compat package's recorded
 * consumer-i fixture (`consumer-i-snake.postgres.sql`): Better Auth's own
 * SQLite schema with snake_case columns, the default table names, and no
 * `account.issuer` (tables from before 1.7). It is the rule of `renamed` and
 * `before17` in `packages/compat-better-auth/test/d1/sql.ts`; every Better
 * Auth table name is one lower-case word, so snake_case leaves the table
 * names as they are. The compat migration for these names follows, as the
 * compat package's own snake test applies it.
 */
const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const schema = betterAuthSqlite
  .replace('"issuer" text not null, ', "")
  .replace(/create unique index "account_issuer_accountId_uidx"[^;]*;/, "")
  .replace(/"(\w+)"/g, (_, name: string) => `"${snake(name)}"`);
const statements = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

await env.DB.batch(statements(schema).map((s) => env.DB.prepare(s)));
await env.DB.batch(
  statements(
    betterAuthSchemaStorage({ dialect: "d1", db: env.DB, casing: "snake" }).migrationSql(
      "before-1.7",
    ),
  ).map((s) => env.DB.prepare(s)),
);
// 0002, 0003, and 0004 are the same text for every naming.
await applyD1Migrations(
  env.DB,
  env.COMPAT_MIGRATIONS.filter(
    (m) => m.name.startsWith("0002") || m.name.startsWith("0003") || m.name.startsWith("0004"),
  ),
);

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM "${table}"`).first<number>("n")) ?? -1;

it("holds the snake_case tables with their compat migration", async () => {
  const cols = await env.DB.prepare(
    `SELECT name FROM pragma_table_info('account') ORDER BY cid`,
  ).all<{ name: string }>();
  expect(cols.results.map((c) => c.name)).toEqual(
    expect.arrayContaining(["account_id", "provider_id", "issuer"]),
  );
  // The compat package with the app's own naming accepts these tables.
  const own = betterAuthSchemaStorage({ dialect: "d1", db: env.DB, casing: "snake" }).storage;
  expect(await own.findOne("user", [{ field: "email", op: "eq", value: "ada@example.com" }])).toBe(
    null,
  );
});

it("refuses a custom-named table set with schema_mismatch before any write (TARGET=compat)", async () => {
  await expect(
    runImport(
      env.DB,
      {
        bundle: { provider: "supabase", files: { users, identities } },
        options: { formats: ["bcrypt"] },
      },
      "compat",
    ),
  ).rejects.toMatchObject({ code: "schema_mismatch" });
  expect([await count("user"), await count("account")]).toEqual([0, 0]);
});
