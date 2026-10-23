import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { copySsoSuite } from "./copy-sso-suite.js";
import { BETTER_AUTH_PG, BETTER_AUTH_SSO_PG, BETTER_AUTH_SSO_ROWS_PG } from "./fixtures.js";
import { freshBetterAuthSchema, migrateWithoutLock } from "./pg.js";

// Better Auth's own tables and rows on a fresh Postgres schema, then the compat migrations.
copySsoSuite("Postgres", async () => {
  const pg = await freshBetterAuthSchema(
    `${BETTER_AUTH_PG}\n${BETTER_AUTH_SSO_PG}\n${BETTER_AUTH_SSO_ROWS_PG}`,
  );
  const names = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }).names;
  await migrateWithoutLock(pg.sql, names);
  return {
    // Postgres has no statement counter: the D1 suite measures the budget.
    fresh: () => ({
      database: betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }),
      statements: () => null,
    }),
    close: () => pg.close(),
  };
});
