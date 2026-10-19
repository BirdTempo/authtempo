import {
  applyPostgresMigrations,
  createPostgresAdapter,
  MIGRATIONS,
  readPostgresShape,
} from "@authtempo/adapter-postgres";
import { betterAuthSchemaStorage, COMPAT_MIGRATION_NAMES } from "@authtempo/compat-better-auth";
import type { StorageAdapter } from "@authtempo/core";
import { type LiveShape, META_TABLE, SCHEMA_VERSION_KEY } from "@authtempo/core/sql";
import postgres, { type Sql } from "postgres";
import { Stop } from "../errors.js";
import { describeUrl } from "../output.js";

/** Postgres SQLSTATE for "undefined table": the migrations never ran. */
const UNDEFINED_TABLE = "42P01";
/**
 * The meta key of the mapping version of the compatibility package (its
 * src/storage/migration.ts, which does not export it). The D1 seam reads the
 * same constant, so both targets name one key (plan 11f Task 5).
 */
export const COMPAT_META_KEY = "compat_better_auth";
/** The table where adapter-postgres records each applied migration (its src/migrations.ts). */
const MIGRATIONS_TABLE = "ta_migrations";

/** The names of core's Postgres migrations, in order, from the adapter that this CLI bundles. */
export const CORE_MIGRATIONS: readonly string[] = MIGRATIONS.map((m) => m.name);

/**
 * The names of the compat migrations, in order, from the compatibility
 * package that this CLI bundles. Its Postgres runner and its `migrations/d1/`
 * files carry the same names, so one list serves both dialects.
 */
export const compatMigrationNames = (): string[] => [...COMPAT_MIGRATION_NAMES];

/**
 * A driver error as a person may see it (spec 19): `storage: <code> at
 * <host:port/name>`. The code is the SQLSTATE of a Postgres error or the
 * errno code of a network error. The message of the driver is not printed:
 * postgres.js names the user in an auth failure, and spec 19 names a
 * database by its host, its port, and its name only.
 */
export function storageFailure(e: unknown, url: string): string {
  return `storage: ${storageCode(e)} at ${describeUrl(url)}`;
}

/**
 * The code of a driver error alone: the SQLSTATE or the errno code, else
 * `an error`. `info` prints it with no host (plan 11c2): a support report
 * goes into a public issue.
 */
export function storageCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "an error";
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
  /** The raw text of `ta_meta.schema_version`, or null when it is missing. The version gate reads it. */
  schemaVersionText(): Promise<string | null>;
  /** The mapping version of the compatibility package, 0 when it is missing. */
  compatVersion(): Promise<number>;
  /** The raw text of the compat mapping version, or null when it is missing. `check` reads it (plan 11c2). */
  compatText(): Promise<string | null>;
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
    schemaVersionText: () => readMeta(sql, SCHEMA_VERSION_KEY),
    async compatVersion() {
      return Number((await readMeta(sql, COMPAT_META_KEY)) ?? "0");
    },
    compatText: () => readMeta(sql, COMPAT_META_KEY),
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

/**
 * The live table shape of the database at `url` (plan 11c2): one connection,
 * `readPostgresShape` of the adapter, then the close. A driver error stops
 * the run with `storageFailure` (exit 2), as the schema version read does.
 */
export async function readPostgresLiveShape(url: string): Promise<LiveShape> {
  const sql: Sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await readPostgresShape(sql);
  } catch (e) {
    throw new Stop(storageFailure(e, url));
  } finally {
    await sql.end({ timeout: 5 });
  }
}
