import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libsql } from "@authtempo/adapter-sqlite/libsql";
import { createClient } from "@libsql/client";
import { sqliteCompatSuite } from "./suite.js";

// The Better Auth tables on a libSQL file (plan 12n). Each open makes a new
// file in a new temp folder, and its close removes the folder. A libSQL
// memory database lives on one connection only, so a file takes its place.
await sqliteCompatSuite("libsql file", () => {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-compat-libsql-"));
  // One connection. `PRAGMA foreign_keys` holds for one connection only, and
  // the pool of @libsql/client 0.18.0 opens each new connection with the
  // keys off (lib-esm/sqlite3.js, read 2026-11-03).
  const client = createClient({ url: `file:${join(dir, "db.sqlite")}`, concurrency: 1 });
  return {
    driver: libsql(client),
    exec: async (text) => {
      await client.executeMultiple(text);
    },
    close: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
