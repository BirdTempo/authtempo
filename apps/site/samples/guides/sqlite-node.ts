import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  applySqliteMigrations,
  createSqliteAdapter,
  createSqliteLimiter,
} from "@authtempo/adapter-sqlite";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";
import { createAuth, type MailPort } from "@authtempo/core";

/**
 * authtempo on a SQLite file through `node:sqlite` (Node 22.13 or newer).
 * The storage and the owned limiter use one handle. Call `close` when the
 * process stops.
 */
export async function authOnSqlite(path: string, mail: MailPort, secret: string) {
  // The file holds sealed secrets and password hashes. Make it with mode 0600
  // before SQLite opens it: SQLite makes a new file with mode 0644, less the
  // umask. A file that exists keeps its mode.
  closeSync(openSync(path, "a", 0o600));
  const db = new DatabaseSync(path);
  // The default busy timeout of node:sqlite is 0 ms: a second writer then
  // gets "database is locked" at once.
  db.exec("PRAGMA busy_timeout = 5000");
  const driver = nodeSqlite(db);
  await applySqliteMigrations(driver);
  const auth = createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret,
    mail,
    storage: createSqliteAdapter(driver),
    limiter: createSqliteLimiter(driver),
  });
  return { auth, close: () => db.close() };
}
