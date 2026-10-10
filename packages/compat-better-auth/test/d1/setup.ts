import { applyD1Migrations, env } from "cloudflare:test";
import { BETTER_AUTH_SQLITE, withoutForeignKeys } from "../fixtures.js";

// Better Auth's own SQLite SQL first (without the foreign keys: core's
// conformance suite writes rows with no parent), then the shipped compat migration.
const exists = await env.DB.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'",
).first();
if (!exists) {
  const statements = withoutForeignKeys(BETTER_AUTH_SQLITE)
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);
