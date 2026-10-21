import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_URL,
  dropLiveDatabases,
  dropStaleDatabases,
  dropUnused,
  freshDatabase,
  staleDatabases,
  testId,
} from "./support/pg.js";

// The sweep and the afterAll drop of the CLI test databases on Postgres
// (lead addition to ruling 23 of plan 12g, in the form of mysql-supply).
// Each database of this file has a prefix of this run (ruling 25). Other
// lanes share the server, so this test and each break of the sweep act only
// on databases that this file made. The normal sweep reads the id after
// `cli_`, which here starts with `t`, so it never drops them.

const HOUR = 60 * 60 * 1000;
const PREFIX = `cli_t${process.pid}${crypto.randomUUID().slice(0, 6)}_`;
const LEGACY = () => crypto.randomUUID().replaceAll("-", "");
const mine = { prefix: PREFIX };

async function names(): Promise<string[]> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await admin.unsafe<{ name: string }[]>(
      "SELECT datname AS name FROM pg_database WHERE starts_with(datname, $1)",
      [PREFIX],
    );
    return rows.map((r) => r.name).sort();
  } finally {
    await admin.end({ timeout: 5 });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the CLI test databases on Postgres", () => {
  it("lists a database of a killed run, and not a young one or one with a connection", async () => {
    const young = await freshDatabase(mine);
    // A run that was killed two hours ago left this database.
    const old = await freshDatabase({ ...mine, id: testId(Date.now() - 2 * HOUR) });
    // A legacy id holds no time. This database is new and has a connection.
    const held = await freshDatabase({ ...mine, id: LEGACY() });
    try {
      await held.sql`SELECT 1`;
      expect(await staleDatabases(mine)).toEqual([old.name]);
      // With no age bound, only the connection keeps a database off the list.
      expect(await staleDatabases({ ...mine, staleAfterMs: 0 })).toEqual(
        [young.name, old.name].sort(),
      );
    } finally {
      for (const d of [young, old, held]) await d.drop();
    }
  });

  it("keeps a database that a connection opened after the list read", async () => {
    const held = await freshDatabase(mine);
    try {
      await held.sql`SELECT 1`;
      expect(await dropUnused([held.name])).toEqual([]);
      expect(await names()).toEqual([held.name]);
    } finally {
      await held.drop();
    }
  });

  it("goes on when a parallel run drops a database between the list read and the age read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gone = await freshDatabase({ ...mine, id: LEGACY() });
    const kept = await freshDatabase({ ...mine, id: LEGACY() });
    try {
      const dropped = await dropStaleDatabases({
        ...mine,
        staleAfterMs: 0,
        afterList: () => gone.drop(),
      });
      expect(dropped).toEqual([kept.name]);
      expect(warn).not.toHaveBeenCalled();
      expect(await names()).toEqual([]);
    } finally {
      for (const d of [gone, kept]) await d.drop();
    }
  });

  it("drops no legacy database and tells why when the user is not a superuser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const role = `${PREFIX}role`;
    // A database of a killed run that this user does not own: its drop fails.
    const old = await freshDatabase({ ...mine, id: testId(Date.now() - 2 * HOUR) });
    const legacy = await freshDatabase({ ...mine, id: LEGACY() });
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    let made: Awaited<ReturnType<typeof freshDatabase>> | undefined;
    try {
      await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' CREATEDB`);
      // The user owns the legacy database, so only the age rule keeps it.
      await admin.unsafe(`ALTER DATABASE ${legacy.name} OWNER TO ${role}`);
      const u = new URL(ADMIN_URL);
      u.username = role;
      u.password = "pw";
      // The sweep of this call reads no age, and its drop of `old` fails.
      made = await freshDatabase({ ...mine, url: u.toString() });
      expect(await names()).toEqual([old.name, legacy.name, made.name].sort());
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(
        /cannot read the age of 1 legacy databases, so it keeps them: permission denied for function pg_stat_file/,
      );
      expect(lines[1]).toMatch(/stopped: the drop failed for .*must be owner of database/);
      expect(lines.join("\n")).not.toContain("docker compose");
    } finally {
      await made?.drop();
      for (const d of [old, legacy]) await d.drop();
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await admin.end({ timeout: 5 });
    }
  });

  it("drops each database of the file that no test dropped, past a drop that fails", async () => {
    const blocked = await freshDatabase(mine);
    const left = await freshDatabase(mine);
    // A transaction that holds the database blocks its DROP until the lock bound.
    const holder = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    try {
      await holder.unsafe("BEGIN");
      await holder.unsafe(`COMMENT ON DATABASE ${blocked.name} IS 'held'`);
      await expect(dropLiveDatabases()).rejects.toThrow(
        new RegExp(`1 test databases stay on the server: ${blocked.name}: .*lock timeout`),
      );
      expect(await names()).toEqual([blocked.name]);
      await holder.unsafe("ROLLBACK");
      await dropLiveDatabases();
      expect(await names()).toEqual([]);
    } finally {
      await holder.end({ timeout: 5 });
      for (const d of [blocked, left]) await d.drop();
    }
  });
});
