import { createD1AdapterOn, createD1Limiter } from "@authtempo/adapter-d1";
import { createPostgresAdapterOn, createPostgresLimiter } from "@authtempo/adapter-postgres";
import type { Sql } from "postgres";
import type { CompatDatabase } from "../types.js";
import {
  applyBetterAuthCompatMigrations,
  compatMigrationSql,
  d1CompatReady,
  postgresCompatReady,
  type SqliteVariant,
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
  /** Runs migrations 0001 to 0005 when the database does not hold them. Safe on every deploy. */
  migrate(): Promise<string[]>;
};

/** The part of a D1 binding this package passes on. Typed by structure, because the source compiles without @cloudflare/workers-types. */
export interface D1DatabaseLike {
  prepare(query: string): unknown;
  batch(statements: never[]): Promise<unknown>;
}

export interface D1SchemaStorageOptions extends Omit<NamingOptions, "pgSchema"> {
  dialect: "d1";
  db: D1DatabaseLike;
}

export type D1SchemaStorage = CompatDatabase & {
  readonly names: Names;
  /**
   * The text of migration 0001 for these names. Save it in the app's
   * migrations directory when the names are not Better Auth's defaults.
   * "before-1.7" for tables with no `account.issuer` column. Apply the
   * shipped 0002 file after it: 0002 is the same for every naming.
   */
  migrationSql(variant?: SqliteVariant): string;
};

/** The adapter's own parameter type. Without workers-types it is `any`, so the structural binding passes. */
type D1 = Parameters<typeof createD1AdapterOn>[0];

/** Core's storage port, and the owned limiter, over the app's Better Auth tables (spec 16.2). */
export function betterAuthSchemaStorage(
  options: PostgresSchemaStorageOptions,
): PostgresSchemaStorage;
export function betterAuthSchemaStorage(options: D1SchemaStorageOptions): D1SchemaStorage;
export function betterAuthSchemaStorage(
  options: PostgresSchemaStorageOptions | D1SchemaStorageOptions,
): PostgresSchemaStorage | D1SchemaStorage {
  const names = resolveNames(options);
  if (options.dialect === "d1") {
    const st = compatStatements("sqlite", names);
    const db = options.db as unknown as D1;
    return {
      kind: "authtempo-compat-database",
      dialect: "d1",
      names,
      storage: createD1AdapterOn(db, {
        statements: st,
        toStorageError: st.toStorageError,
        ready: d1CompatReady(options.db, names),
      }),
      limiter: createD1Limiter(db),
      migrationSql: (variant?: SqliteVariant) => compatMigrationSql("sqlite", names, variant),
    };
  }
  const st = compatStatements("postgres", names);
  return {
    kind: "authtempo-compat-database",
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
