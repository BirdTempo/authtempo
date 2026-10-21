import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySqliteMigrations, createSqliteAdapter } from "@authtempo/adapter-sqlite";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";
import { SCHEMA_VERSION, StorageError } from "@authtempo/core";
import { afterEach, describe, expect, it } from "vitest";
import { call, harness, signIn } from "../support/harness.ts";
import { authOnSqlite } from "./sqlite-node.ts";

const dirs: string[] = [];

/** A new folder for one database file. */
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-site-sqlite-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("authtempo on a SQLite file (the SQLite guide)", () => {
  it("makes the file with mode 0600, migrates it, and signs a person in", async () => {
    const path = join(folder(), "auth.sqlite");
    const h = harness();
    const { auth, close } = await authOnSqlite(path, h.mail, h.secret);
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const cookie = await signIn(auth, h, "ada@example.com");
      const session = await call(auth, "GET", "/auth/session", undefined, { cookie });
      expect(session.status).toBe(200);
      expect(((await session.json()) as { user: { email: string } }).user.email).toBe(
        "ada@example.com",
      );
    } finally {
      close();
    }
    // The rows are on disk: a second open reads the same user and the version.
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("SELECT email FROM ta_user").all()).toEqual([{ email: "ada@example.com" }]);
      expect(db.prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'").get()).toEqual({
        value: String(SCHEMA_VERSION),
      });
    } finally {
      db.close();
    }
    // The migrations run every D1 file on a new database file.
  }, 30_000);

  it("refuses a handle that reads integers as BigInt with config_mismatch", async () => {
    const db = new DatabaseSync(join(folder(), "auth.sqlite"), { readBigInts: true });
    try {
      let error: unknown = null;
      try {
        await applySqliteMigrations(nodeSqlite(db));
        await createSqliteAdapter(nodeSqlite(db)).findOne("user", [
          { field: "email", op: "eq", value: "ada@example.com" },
        ]);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe("config_mismatch");
    } finally {
      db.close();
    }
  });
});
