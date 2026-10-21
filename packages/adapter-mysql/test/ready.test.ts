import { createAuth } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type PoolSettings } from "./db.js";

// The readiness route of plan 12h on MySQL (ruling 26 of the 12g lane). The
// route calls the adapter's ping, so it answers ready on a migrated database
// and not_ready schema on a database that never ran the migration. MySQL
// ships one migration file, so no MySQL store holds an older version. The
// ping runs the start checks first (ruling 27), so a pool that every call
// refuses answers not_ready storage.

const BASE = "https://api.example.com";

async function ready(
  server: (typeof MYSQL_SERVERS)[number],
  migrate: boolean,
  settings: PoolSettings = {},
) {
  const db = await freshDatabase(server, { ...settings, migrate });
  try {
    const auth = createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMysqlAdapter(db.pool),
      mail: { send: async () => {} },
      observe: { sink: { write: () => {} }, readiness: true },
    });
    const res = await auth.handle(new Request(`${BASE}/auth/ready`));
    return { status: res.status, body: await res.json() };
  } finally {
    await db.close();
  }
}

describe.each(MYSQL_SERVERS.map((s) => [s.version, s] as const))(
  "GET /ready on MySQL %s (plan 12h Task 8, ruling 26 of the 12g lane)",
  (_, server) => {
    it("answers ready on a migrated database", async () => {
      expect(await ready(server, true)).toEqual({ status: 200, body: { status: "ready" } });
    });

    it("answers not_ready schema on a database with no migration", async () => {
      expect(await ready(server, false)).toEqual({
        status: 503,
        body: { error: "not_ready", reason: "schema" },
      });
    });

    it("answers not_ready storage on a pool without FOUND_ROWS", async () => {
      expect(await ready(server, true, { flags: ["-FOUND_ROWS"] })).toEqual({
        status: 503,
        body: { error: "not_ready", reason: "storage" },
      });
    });

    it("answers not_ready storage on a session without strict mode", async () => {
      expect(await ready(server, true, { onConnect: "SET SESSION sql_mode = ''" })).toEqual({
        status: 503,
        body: { error: "not_ready", reason: "storage" },
      });
    });
  },
);
