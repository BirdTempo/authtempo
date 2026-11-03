import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { betterSqlite3 } from "@authtempo/adapter-sqlite/better-sqlite3";
import { libsql } from "@authtempo/adapter-sqlite/libsql";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import readme from "../../README.md?raw";
import { foreignKeysSuite } from "./keys-suite.js";

// The foreign key tests of the Node runs (rulings 40 and 44 of plan 12n).
// These drivers open with the keys on, so each test turns them off as an app
// can. The bun:sqlite run is test/sqlite/bun/foreign-keys-bun.test.ts.

foreignKeysSuite("node:sqlite", {
  open: async (file) => {
    const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
    return {
      driver: nodeSqlite(db),
      exec: async (text) => {
        db.exec(text);
      },
      close: () => db.close(),
    };
  },
  oneConnection: true,
});

foreignKeysSuite("better-sqlite3", {
  open: async (file) => {
    const db = new Database(file);
    db.pragma("foreign_keys = OFF");
    return {
      driver: betterSqlite3(db),
      exec: async (text) => {
        db.exec(text);
      },
      close: () => db.close(),
    };
  },
  oneConnection: true,
});

// The client keeps its default pool, as an app does. The pragma of the app
// turns off the one connection that the pool holds after the open. The pool
// rolls back a BEGIN of `execute` when the call ends, and a transaction of
// the client holds a connection of its own. So no BEGIN of the app holds the
// storage's connection, and the BEGIN test does not run here.
foreignKeysSuite("libsql file", {
  open: async (file) => {
    const client = createClient({ url: `file:${file}` });
    await client.execute("PRAGMA foreign_keys = OFF");
    return {
      driver: libsql(client),
      exec: async (text) => {
        await client.executeMultiple(text);
      },
      close: () => client.close(),
    };
  },
  oneConnection: false,
});

// The README states the measure of the Bun of the dev dependencies. A new
// Bun version needs a new read of its default, so this fact then fails.
it("names the Bun version of the dev dependencies and the date of its read in the README", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { devDependencies: Record<string, string> };
  expect(readme.replace(/\s+/g, " ")).toContain(
    `\`bun:sqlite\` of Bun ${manifest.devDependencies.bun} opens with the keys off (read on 2026-11-03).`,
  );
});
