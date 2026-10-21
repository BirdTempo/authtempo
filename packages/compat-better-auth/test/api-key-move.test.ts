import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { apiKeyMoveSuite } from "./api-key-move-suite.js";
import { BETTER_AUTH_API_KEY_PG, BETTER_AUTH_PG } from "./fixtures.js";
import { freshBetterAuthSchema, migrateWithoutLock } from "./pg.js";

// Better Auth's own tables and its apikey table on a fresh Postgres schema, then the compat migrations.
apiKeyMoveSuite("Postgres", async () => {
  const pg = await freshBetterAuthSchema(`${BETTER_AUTH_PG}\n${BETTER_AUTH_API_KEY_PG}`);
  const database = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
  await migrateWithoutLock(pg.sql, database.names);
  return {
    database,
    async insertKey(row) {
      const cols = Object.keys(row);
      await pg.sql.unsafe(
        `INSERT INTO "apikey" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(row) as never[],
      );
    },
    close: () => pg.close(),
  };
});
