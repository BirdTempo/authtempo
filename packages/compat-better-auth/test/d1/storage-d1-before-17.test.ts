import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { d1MappingSuite } from "./mapping-suite.js";
import { execD1 } from "./schema.js";
import { before17 } from "./sql.js";

// The second D1 flavor as it ships (plan 9h, index line 187). Until plan 9h
// no D1 suite applied the files of migrations/d1-before-1.7/: the snake
// suite runs the before-1.7 text of migrationSql and the string DDL of
// 0002 to 0005, and the migration-file test ties the file texts to that DDL.
// Here: Better Auth's own SQLite SQL with its seven foreign keys, made into
// tables from before 1.7 (no account.issuer and no index on it), then the
// five shipped files through applyD1Migrations, then core's conformance
// suite and the D1 mapping tests.
await execD1(before17(BETTER_AUTH_SQLITE));
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS_BEFORE_17);

it("applies the five shipped d1-before-1.7 files: account gains issuer with its unique key, and ta_meta names schema version 8", async () => {
  expect(env.COMPAT_MIGRATIONS_BEFORE_17).toHaveLength(5);
  const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info('account')`).all<{
    name: string;
  }>();
  expect(cols.results.map((c) => c.name)).toContain("issuer");
  const index = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_account__issuer__account_id'`,
  ).first("name");
  expect(index).toBe("ux_account__issuer__account_id");
  const meta = await env.DB.prepare("SELECT key, value FROM ta_meta ORDER BY key").all<{
    key: string;
    value: string;
  }>();
  expect(meta.results).toEqual([
    { key: "compat_better_auth", value: "5" },
    { key: "schema_version", value: "8" },
  ]);
});

d1MappingSuite("tables from before 1.7, through the shipped d1-before-1.7 files", {});
