import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterSqlite3 } from "@authtempo/adapter-sqlite/better-sqlite3";
import { libsql } from "@authtempo/adapter-sqlite/libsql";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import readme from "../../README.md?raw";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { eq } from "../mapping-cases.js";
import { foreignKeysSuite, sessionsOf, twoUsers } from "./keys-suite.js";

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

/**
 * Marks the connection that serves it with a TEMP table and a TEMP trigger.
 * Each lives on that connection only, and the trigger refuses a user delete
 * there.
 */
const MARK_FIRST = `CREATE TEMP TABLE first_connection (x);
CREATE TEMP TRIGGER first_connection_delete BEFORE DELETE ON "user"
BEGIN SELECT RAISE(ABORT, 'a user delete on the first connection'); END;`;

/** On the connection that serves it: 1 when it holds the mark, and the value of PRAGMA foreign_keys. */
const WHERE = `SELECT (SELECT count(*) FROM temp.sqlite_master WHERE name = 'first_connection') AS first,
(SELECT foreign_keys FROM pragma_foreign_keys) AS keys`;

// A libSQL file client lends the connection that came back last. A call takes
// its connection before its first await (lib-esm/sqlite3.js of @libsql/client
// 0.18.0, read 2026-11-03). So two storage reads at once open a second
// connection, and the next calls run there. The storage never sets the keys
// on it, so only the libSQL default keeps the cascade there (ruling 57 of
// plan 12n). The test pins that default, and no change of the storage can
// fail it. A client version that opens a connection with the keys off fails it.
describe("the foreign keys on a second pooled libSQL connection (ruling 57 of plan 12n)", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("reads the keys at 1 and runs the cascade on a connection that the storage never set", async () => {
    dir = mkdtempSync(join(tmpdir(), "authtempo-compat-keys-"));
    const client = createClient({ url: `file:${join(dir, "db.sqlite")}` });
    try {
      await client.executeMultiple(BETTER_AUTH_SQLITE);
      const driver = libsql(client);
      const { storage, migrate } = betterAuthSchemaStorage({ dialect: "sqlite", driver });
      // The pool holds one connection so far, and the storage sets the keys there.
      await migrate();
      await client.executeMultiple(MARK_FIRST);
      await twoUsers(storage);
      const where = async () => {
        const row = (await client.execute(WHERE)).rows[0];
        return { first: Number(row?.first), keys: Number(row?.keys) };
      };
      expect(await where()).toEqual({ first: 1, keys: 1 });
      await Promise.all([
        storage.findOne("user", [eq("id", "u1")]),
        storage.findOne("user", [eq("id", "u2")]),
      ]);
      // The pool now lends the second connection, which has no mark.
      expect(await where()).toEqual({ first: 0, keys: 1 });
      // The trigger refuses a delete on the first connection, so this delete runs on another one.
      expect(await storage.transaction((tx) => tx.delete("user", [eq("id", "u1")]))).toBe(1);
      expect(await sessionsOf({ driver })).toEqual([0, 2]);
    } finally {
      client.close();
    }
  });
});

/** The version of `name` in the dev dependencies of the package. */
const devVersion = (name: string) =>
  (
    JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      devDependencies: Record<string, string>;
    }
  ).devDependencies[name];

// The README states the measure of the Bun of the dev dependencies. A new
// Bun version needs a new read of its default, so this fact then fails.
it("names the Bun version of the dev dependencies and the date of its read in the README", () => {
  expect(readme.replace(/\s+/g, " ")).toContain(
    `\`bun:sqlite\` of Bun ${devVersion("bun")} opens with the keys off (read on 2026-11-03).`,
  );
});

// The README states the libSQL default with the version of the dev
// dependencies. A new version needs a new read, so this fact then fails.
it("names the @libsql/client version of the dev dependencies and the date of its read in the README", () => {
  expect(readme.replace(/\s+/g, " ")).toContain(
    `the default of \`@libsql/client\` ${devVersion("@libsql/client")} keeps the keys on and the cascade with them (read on 2026-11-03).`,
  );
});
