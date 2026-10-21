import { describe, expect, it } from "vitest";
import { dropStaleDatabases, freshMysqlDatabase, MYSQL_SERVERS, testId } from "./support/mysql.js";

// The sweep of the CLI test databases (ruling 16 of plan 12g, for the cli_
// databases of plan 12g Task 6).

const HOUR = 60 * 60 * 1000;

describe.each(MYSQL_SERVERS)("the CLI test databases on MySQL $version", (server) => {
  it("drops the database and the user of a killed run, and keeps the young ones", async () => {
    const young = await freshMysqlDatabase(server);
    // A run that was killed two hours ago left this database and its user.
    const old = await freshMysqlDatabase(server, { id: testId(Date.now() - 2 * HOUR) });
    // A legacy id holds no time, and this database has no table, so it stays.
    const legacy = await freshMysqlDatabase(server, {
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
    });
    try {
      const dropped = await dropStaleDatabases(server);
      expect(dropped).toContain(old.name.slice("cli_".length));
      expect(dropped).not.toContain(young.name.slice("cli_".length));
      expect(dropped).not.toContain(legacy.name.slice("cli_".length));
      const names = [young.name, old.name, legacy.name];
      const dbs = (await young.query(
        "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'cli\\_%'",
      )) as { name: string }[];
      expect(
        dbs
          .map((r) => r.name)
          .filter((n) => names.includes(n))
          .sort(),
      ).toEqual([young.name, legacy.name].sort());
      const users = (await young.query(
        "SELECT User AS name FROM mysql.user WHERE User LIKE 'cliuser\\_%'",
      )) as { name: string }[];
      expect(users.map((r) => r.name)).not.toContain(old.user);
      expect(users.map((r) => r.name)).toContain(young.user);
    } finally {
      for (const d of [young, old, legacy]) await d.drop();
    }
  });
});
