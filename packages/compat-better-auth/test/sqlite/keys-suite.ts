import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDriver } from "@authtempo/adapter-sqlite";
import type { StorageAdapter } from "@authtempo/core";
import { afterEach, describe, expect, it } from "vitest";
import { betterAuthSchemaStorage, FOREIGN_KEYS_OFF } from "../../src/storage/index.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { at, eq } from "../mapping-cases.js";

/** A handle to one SQLite file that a test opened as an app does, through one driver entry. */
export interface KeysHandle {
  driver: SqliteDriver;
  /** Runs a SQL text of one or more statements on the handle, as the app runs its own SQL. */
  exec(text: string): Promise<void>;
  close(): void;
}

/** One driver of the foreign key tests. */
export interface KeysDriver {
  /** Opens `file` with the foreign keys off: the driver's default, or an app setting. */
  open(file: string): Promise<KeysHandle>;
  /**
   * True when a BEGIN of the app holds the connection of the storage's next
   * call. A libSQL file client keeps a pool, so there it is false.
   */
  oneConnection: boolean;
}

/** A session row of `userId`, as core writes one at a sign-in. */
const session = (id: string, userId: string) => ({
  id,
  userId,
  tokenHash: `h-${id}`,
  expiresAt: new Date(at.getTime() + 86_400_000),
  lastSeenAt: at,
  ip: null,
  userAgent: null,
  activeOrganizationId: null,
  freshAt: at,
  actorId: null,
  activeTeamId: null,
  createdAt: at,
  updatedAt: at,
});

/** The users u1 and u2, each with two sessions, through the storage port. */
export async function twoUsers(s: StorageAdapter): Promise<void> {
  for (const id of ["u1", "u2"]) {
    await s.create("user", {
      id,
      email: `${id}@example.com`,
      emailVerified: false,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: at,
      updatedAt: at,
    });
    for (const n of [1, 2]) await s.create("session", session(`${id}-s${n}`, id));
  }
}

/** The value of `PRAGMA foreign_keys` on the handle. */
const keys = async (h: KeysHandle) =>
  Number(await h.driver.db.prepare("PRAGMA foreign_keys").first("foreign_keys"));

/** The count of the session rows of u1 and of u2, read on the handle. */
export const sessionsOf = (h: Pick<KeysHandle, "driver">) =>
  Promise.all(
    ["u1", "u2"].map(async (u) =>
      Number(
        await h.driver.db
          .prepare(`SELECT count(*) AS n FROM "session" WHERE "userId" = ?`)
          .bind(u)
          .first("n"),
      ),
    ),
  );

/**
 * The foreign keys of the compat storage on one SQLite driver (rulings 40 and
 * 44 of plan 12n). Each test opens its file with the keys off, so only the
 * storage turns them on. A user delete then leaves no session row of that
 * user. The tests of an open BEGIN run where the BEGIN holds the storage's
 * connection.
 */
export function foreignKeysSuite(kind: string, d: KeysDriver): void {
  let dirs: string[] = [];
  let handles: KeysHandle[] = [];
  afterEach(() => {
    for (const h of handles) h.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    handles = [];
    dirs = [];
  });
  const file = () => {
    const dir = mkdtempSync(join(tmpdir(), "authtempo-compat-keys-"));
    dirs.push(dir);
    return join(dir, "db.sqlite");
  };
  const open = async (path: string) => {
    const h = await d.open(path);
    handles.push(h);
    return h;
  };
  const storageOf = (h: KeysHandle) =>
    betterAuthSchemaStorage({ dialect: "sqlite", driver: h.driver });
  /** A file that a deploy step migrated, then a new handle to it with the keys off and no migration. */
  const migrated = async () => {
    const path = file();
    const deploy = await open(path);
    await deploy.exec(BETTER_AUTH_SQLITE);
    await storageOf(deploy).migrate();
    const h = await open(path);
    expect(await keys(h)).toBe(0);
    return h;
  };

  describe(`the foreign keys of the storage on ${kind} (rulings 40 and 44 of plan 12n)`, () => {
    it("turns the foreign keys on, so a user delete leaves no session row of that user", async () => {
      const h = await open(file());
      expect(await keys(h)).toBe(0);
      await h.exec(BETTER_AUTH_SQLITE);
      const compat = storageOf(h);
      await compat.migrate();
      // The migrations run with the keys on, as on D1.
      expect(await keys(h)).toBe(1);
      await twoUsers(compat.storage);
      expect(await compat.storage.delete("user", [eq("id", "u1")])).toBe(1);
      expect(await sessionsOf(h)).toEqual([0, 2]);
    });

    it("turns the foreign keys on at the first call of a storage that runs no migration", async () => {
      const h = await migrated();
      const { storage } = storageOf(h);
      await twoUsers(storage);
      expect(await keys(h)).toBe(1);
      expect(await storage.delete("user", [eq("id", "u1")])).toBe(1);
      expect(await sessionsOf(h)).toEqual([0, 2]);
    });

    it("counts the pragma and its read in statementsSent and readyStatements", async () => {
      const { storage } = storageOf(await migrated());
      // The pragma and its read (2), and the integer check (1). The compat
      // check: the two version reads, the index list, and the index read (4).
      expect(await storage.readyStatements?.()).toBe(7);
      expect(storage.statementsSent?.()).toBe(7);
    });

    if (d.oneConnection)
      it("refuses the first call while the app holds a BEGIN, and turns the keys on at the next call", async () => {
        const h = await migrated();
        const { storage } = storageOf(h);
        await h.exec("BEGIN");
        // SQLite ignores the pragma inside the open transaction, so the read gives 0.
        await expect(storage.findOne("user", [eq("id", "u1")])).rejects.toMatchObject({
          code: "config_mismatch",
          fields: [FOREIGN_KEYS_OFF],
        });
        expect(await keys(h)).toBe(0);
        await h.exec("COMMIT");
        // The failed run is not kept: the next call runs the pragma again.
        await twoUsers(storage);
        expect(await keys(h)).toBe(1);
        expect(await storage.delete("user", [eq("id", "u1")])).toBe(1);
        expect(await sessionsOf(h)).toEqual([0, 2]);
      });
  });
}
