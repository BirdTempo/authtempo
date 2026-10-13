// Applies the migrations of @authtempo/adapter-postgres. Run it on each
// deploy, before the new Worker serves a request:
//   DATABASE_URL="postgres://…" node scripts/migrate.ts
// It is safe to run twice, also from two machines at once (adapter README).
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: set DATABASE_URL to the connection string of your database");
  process.exit(2);
}
const sql = postgres(url, { max: 1 });
try {
  await applyPostgresMigrations(sql);
  console.log("migrate: done");
} finally {
  await sql.end({ timeout: 5 });
}
