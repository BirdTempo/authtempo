import { applyD1Migrations, env } from "cloudflare:test";
import betterAuthSql from "../../../packages/compat-better-auth/test/fixtures/better-auth-1.7.2.sqlite.sql?raw";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Better Auth 1.7.2's own SQLite SQL, as recorded, with its foreign keys, then compat migration 0001.
// The foreign keys stay on: the sign-ups prove that the user row comes before the account row.
const exists = await env.BA_DB.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'",
).first();
if (!exists) {
  const statements = betterAuthSql
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await env.BA_DB.batch(statements.map((s) => env.BA_DB.prepare(s)));
}
await applyD1Migrations(env.BA_DB, env.COMPAT_MIGRATIONS);
