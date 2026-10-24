import { createD1AdapterOn, createD1Limiter } from "@authtempo/adapter-d1";
import {
  createD1AdapterOn as createD1AdapterOnSeam,
  createD1Limiter as createD1LimiterOnSeam,
} from "@authtempo/adapter-d1/seam";
import { createPostgresAdapterOn, createPostgresLimiter } from "@authtempo/adapter-postgres";
import { integerProbe, SQLITE_BOUND_PARAMS, type SqliteDriver } from "@authtempo/adapter-sqlite";
import type { Sql } from "postgres";
import type { CompatDatabase } from "../types.js";
import {
  applyBetterAuthCompatMigrations,
  applyBetterAuthCompatSqliteMigrations,
  compatMigrationSql,
  d1CompatPing,
  d1CompatReady,
  postgresCompatPing,
  postgresCompatReady,
  type SqliteVariant,
} from "./migration.js";
import { type Names, type NamingOptions, resolveNames } from "./names.js";
import { registerRawRead } from "./raw.js";
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

export interface SqliteSchemaStorageOptions extends Omit<NamingOptions, "pgSchema"> {
  dialect: "sqlite";
  /** A driver entry of `@authtempo/adapter-sqlite` over the database that the app opened (plan 12g). */
  driver: SqliteDriver;
  /** "before-1.7" for tables with no `account.issuer` column. The default is "1.7". */
  variant?: SqliteVariant;
}

export type SqliteSchemaStorage = CompatDatabase & {
  readonly names: Names;
  /** The text of migration 0001 for these names, as on D1. */
  migrationSql(variant?: SqliteVariant): string;
  /** Runs the compat migrations that the database does not hold, in their variant. Safe on every start. */
  migrate(): Promise<string[]>;
};

/** The adapter's own parameter type. Without workers-types it is `any`, so the structural binding passes. */
type D1 = Parameters<typeof createD1AdapterOn>[0];

/** Core's storage port, and the owned limiter, over the app's Better Auth tables (spec 16.2). */
export function betterAuthSchemaStorage(
  options: PostgresSchemaStorageOptions,
): PostgresSchemaStorage;
export function betterAuthSchemaStorage(options: D1SchemaStorageOptions): D1SchemaStorage;
export function betterAuthSchemaStorage(options: SqliteSchemaStorageOptions): SqliteSchemaStorage;
export function betterAuthSchemaStorage(
  options: PostgresSchemaStorageOptions | D1SchemaStorageOptions | SqliteSchemaStorageOptions,
): PostgresSchemaStorage | D1SchemaStorage | SqliteSchemaStorage {
  const names = resolveNames(options);
  if (options.dialect === "sqlite") {
    // The D1 code over the SQLite seam of plan 12g: the same statements, the
    // same undo log, the same readiness check. Before the check, the handle
    // must read integers as numbers, as on the core SQLite adapter. The ping
    // runs that check first (ruling 27 of the 12g lane), then the D1 ping
    // over the seam (ruling 26).
    const { driver } = options;
    const variant = options.variant ?? "1.7";
    const st = compatStatements("sqlite", names);
    const sent = { statements: 0, ready: 0 };
    const probe = integerProbe(driver.db, sent);
    const compatReady = d1CompatReady(driver.db, names, sent);
    const compatPing = d1CompatPing(driver.db, names, sent);
    const sqlite: SqliteSchemaStorage = {
      kind: "authtempo-compat-database",
      dialect: "sqlite",
      names,
      storage: createD1AdapterOnSeam(driver.db, {
        statements: st,
        toStorageError: st.toStorageError,
        ready: async () => {
          await probe();
          await compatReady();
        },
        ping: async () => {
          await probe();
          await compatPing();
        },
        sent,
        boundParams: SQLITE_BOUND_PARAMS,
      }),
      limiter: createD1LimiterOnSeam(driver.db),
      migrationSql: (v?: SqliteVariant) => compatMigrationSql("sqlite", names, v ?? variant),
      migrate: () => applyBetterAuthCompatSqliteMigrations(driver, names, variant),
    };
    registerRawRead(sqlite, async (q) => (await driver.db.prepare(q).all()).results);
    return sqlite;
  }
  if (options.dialect === "d1") {
    const st = compatStatements("sqlite", names);
    const db = options.db as unknown as D1;
    // One count holds the statements and the ready check. So the call budget
    // of the operator session calls sees its queries (ruling 37 of plan 12f).
    const sent = { statements: 0, ready: 0 };
    const d1: D1SchemaStorage = {
      kind: "authtempo-compat-database",
      dialect: "d1",
      names,
      storage: createD1AdapterOn(db, {
        statements: st,
        toStorageError: st.toStorageError,
        ready: d1CompatReady(options.db, names, sent),
        ping: d1CompatPing(options.db, names, sent),
        sent,
      }),
      limiter: createD1Limiter(db),
      migrationSql: (variant?: SqliteVariant) => compatMigrationSql("sqlite", names, variant),
    };
    const binding = options.db as unknown as {
      prepare(q: string): { all(): Promise<{ results: Record<string, unknown>[] }> };
    };
    registerRawRead(d1, async (q) => (await binding.prepare(q).all()).results);
    return d1;
  }
  const st = compatStatements("postgres", names);
  const sql = options.sql;
  const pg: PostgresSchemaStorage = {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    names,
    storage: createPostgresAdapterOn(sql, {
      statements: st,
      toStorageError: st.toStorageError,
      ready: postgresCompatReady(sql),
      ping: postgresCompatPing(sql),
    }),
    limiter: createPostgresLimiter(sql),
    migrationSql: () => compatMigrationSql("postgres", names),
    migrate: () => applyBetterAuthCompatMigrations(sql, names),
  };
  registerRawRead(pg, async (q) => [...(await sql.unsafe(q))] as Record<string, unknown>[]);
  return pg;
}
