import {
  applyMysqlMigrations,
  createMysqlAdapter,
  MYSQL_MIGRATIONS,
  readMysqlShape,
} from "@authtempo/adapter-mysql";
import type { StorageAdapter } from "@authtempo/core";
import { type LiveShape, META_TABLE, MYSQL, SCHEMA_VERSION_KEY } from "@authtempo/core/sql";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { Stop } from "../errors.js";
import { describeUrl } from "../output.js";
import { requireMysqlTransport, urlSecrets } from "../transport.js";
import { storageCode } from "./postgres.js";

/** MySQL error 1146, "Table doesn't exist": the migrations never ran. */
const NO_SUCH_TABLE = 1146;

const isNoSuchTable = (e: unknown) => (e as { errno?: unknown } | null)?.errno === NO_SUCH_TABLE;

/** The names of core's MySQL migrations, in order, from the adapter that this CLI bundles. */
export const MYSQL_CORE_MIGRATIONS: readonly string[] = MYSQL_MIGRATIONS.map((m) => m.name);

/**
 * The start of the runner's own message when another runner holds the
 * named lock (adapter-mysql src/migrations.ts). It names no value, so it
 * prints as it is.
 */
const LOCK_HELD = "authtempo migrations: the MySQL lock ";

/**
 * The URL query keys that the CLI passes to mysql2. mysql2 3.24.5 prints
 * an unknown key on stderr with console.error, past the scrub list
 * (lib/connection_config.js:88-96, read 2026-10-21). Other keys of mysql2,
 * such as `debug`, `charset`, or `dateStrings`, print packets or change the values that
 * the adapter reads. So the seam refuses each other key before `createPool`.
 */
const URL_KEYS = new Set(["ssl", "connectTimeout"]);

/** The step count of each migration of the adapter that this CLI bundles. */
const STEPS = new Map(MYSQL_MIGRATIONS.map((m) => [m.name, m.statements.length]));

/**
 * The MySQL seam of the CLI (plan 12g Task 6): the one module that names
 * mysql2. It has the members of `PostgresSeam` that `migrate` and `check`
 * call, and the live shape read.
 */
export interface MysqlSeam {
  /** `ta_meta.schema_version`, or null when it is missing. */
  schemaVersion(): Promise<number | null>;
  /** The raw text of `ta_meta.schema_version`, or null when it is missing. The version gate reads it. */
  schemaVersionText(): Promise<string | null>;
  /**
   * The names of the migrations whose every step `ta_migrations` holds, or
   * none when the table is missing. A migration that stopped at a step is
   * not applied: the next run resumes it. A name that this CLI does not know
   * counts as applied: a newer CLI wrote it.
   */
  appliedCore(): Promise<string[]>;
  /** `applyMysqlMigrations`: its named lock keeps two runs at once safe. */
  applyCore(): Promise<string[]>;
  /** Core's tables (`@authtempo/adapter-mysql`). */
  coreStorage(): StorageAdapter;
  /** The live table shape (`readMysqlShape`). */
  liveShape(): Promise<LiveShape>;
  /** One round trip: mysql2 connects on the first query. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens a pool of one connection on `url`, after `requireMysqlTransport`. The
 * URL's password goes to `addSecret` before the first line. Every driver
 * error leaves as `storage: <code> at <host:port/name>`: the code is mysql2's
 * `code`, such as `ER_ACCESS_DENIED_ERROR`, and never its message, which
 * names the user.
 */
export function openMysql(url: string, addSecret: (value: string) => void): MysqlSeam {
  for (const s of urlSecrets(url)) addSecret(s);
  requireMysqlTransport(url);
  // requireMysqlTransport parsed the URL, so this parse cannot throw. The
  // message names no key: a mistyped key can hold a secret.
  for (const key of new URL(url).searchParams.keys())
    if (!URL_KEYS.has(key))
      throw new Stop(
        `the connection string of mysql has a query key that the CLI does not take; it takes ${[...URL_KEYS].join(", ")}`,
      );
  const where = describeUrl(url);
  const fail = (e: unknown): never => {
    if (e instanceof Stop) throw e;
    if (e instanceof Error && e.message.startsWith(LOCK_HELD)) throw new Stop(e.message);
    throw new Stop(`storage: ${storageCode(e)} at ${where}`);
  };
  let pool: Pool;
  try {
    // One connection: the migrations run one at a time on the connection
    // that holds the named lock. timezone "Z", as the adapter tests open it.
    pool = mysql.createPool({ uri: url, connectionLimit: 1, timezone: "Z" });
  } catch (e) {
    return fail(e);
  }
  const readMeta = async (key: string): Promise<string | null> => {
    try {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT ${MYSQL.quote("value")} FROM ${MYSQL.quote(META_TABLE)} WHERE ${MYSQL.quote("key")} = ?`,
        [key],
      );
      const v = rows[0]?.value;
      return v === undefined || v === null ? null : String(v);
    } catch (e) {
      if (isNoSuchTable(e)) return null;
      return fail(e);
    }
  };
  return {
    async schemaVersion() {
      const v = await readMeta(SCHEMA_VERSION_KEY);
      return v === null ? null : Number(v);
    },
    schemaVersionText: () => readMeta(SCHEMA_VERSION_KEY),
    async appliedCore() {
      try {
        const [rows] = await pool.query<RowDataPacket[]>(
          "SELECT `name`, COUNT(*) AS steps FROM `ta_migrations` GROUP BY `name`",
        );
        return rows
          .filter((r) => {
            const want = STEPS.get(String(r.name));
            return want === undefined || Number(r.steps) >= want;
          })
          .map((r) => String(r.name));
      } catch (e) {
        if (isNoSuchTable(e)) return [];
        return fail(e);
      }
    },
    applyCore: () => applyMysqlMigrations(pool).catch(fail),
    coreStorage: () => createMysqlAdapter(pool),
    liveShape: () => readMysqlShape(pool).catch(fail),
    async ping() {
      try {
        await pool.query("SELECT 1");
      } catch (e) {
        fail(e);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
