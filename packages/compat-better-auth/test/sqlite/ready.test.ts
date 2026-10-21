import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlite } from "@authtempo/adapter-sqlite/node";
import { createAuth, SCHEMA_VERSION } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";

// The readiness route of plan 12h on the Better Auth tables on SQLite
// (ruling 27 of the 12g lane). The route calls the ping of the compat
// storage. The ping runs the integer check first, then the D1 ping over the
// seam, so a handle that every call refuses answers not_ready storage.

const BASE = "https://api.example.com";

const D1_FILES = new URL("../../migrations/d1/", import.meta.url);

/** The shipped compat files before the one of SCHEMA_VERSION: an app has them before it applies the new file. */
function beforeLast(): string[] {
  const names = readdirSync(D1_FILES)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const cut = names.findIndex((n) => n.endsWith(`_schema_v${SCHEMA_VERSION}.sql`));
  if (cut < 1) throw new Error(`no compat migration file of version ${SCHEMA_VERSION}`);
  return names.slice(0, cut).map((n) => readFileSync(new URL(n, D1_FILES), "utf8"));
}

/** GET /auth/ready on a node:sqlite memory database with Better Auth's tables and the compat migrations. */
async function ready(options: { readBigInts: boolean; migrate?: "all" | "before-last" }) {
  const db = new DatabaseSync(":memory:", { readBigInts: options.readBigInts });
  try {
    db.exec(BETTER_AUTH_SQLITE);
    const compat = betterAuthSchemaStorage({ dialect: "sqlite", driver: nodeSqlite(db) });
    if (options.migrate === "before-last") for (const text of beforeLast()) db.exec(text);
    else await compat.migrate();
    const auth = createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: compat.storage,
      mail: { send: async () => {} },
      observe: { sink: { write: () => {} }, readiness: true },
    });
    const res = await auth.handle(new Request(`${BASE}/auth/ready`));
    return { status: res.status, body: await res.json() };
  } finally {
    db.close();
  }
}

describe("GET /ready on the compat SQLite storage (ruling 27 of the 12g lane)", () => {
  it("answers ready on a migrated store", async () => {
    expect(await ready({ readBigInts: false })).toEqual({
      status: 200,
      body: { status: "ready" },
    });
  });

  it("answers not_ready schema before the last compat migration", async () => {
    expect(await ready({ readBigInts: false, migrate: "before-last" })).toEqual({
      status: 503,
      body: { error: "not_ready", reason: "schema" },
    });
  });

  it("answers not_ready storage on a migrated handle that reads BigInt", async () => {
    expect(await ready({ readBigInts: true })).toEqual({
      status: 503,
      body: { error: "not_ready", reason: "storage" },
    });
  });
});
