import { applyD1Migrations, env } from "cloudflare:test";
import betterAuthSql from "../../../packages/compat-better-auth/test/fixtures/better-auth-1.7.2.sqlite.sql?raw";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Better Auth 1.7.2's own SQLite SQL, as recorded, with its foreign keys, then compat migration 0001.
// The split on ";" is safe while the recorded SQL has no ";" inside a string literal.
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
  // One account that predates migration 0001, with Better Auth's columns only. The migration
  // fills its ta columns; the test "signs in a user whose rows predate migration 0001" reads them.
  await env.BA_DB.batch([
    env.BA_DB.prepare(
      `INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES ('ba-pre-u','Pre','pre-0001@example.com',1,NULL,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z')`,
    ),
    env.BA_DB.prepare(
      `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('ba-pre-cred','local:credential','ba-pre-u','credential','ba-pre-u','8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z')`,
    ),
  ]);
}
await applyD1Migrations(env.BA_DB, env.COMPAT_MIGRATIONS);
