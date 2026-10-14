import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  applyPostgresMigrations,
  createPostgresAdapter,
  MIGRATIONS,
} from "@authtempo/adapter-postgres";
import { betterAuthSchemaStorage } from "@authtempo/compat-better-auth";
import type { StorageAdapter } from "@authtempo/core";
import { META_TABLE, SCHEMA_VERSION_KEY } from "@authtempo/core/sql";
import postgres, { type Sql } from "postgres";

/** Postgres SQLSTATE for "undefined table": the migrations never ran. */
const UNDEFINED_TABLE = "42P01";
/** The meta key of the mapping version of the compatibility package (its src/storage/migration.ts). */
const COMPAT_META_KEY = "compat_better_auth";
/** The table where adapter-postgres records each applied migration (its src/migrations.ts). */
const MIGRATIONS_TABLE = "ta_migrations";

/** The names of core's Postgres migrations, in order, from the adapter that this CLI bundles. */
export const CORE_MIGRATIONS: readonly string[] = MIGRATIONS.map((m) => m.name);

const resolver = createRequire(import.meta.url);

/**
 * The names of the compat migrations, from the files that the compatibility
 * package ships in `migrations/d1/`. Its Postgres migrations carry the same
 * names, so one list serves both dialects.
 */
export function compatMigrationNames(): string[] {
  const dir = join(dirname(resolver.resolve("@authtempo/compat-better-auth")), "../migrations/d1");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => f.slice(0, -".sql".length));
}

const isUndefinedTable = (e: unknown) => (e as { code?: unknown } | null)?.code === UNDEFINED_TABLE;

/** A value of `ta_meta`, or null when the table or the row is missing. Any other error passes through. */
async function readMeta(sql: Sql, key: string): Promise<string | null> {
  try {
    const rows = await sql.unsafe<{ value: string }[]>(
      `SELECT value FROM ${META_TABLE} WHERE key = $1`,
      [key],
    );
    return rows[0]?.value ?? null;
  } catch (e) {
    if (isUndefinedTable(e)) return null;
    throw e;
  }
}

/**
 * The Postgres seam of the CLI (spec 19): the one module that names
 * postgres.js. A command asks it for storage, the schema version, and the
 * migrations, and never sees the driver.
 */
export interface PostgresSeam {
  /** `ta_meta.schema_version` (the row with key `schema_version`), or null when it is missing. */
  schemaVersion(): Promise<number | null>;
  /** The mapping version of the compatibility package, 0 when it is missing. */
  compatVersion(): Promise<number>;
  /** The names in `ta_migrations`, or none when the table is missing. */
  appliedCore(): Promise<string[]>;
  /** `applyPostgresMigrations`: its advisory lock keeps two runs at once safe. */
  applyCore(): Promise<string[]>;
  /** The compat migrations (`betterAuthSchemaStorage(...).migrate()`), under the same lock. */
  applyCompat(): Promise<string[]>;
  /** Core's tables (`@authtempo/adapter-postgres`). */
  coreStorage(): StorageAdapter;
  /** The Better Auth 1.7 tables (`@authtempo/compat-better-auth`). */
  compatStorage(): StorageAdapter;
  /**
   * One round trip. postgres.js connects on the first query, so without it a
   * refused connection fails inside the import and reads as an import error
   * with "records before it may be written", when nothing was written.
   */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function openPostgres(url: string, max: number): PostgresSeam {
  const sql: Sql = postgres(url, { max, onnotice: () => {} });
  return {
    async schemaVersion() {
      const v = await readMeta(sql, SCHEMA_VERSION_KEY);
      return v === null ? null : Number(v);
    },
    async compatVersion() {
      return Number((await readMeta(sql, COMPAT_META_KEY)) ?? "0");
    },
    async appliedCore() {
      try {
        const rows = await sql.unsafe<{ name: string }[]>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
        return rows.map((r) => r.name);
      } catch (e) {
        if (isUndefinedTable(e)) return [];
        throw e;
      }
    },
    applyCore: () => applyPostgresMigrations(sql),
    applyCompat: () => betterAuthSchemaStorage({ dialect: "postgres", sql }).migrate(),
    coreStorage: () => createPostgresAdapter(sql),
    compatStorage: () => betterAuthSchemaStorage({ dialect: "postgres", sql }).storage,
    async ping() {
      await sql`SELECT 1`;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
