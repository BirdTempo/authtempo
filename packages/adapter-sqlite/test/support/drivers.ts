import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { betterSqlite3 } from "../../src/better-sqlite3.js";
import type { SqliteDriver } from "../../src/index.js";
import { libsql } from "../../src/libsql.js";
import { nodeSqlite } from "../../src/node.js";

/** The drivers that run in the Node test run. Task 4 adds Bun and libSQL over HTTP. */
export const DRIVER_KINDS = ["node", "better-sqlite3", "libsql-file"] as const;
export type DriverKind = (typeof DRIVER_KINDS)[number];

export interface OpenDriver {
  driver: SqliteDriver;
  close(): void;
}

/** A new folder for database files, removed by the returned function. */
export function tempFolder(): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-sqlite-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Opens a database with one driver, as an app opens it, and wraps it with the
 * driver's entry. With no `file`, node and better-sqlite3 open `:memory:`, and
 * libSQL opens a new file in a temp folder (its client has no shared memory
 * database).
 */
export function openDriver(kind: DriverKind, file?: string): OpenDriver {
  switch (kind) {
    case "node": {
      const db = new DatabaseSync(file ?? ":memory:");
      return { driver: nodeSqlite(db), close: () => db.close() };
    }
    case "better-sqlite3": {
      const db = new Database(file ?? ":memory:");
      return { driver: betterSqlite3(db), close: () => db.close() };
    }
    case "libsql-file": {
      const own = file === undefined ? tempFolder() : null;
      const client = createClient({ url: `file:${file ?? join(own?.dir ?? "", "db.sqlite")}` });
      return {
        driver: libsql(client),
        close: () => {
          client.close();
          own?.remove();
        },
      };
    }
  }
}

export function closeDriver(d: OpenDriver): void {
  d.close();
}
