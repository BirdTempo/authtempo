import { applyD1Migrations, env } from "cloudflare:test";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { apiKeyMoveSuite } from "../api-key-move-suite.js";
import { BETTER_AUTH_API_KEY_SQLITE, BETTER_AUTH_SQLITE } from "../fixtures.js";
import { sqlNames } from "./mapping-suite.js";
import { execD1 } from "./schema.js";

// Better Auth's own SQLite SQL and its apikey table, then the shipped compat migrations.
await execD1(BETTER_AUTH_SQLITE);
await execD1(BETTER_AUTH_API_KEY_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

const { truncate } = sqlNames({});

// SQLite keeps a boolean as 0 or 1 and a date as ISO text, as Better Auth writes them on D1.
const encode = (v: unknown) =>
  typeof v === "boolean" ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v;

apiKeyMoveSuite("D1", async () => {
  // One database per file: each test starts from empty tables.
  await truncate();
  await env.DB.prepare(`DELETE FROM "apikey"`).run();
  return {
    database: betterAuthSchemaStorage({ dialect: "d1", db: env.DB }),
    async insertKey(row) {
      const cols = Object.keys(row);
      await env.DB.prepare(
        `INSERT INTO "apikey" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
        .bind(...Object.values(row).map(encode))
        .run();
    },
    close: async () => {},
  };
});
