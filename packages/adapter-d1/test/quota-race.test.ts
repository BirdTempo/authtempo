import { env } from "cloudflare:test";
import { createAuth, type StorageAdapter } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

/**
 * The quota races of spec 29 item 13 on D1 (plan 12k Task 7). Each spend is
 * one statement, and SQLite runs each statement alone, so the
 * compare-and-set decides between two instances on one database.
 */
describe("token quota races on D1 (plan 12k Task 7)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  /**
   * A storage that calls `read` after each apiToken read, and whose quota
   * spend waits for `other` first. Each call then reads the row before either
   * call writes it. No pause runs.
   */
  function gated(read: () => void, other: Promise<void>): StorageAdapter {
    const base = createD1Adapter(env.DB);
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

  /** Two instances of core on one database, a plain one for the setup, and one clock that the test moves. */
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
    const storage = createD1Adapter(env.DB);
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
    return {
      a: instance(gated(readA, bRead)),
      b: instance(gated(readB, aRead)),
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
});
