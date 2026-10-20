import { createAuth, type StorageAdapter } from "@authtempo/core";
import postgres, { type Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase, PG_URL } from "./db.js";

// The cap of plan 12k Task 8 on the real Postgres adapter, through core's
// built output. Each instance has its own client of one connection, so the
// two creates run as two requests on two connections do.

const t0 = new Date("2026-01-01T00:00:00.000Z");
const CAP = 50;

let db: Awaited<ReturnType<typeof freshDatabase>>;
let clients: Sql[] = [];
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
  clients = [];
  await db.close();
});

/** A client of one connection on the schema of `db`. */
async function connection(): Promise<Sql> {
  const [row] = await db.sql<{ schema: string }[]>`select current_schema() as schema`;
  const sql = postgres(PG_URL, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: row?.schema ?? "" },
  });
  clients.push(sql);
  return sql;
}

/**
 * A storage, and the storage of each of its transactions, that calls
 * `reached` when the create reaches its lock of the organization row or its
 * count returns, and then waits for `other` before it writes the token. So
 * without the lock both counts run before either create, and with the lock
 * the second count waits for the first commit. No pause runs.
 */
function gated(base: StorageAdapter, reached: () => void, other: Promise<void>): StorageAdapter {
  return {
    ...base,
    async update(model, where, data) {
      if (model === "organization") reached();
      return base.update(model, where, data);
    },
    async findMany(model, where, options) {
      const rows = await base.findMany(model, where, options);
      if (model === "organizationToken") {
        reached();
        await other;
      }
      return rows;
    },
    transaction: (fn) => base.transaction((tx) => fn(gated(tx, reached, other))),
  };
}

function instance(storage: StorageAdapter) {
  return createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async () => {} },
    clock: { now: () => t0 },
    organizations: {},
  });
}

describe("the organization token cap on Postgres (plan 12k Task 8)", () => {
  it("makes one token of two creates at 49 live rows", async () => {
    let reachedA = () => {};
    let reachedB = () => {};
    const aReached = new Promise<void>((r) => {
      reachedA = r;
    });
    const bReached = new Promise<void>((r) => {
      reachedB = r;
    });
    const a = instance(gated(createPostgresAdapter(await connection()), reachedA, bReached));
    const b = instance(gated(createPostgresAdapter(await connection()), reachedB, aReached));
    const storage = createPostgresAdapter(db.sql);
    // The setup instance has no gate, so neither gate sees the setup.
    const plain = instance(storage);
    const user = await storage.create("user", {
      id: "u1",
      email: "u1@example.com",
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      createdAt: t0,
      updatedAt: t0,
    });
    const org = await plain.api.createOrganization({ user, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    const input = {
      user,
      organizationId: org.value.organization.id,
      name: "ci",
      permissions: {},
    };
    for (let i = 0; i < CAP - 1; i++) {
      const made = await plain.api.organizationTokens.create(input);
      if (!made.ok) throw new Error(made.code);
    }
    const answers = await Promise.all([
      a.api.organizationTokens.create(input),
      b.api.organizationTokens.create(input),
    ]);
    const codes = answers.map((r) => (r.ok ? "ok" : r.code)).sort();
    expect(codes).toEqual(["ok", "organization_token_limit"]);
    expect(await storage.findMany("organizationToken", [])).toHaveLength(CAP);
  });
});
