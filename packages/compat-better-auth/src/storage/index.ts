import { createPostgresAdapterOn, createPostgresLimiter } from "@tempo-auth/adapter-postgres";
import type { Sql } from "postgres";
import type { CompatDatabase } from "../types.js";
import {
  applyBetterAuthCompatMigrations,
  compatMigrationSql,
  postgresCompatReady,
} from "./migration.js";
import { type Names, type NamingOptions, resolveNames } from "./names.js";
import { compatStatements } from "./statements.js";

export interface PostgresSchemaStorageOptions extends NamingOptions {
  dialect: "postgres";
  /** A postgres.js client. With Drizzle, pass `db.$client` or use `drizzleAdapter`. */
  sql: Sql;
}

export type PostgresSchemaStorage = CompatDatabase & {
  readonly names: Names;
  /** The text of migration 0001 for these names. */
  migrationSql(): string;
  /** Runs migration 0001 when the database does not hold it. Safe on every deploy. */
  migrate(): Promise<string[]>;
};

/** Core's storage port, and the owned limiter, over the app's Better Auth tables (spec 16.2). */
export function betterAuthSchemaStorage(
  options: PostgresSchemaStorageOptions,
): PostgresSchemaStorage {
  const names = resolveNames(options);
  const st = compatStatements("postgres", names);
  return {
    kind: "tempo-auth-compat-database",
    dialect: "postgres",
    names,
    storage: createPostgresAdapterOn(options.sql, {
      statements: st,
      toStorageError: st.toStorageError,
      ready: postgresCompatReady(options.sql),
    }),
    limiter: createPostgresLimiter(options.sql),
    migrationSql: () => compatMigrationSql("postgres", names),
    migrate: () => applyBetterAuthCompatMigrations(options.sql, names),
  };
}
