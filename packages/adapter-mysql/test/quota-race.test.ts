import { createAuth, type StorageAdapter } from "@authtempo/core";
import type { Pool } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_84, type MysqlDatabase } from "./db.js";

// The port of adapter-postgres/test/quota-race.test.ts to MySQL 8.4 (ruling
// 1 of plan 12g). The quota races of plan 12k Task 7 on the real MySQL
// adapter, through core's built output. Each instance has its own pool of
// one connection, so the two spends run as two requests on two connections do.

const t0 = new Date("2026-01-01T00:00:00.000Z");

let db: MysqlDatabase;
beforeEach(async () => {
  db = await freshDatabase(MYSQL_84);
});
afterEach(async () => {
  await db.close();
});

/** A pool of `max` connections, one by default, on the database of `db`. `close` ends it. */
async function connection(max = 1): Promise<Pool> {
  return db.pool2({ connectionLimit: max });
}

/**
 * A storage that calls `read` after each apiToken read, and whose quota spend
 * waits for `other` first. Each call then reads the row before either call
 * writes it, and the compare-and-set decides. No pause runs.
 */
function gated(pool: Pool, read: () => void, other: Promise<void>): StorageAdapter {
  const base = createMysqlAdapter(pool);
  return {
    ...base,
    async findOne(model, where) {
      const row = await base.findOne(model, where);
      if (model === "apiToken") read();
      return row;
    },
    async update(model, where, data) {
      if (model === "apiToken" && "remaining" in data) await other;
      return base.update(model, where, data);
    },
  };
}

/** Two instances of core on two connections, a plain one for the setup, and one clock that the test moves. */
async function twoInstances() {
  let now = t0;
  const clock = { now: () => now };
  let readA = () => {};
  let readB = () => {};
  const aRead = new Promise<void>((r) => {
    readA = r;
  });
  const bRead = new Promise<void>((r) => {
    readB = r;
  });
  const instance = (storage: StorageAdapter) =>
    createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage,
      limiter: { allow: async () => true },
      mail: { send: async () => {} },
      clock,
    });
  const a = instance(gated(await connection(), readA, bRead));
  const b = instance(gated(await connection(), readB, aRead));
  const storage = createMysqlAdapter(db.pool);
  const user = await storage.create("user", {
    id: "u1",
    email: "u1@example.com",
    emailVerified: true,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    username: null,
    displayUsername: null,
    phone: null,
    isAnonymous: false,
    createdAt: t0,
    updatedAt: t0,
  });
  return {
    a,
    b,
    // The setup instance has no gate, so neither gate sees the create.
    plain: instance(storage),
    storage,
    user,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

const request = (token: string) =>
  new Request("https://api.example.com/app", { headers: { authorization: `Bearer ${token}` } });

describe("token quota races on MySQL 8.4 (plan 12k Task 7)", () => {
  it("spends the last call once under a race", async () => {
    const w = await twoInstances();
    const made = await w.plain.api.tokens.create({
      user: w.user,
      name: "ci",
      quota: { remaining: 1 },
    });
    if (!made.ok) throw new Error(made.code);
    const answers = await Promise.all([
      w.a.authenticate(request(made.value.token)),
      w.b.authenticate(request(made.value.token)),
    ]);
    const codes = answers.map((r) => (r.ok ? "ok" : r.code)).sort();
    expect(codes).toEqual(["ok", "token_exhausted"]);
    const [row] = await w.storage.findMany("apiToken", []);
    expect(row?.remaining).toBe(0);
  });

  it("refills once under a race", async () => {
    const w = await twoInstances();
    const made = await w.plain.api.tokens.create({
      user: w.user,
      name: "ci",
      quota: { remaining: 0, refillAmount: 1, refillSeconds: 60 },
    });
    if (!made.ok) throw new Error(made.code);
    w.advance(60_000);
    const answers = await Promise.all([
      w.a.authenticate(request(made.value.token)),
      w.b.authenticate(request(made.value.token)),
    ]);
    const codes = answers.map((r) => (r.ok ? "ok" : r.code)).sort();
    expect(codes).toEqual(["ok", "token_exhausted"]);
    const [row] = await w.storage.findMany("apiToken", []);
    expect(row).toMatchObject({ remaining: 0, lastRefillAt: new Date(t0.getTime() + 60_000) });
  });

  it("spends each call of a burst of 20 on a pool of 10", async () => {
    const w = await twoInstances();
    const made = await w.plain.api.tokens.create({
      user: w.user,
      name: "ci",
      quota: { remaining: 1000 },
    });
    if (!made.ok) throw new Error(made.code);
    // One instance on a pool of 10 connections, as an app server under a parallel CI job.
    const pooled = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMysqlAdapter(await connection(10)),
      limiter: { allow: async () => true },
      mail: { send: async () => {} },
      clock: { now: () => t0 },
    });
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => pooled.authenticate(request(made.value.token))),
    );
    expect(answers.map((r) => (r.ok ? "ok" : r.code))).toEqual(Array(20).fill("ok"));
    const [row] = await w.storage.findMany("apiToken", []);
    expect(row?.remaining).toBe(980);
  });
});
