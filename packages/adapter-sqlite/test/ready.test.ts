import { createAuth, SCHEMA_VERSION } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { applySqliteMigrations, createSqliteAdapter, SQLITE_MIGRATIONS } from "../src/index.js";
import { runSqliteMigrations } from "../src/migrations.js";
import { DRIVER_KINDS, openDriver } from "./support/drivers.js";

// The readiness route of plan 12h on SQLite (ruling 26 of the 12g lane). The
// route calls the adapter's ping, so it answers ready on a migrated database
// and not_ready schema on a database before the last migration.

const BASE = "https://api.example.com";

/** The migrations before the one of SCHEMA_VERSION: an app has them before it runs the new file. */
function beforeLast() {
  const cut = SQLITE_MIGRATIONS.findIndex((m) =>
    m.name.startsWith(`${String(SCHEMA_VERSION).padStart(4, "0")}_`),
  );
  if (cut < 1) throw new Error(`no migration file of version ${SCHEMA_VERSION}`);
  return SQLITE_MIGRATIONS.slice(0, cut);
}

async function ready(kind: (typeof DRIVER_KINDS)[number], migrate: "all" | "before-last") {
  const d = openDriver(kind);
  try {
    if (migrate === "all") await applySqliteMigrations(d.driver);
    else await runSqliteMigrations(d.driver, beforeLast());
    const auth = createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createSqliteAdapter(d.driver),
      mail: { send: async () => {} },
      observe: { sink: { write: () => {} }, readiness: true },
    });
    const res = await auth.handle(new Request(`${BASE}/auth/ready`));
    return { status: res.status, body: await res.json() };
  } finally {
    d.close();
  }
}

describe("GET /ready on SQLite (plan 12h Task 8, ruling 26 of the 12g lane)", () => {
  it.each(DRIVER_KINDS)("answers ready on a migrated database: %s", async (kind) => {
    expect(await ready(kind, "all")).toEqual({ status: 200, body: { status: "ready" } });
  });

  it.each(DRIVER_KINDS)("answers not_ready schema before the last migration: %s", async (kind) => {
    expect(await ready(kind, "before-last")).toEqual({
      status: 503,
      body: { error: "not_ready", reason: "schema" },
    });
  });
});
