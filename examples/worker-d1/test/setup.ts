import { applyD1Migrations, env } from "cloudflare:test";

// The migrations of @authtempo/adapter-d1 on the local D1 database, as
// `wrangler d1 migrations apply` writes them on a real one.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
