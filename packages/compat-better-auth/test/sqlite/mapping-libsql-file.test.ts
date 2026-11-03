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
  // The client keeps the default pool, as an app does, and as the libSQL
  // file test of adapter-sqlite does. A probe of 2026-11-03 read
  // `PRAGMA foreign_keys` as 1 on a fresh connection and on a second pool
  // connection, with no pragma call. It ran on darwin-arm64 with Node
  // 26.10.0, @libsql/client 0.18.0, and libsql 0.5.29.
  const client = createClient({ url: `file:${join(dir, "db.sqlite")}` });
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
