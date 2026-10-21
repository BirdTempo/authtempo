import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  ADMIN_URL,
  dropLiveDatabases,
  dropStaleDatabases,
  freshDatabase,
  testId,
} from "./support/pg.js";

// The sweep and the afterAll drop of the CLI test databases on Postgres
// (lead addition to ruling 23 of plan 12g, in the form of mysql-supply).

const HOUR = 60 * 60 * 1000;

async function cliDatabases(): Promise<string[]> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await admin.unsafe<{ name: string }[]>(
      "SELECT datname AS name FROM pg_database WHERE datname LIKE 'cli\\_%'",
    );
    return rows.map((r) => r.name);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

describe("the CLI test databases on Postgres", () => {
  it("drops a database of a killed run, and keeps a young one and one with a connection", async () => {
    const young = await freshDatabase();
    // A run that was killed two hours ago left these two databases.
    const old = await freshDatabase({ id: testId(Date.now() - 2 * HOUR) });
    const held = await freshDatabase({ id: testId(Date.now() - 2 * HOUR) });
    // A legacy id holds no time, and this database is new, so it stays.
    const legacy = await freshDatabase({ id: crypto.randomUUID().replaceAll("-", "") });
    try {
      await held.sql`SELECT 1`;
      const dropped = await dropStaleDatabases();
      expect(dropped).toContain(old.name);
      expect(dropped).not.toContain(young.name);
      expect(dropped).not.toContain(held.name);
      expect(dropped).not.toContain(legacy.name);
      const names = [young.name, old.name, held.name, legacy.name];
      expect((await cliDatabases()).filter((n) => names.includes(n)).sort()).toEqual(
        [young.name, held.name, legacy.name].sort(),
      );
    } finally {
      for (const d of [young, old, held, legacy]) await d.drop();
    }
  });

  it("drops each database of the file that no test dropped", async () => {
    const left = await freshDatabase();
    const dropped = await freshDatabase();
    await dropped.drop();
    expect(await cliDatabases()).toContain(left.name);
    await dropLiveDatabases();
    expect(await cliDatabases()).not.toContain(left.name);
    expect(await cliDatabases()).not.toContain(dropped.name);
  });
});
