import { closeSync, openSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  applySqliteMigrations,
  createSqliteAdapter,
  readSqliteShape,
  SQLITE_MIGRATIONS,
  type SqliteDriver,
} from "@authtempo/adapter-sqlite";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";
import { betterAuthSchemaStorage } from "@authtempo/compat-better-auth";
import type { StorageAdapter } from "@authtempo/core";
import { type LiveShape, META_TABLE, SCHEMA_VERSION_KEY } from "@authtempo/core/sql";
import { Stop } from "../errors.js";
import { describeUrl } from "../output.js";
import { type LibsqlTarget, requireLibsqlTransport, urlSecrets } from "../transport.js";
import { COMPAT_META_KEY } from "./postgres.js";

/** The table where `applySqliteMigrations` records each applied migration (adapter-sqlite src/migrations.ts). */
const MIGRATIONS_TABLE = "ta_migrations";
/**
 * Milliseconds that a node:sqlite handle waits for the write lock of another
 * process. The default is 0, so a second `migrate` on one file would fail at
 * once (adapter-sqlite README, "The busy timeout of node:sqlite and bun:sqlite").
 */
const BUSY_TIMEOUT_MS = 5000;

/** The names of core's SQLite migrations, in order, from the adapter that this CLI bundles. */
export const SQLITE_CORE_MIGRATIONS: readonly string[] = SQLITE_MIGRATIONS.map((m) => m.name);

/** A SQLite file by its path, or a libSQL server by its URL and its token. */
export type SqliteSource = { file: string } | { url: string; authToken: string | null };

/**
 * The code of a driver error. It is the error's `code` when that is a plain
 * code, such as node:sqlite `ERR_SQLITE_ERROR` or libSQL `SERVER_ERROR`.
 * Else it is the code of its cause, such as a refused connection of fetch.
 * Else it is `an error`. The message is never printed: a libSQL server
 * message can quote a statement.
 */
function codeOf(e: unknown): string {
  const plain = (x: unknown) => {
    const code = (x as { code?: unknown } | null)?.code;
    return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null;
  };
  return plain(e) ?? plain((e as { cause?: unknown } | null)?.cause) ?? "an error";
}

/** "no such table" of SQLite, by the text of the driver: no driver gives it a code of its own. */
const isNoSuchTable = (e: unknown) => /no such table/.test(String((e as Error | null)?.message));

/**
 * The parser of a libSQL URL as `@libsql/client` 0.18.0 reads it.
 * `createClient` of Node calls `expandConfig(config, true)` of
 * `@libsql/core`, which reads the URL with `parseUri` (lib-esm/node.js,
 * config.js, and uri.js, read 2026-10-21). So the transport rule judges the
 * scheme, the TLS flag, and the host that the driver connects to. A URL that
 * the driver refuses stops with its code, never its message, which quotes
 * the URL. The seam loads `@libsql/core` only for a URL.
 */
export async function libsqlParser(): Promise<(url: string) => LibsqlTarget> {
  const { expandConfig } = await import("@libsql/core/config");
  const { parseUri } = await import("@libsql/core/uri");
  return (url) => {
    try {
      const c = expandConfig({ url }, true);
      return {
        scheme: c.scheme,
        tls: c.tls,
        host: c.authority?.host ?? null,
        queryKeys: (parseUri(url).query?.pairs ?? []).map((p) => p.key),
      };
    } catch (e) {
      throw new Stop(`the libSQL URL is not valid: ${codeOf(e)}`);
    }
  };
}

/**
 * The SQLite seam of the CLI (plan 12g Task 6): the one module that names
 * `node:sqlite` and `@libsql/client`. It has the members of `PostgresSeam`
 * that `migrate` and `check` call, the live shape read, and the compat run
 * of plan 12g Task 8b.
 */
export interface SqliteSeam {
  /** `ta_meta.schema_version`, or null when it is missing. */
  schemaVersion(): Promise<number | null>;
  /** The raw text of `ta_meta.schema_version`, or null when it is missing. The version gate reads it. */
  schemaVersionText(): Promise<string | null>;
  /** The raw text of the compat mapping version, or null when it is missing. `check` reads it. */
  compatText(): Promise<string | null>;
  /** The names in `ta_migrations`, or none when the table is missing. */
  appliedCore(): Promise<string[]>;
  /** `applySqliteMigrations`: each migration runs in one write transaction. */
  applyCore(): Promise<string[]>;
  /**
   * The compat migrations through `applyBetterAuthCompatSqliteMigrations`
   * (the `migrate()` of the compat SQLite storage), in the before-1.7 variant
   * when `before17` is true. Each one and its record run in one write
   * transaction. A migration that `ta_meta` records already is skipped.
   */
  applyCompat(before17: boolean): Promise<string[]>;
  /** Core's tables (`@authtempo/adapter-sqlite`). */
  coreStorage(): StorageAdapter;
  /** The live table shape (`readSqliteShape`). */
  liveShape(): Promise<LiveShape>;
  /** One round trip, so a refused connection stops before the first read. */
  ping(): Promise<void>;
  close(): Promise<void>;
  /** The database as a person may see it: the path of the file, or the host and the name of the URL. */
  readonly where: string;
}

/**
 * Opens the database of `source`. A file opens through `node:sqlite` (Node
 * 22.13 and later), which makes the file when it is missing, unless
 * `readOnly` is set (`check`, and a dry run of `migrate`). A URL first
 * passes `requireLibsqlTransport`, then opens through `@libsql/client`. The
 * seam loads both libSQL packages only for a URL. `addSecret` gets the URL's password and token
 * values before the first line. Every driver error leaves as `storage: <code>
 * at <where>`.
 */
export async function openSqlite(
  source: SqliteSource,
  addSecret: (value: string) => void,
  o: { readOnly?: boolean } = {},
): Promise<SqliteSeam> {
  let driver: SqliteDriver;
  let closeDriver: () => void;
  let where: string;
  if ("file" in source) {
    where = source.file;
    // getBuiltinModule loads node:sqlite only for this target, so no other command loads it.
    const { DatabaseSync: Database } = process.getBuiltinModule("node:sqlite") as {
      DatabaseSync: typeof DatabaseSync;
    };
    let db: DatabaseSync;
    try {
      // The file holds sealed secrets and password hashes. SQLite makes a new
      // file with mode 0644, less the umask, so the seam makes it with mode
      // 0600 first. A file that exists keeps its mode.
      if (o.readOnly !== true) closeSync(openSync(source.file, "a", 0o600));
      // A read-only open of a missing file fails (SQLITE_CANTOPEN) and makes no file.
      db = new Database(source.file, { readOnly: o.readOnly === true });
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    } catch (e) {
      throw new Stop(`storage: ${codeOf(e)} at ${where}`);
    }
    driver = nodeSqlite(db);
    closeDriver = () => db.close();
  } else {
    for (const s of urlSecrets(source.url)) addSecret(s);
    if (source.authToken !== null) addSecret(source.authToken);
    where = describeUrl(source.url);
    requireLibsqlTransport(source.url, await libsqlParser());
    const { createClient } = await import("@libsql/client");
    const { libsql } = await import("@authtempo/adapter-sqlite/libsql");
    let client: ReturnType<typeof createClient>;
    try {
      client = createClient(
        source.authToken === null
          ? { url: source.url }
          : { url: source.url, authToken: source.authToken },
      );
    } catch (e) {
      throw new Stop(`storage: ${codeOf(e)} at ${where}`);
    }
    driver = libsql(client);
    closeDriver = () => client.close();
  }
  const fail = (e: unknown): never => {
    if (e instanceof Stop) throw e;
    throw new Stop(`storage: ${codeOf(e)} at ${where}`);
  };
  const readMeta = async (key: string): Promise<string | null> => {
    try {
      const v = await driver.db
        .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
        .bind(key)
        .first("value");
      return v === null || v === undefined ? null : String(v);
    } catch (e) {
      if (isNoSuchTable(e)) return null;
      return fail(e);
    }
  };
  return {
    where,
    async schemaVersion() {
      const v = await readMeta(SCHEMA_VERSION_KEY);
      return v === null ? null : Number(v);
    },
    schemaVersionText: () => readMeta(SCHEMA_VERSION_KEY),
    compatText: () => readMeta(COMPAT_META_KEY),
    async appliedCore() {
      try {
        const rows = await driver.db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all();
        return rows.results.map((r) => String((r as { name: unknown }).name));
      } catch (e) {
        if (isNoSuchTable(e)) return [];
        return fail(e);
      }
    },
    applyCore: () => applySqliteMigrations(driver).catch(fail),
    applyCompat: (before17) =>
      betterAuthSchemaStorage({
        dialect: "sqlite",
        driver,
        variant: before17 ? "before-1.7" : "1.7",
      })
        .migrate()
        .catch(fail),
    coreStorage: () => createSqliteAdapter(driver),
    liveShape: () => readSqliteShape(driver).catch(fail),
    async ping() {
      try {
        await driver.db.prepare("SELECT 1").first();
      } catch (e) {
        fail(e);
      }
    },
    async close() {
      closeDriver();
    },
  };
}
