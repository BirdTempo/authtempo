import { env } from "cloudflare:test";
import { createAuth } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The queries that the sweep of the setup rows adds on D1 (plan 13a fix wave 1, round 2, ruling
// R33). D1 Free allows 50 queries per invocation (D1 limits page updated 21 April 2026, read
// 2026-11-23). The test runs the sweep with `sso` on and no other row, so each query of the
// sweep that the setup step makes shows in the count. It runs the same sweep with `sso` off: the
// difference is the cost of the setup step. The view refuses query 51, as D1 Free does.

const BASE = "https://api.example.com";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RAW = Symbol("raw");

/** A view of `db` that counts each statement, and each statement of a batch. Query 51 throws. */
function counting(db: D1Database) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (count.queries + n > 50)
      throw new Error("Too many API requests by single worker invocation.");
    count.queries += n;
  };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            tick(1);
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          tick(statements.length);
          return target.batch(
            statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted as D1Database, count };
}

const NOW = new Date("2026-11-23T00:00:00.000Z");
const clock = { now: () => NOW };

function engine(db: D1Database, sso: boolean) {
  return createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    clock,
    limiter: { allow: async () => true },
    mail: { send: async () => {} },
    organizations: {},
    scim: {},
    ...(sso ? { sso: { oidc: true, setup: {}, dns: [{ name: "a", txt: async () => [] }] } } : {}),
  });
}

/** One sweep in its own invocation: its queries and its counts. */
async function sweep(sso: boolean) {
  const { db, count } = counting(env.DB);
  const swept = await engine(db, sso).api.sweepExpired();
  return { queries: count.queries, swept };
}

/** `n` links that expired `ago` ms ago, each with a pending token, a session, and a run. */
async function seed(n: number, ago: number) {
  const storage = createD1Adapter(env.DB);
  for (let i = 0; i < n; i++) {
    const id = `link-${String(i).padStart(3, "0")}`;
    const at = new Date(NOW.getTime() - ago);
    await storage.create("ssoSetupLink", {
      id,
      createdAt: at,
      updatedAt: at,
      organizationId: "org1",
      tokenHash: `hash-${i}`,
      hint: "abcd",
      steps: ["domain"],
      kinds: ["oidc"],
      note: `Contact ${i}`,
      createdBy: "u1",
      expiresAt: at,
      revokedAt: null,
      endedAt: null,
      openedAt: null,
      readyAt: null,
      expiryStage: null,
      expiryNoticeAt: null,
    });
    await storage.create("scimToken", {
      id: `tok-${String(i).padStart(3, "0")}`,
      createdAt: at,
      updatedAt: at,
      organizationId: "org1",
      name: "Setup link directory",
      tokenHash: `thash-${i}`,
      hint: "abcd",
      scopes: ["scim.users.read"],
      expiresAt: null,
      lastUsedAt: null,
      pending: true,
      setupLinkId: id,
      expiryStage: null,
      expiryNoticeAt: null,
    });
  }
}

const rows = async (table: string) =>
  Number(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"));

describe("the sweep of the setup rows on D1 (plan 13a, ruling R33)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("costs the same number of queries with no row and with a full page, and stays under 50", async () => {
    const off = await sweep(false);
    const idle = await sweep(true);
    await seed(60, RETENTION_MS + 1000);
    const full = await sweep(true);
    // Measured 2026-11-23, 06:47 on the owner's Mac Studio, load 4.53 5.96 6.98. A full page deletes 50 links and their 50 pending
    // tokens in the same number of statements as an idle sweep: each delete is one statement.
    expect(full.swept.ssoSetupRows).toBe(50);
    expect(await rows("ta_sso_setup_link")).toBe(10);
    expect(await rows("ta_scim_token")).toBe(10);
    // The setup step is 3 queries when no link ended (the read of the links, the sessions, the
    // runs) and 5 when a page ended (plus the pending tokens and the links). That is
    // `SETUP_SWEEP_CALLS` of core, so the meter of the sweep counts the worst case.
    expect({ off: off.queries, idle: idle.queries, full: full.queries }).toEqual({
      off: 19,
      idle: 23,
      full: 25,
    });
    expect(full.queries - idle.queries).toBe(2);
    expect(full.queries).toBeLessThan(50);
  }, 120_000);
});
