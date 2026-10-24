import { env } from "cloudflare:test";
import { createAuth, type DnsTxtPort } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The call budget of the sweep with sso on, on real D1 (plan 12d Task 2b,
// ruling 25). D1 Free allows 50 queries per invocation (D1 limits page
// updated 21 April 2026, read 2026-10-21). Workers Free allows 50
// subrequests per invocation (Workers limits page updated 12 October 2026,
// read 2026-10-21). A DoH resolver makes one fetch per call, so the test
// counts each resolver call beside the queries. The view of the binding
// refuses query 51 as D1 Free does.

const BASE = "https://api.example.com";
const APP = { kind: "app", name: "sso-budget" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The key that gives the statement of the binding under a counting view. */
const RAW = Symbol("raw");

/** A view of `db` that counts each statement, and each statement of a batch. Query `cap + 1` throws. */
function counting(db: D1Database, cap = Number.POSITIVE_INFINITY) {
  const count = { queries: 0, refused: 0 };
  const tick = (n: number) => {
    if (count.queries + n > cap) {
      count.refused++;
      throw new Error("Too many API requests by single worker invocation.");
    }
    count.queries += n;
  };
  const wrapStatement = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values));
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
      if (key === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
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
  return { db: counted, count };
}

let current = new Date(0);
const clock = { now: () => current };
/** The TXT answers of both resolvers, by name. */
const records = new Map<string, string[]>();
/** Each resolver call: a DoH fetch, so a subrequest of the invocation. */
const asked: string[] = [];

/** A resolver that answers from `records` and counts its calls. */
function resolver(name: string): DnsTxtPort {
  return {
    name,
    async txt(record) {
      asked.push(`${name} ${record}`);
      return records.get(record) ?? [];
    },
  };
}

/**
 * The engine on `db` with sso and two resolvers, and `scim` when `scim` is
 * true. Each call makes a new adapter: one invocation.
 */
function engine(db: D1Database, scim = false) {
  const storage = createD1Adapter(db);
  return createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    clock,
    limiter: { allow: async () => true },
    mail: { send: async () => {} },
    organizations: {},
    sso: { dns: [resolver("a"), resolver("b")] },
    ...(scim ? { scim: {} } : {}),
  });
}

const rows = async (sql: string) => Number(await env.DB.prepare(sql).first("n"));

/** `n` verified domains of two organizations, through the product: the add, the record, the verify. */
async function verifiedDomains(n: number): Promise<string[]> {
  const auth = engine(env.DB);
  const ids: string[] = [];
  for (let o = 0; o < 2; o++) {
    const user = await createUser(`owner${o}@example.com`);
    const made = await auth.api.createOrganization({ user, slug: `org-${o}`, name: `Org ${o}` });
    if (!made.ok) throw new Error(made.code);
    for (let i = o; i < n; i += 2) {
      const added = await auth.api.sso?.domains.add({
        actor: APP,
        organizationId: made.value.organization.id,
        domain: `d${i}.example`,
      });
      if (!added?.ok || added.value.record === null) throw new Error("the add failed");
      records.set(added.value.record.name, [added.value.record.value]);
      const done = await auth.api.sso?.domains.verify({ actor: APP, id: added.value.id });
      if (!done?.ok) throw new Error("the verify failed");
      ids.push(added.value.id);
    }
  }
  return ids;
}

/** A verified user through a magic link, the way in of every owner. */
async function createUser(email: string) {
  const mail: string[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(env.DB),
    clock,
    limiter: { allow: async () => true },
    mail: { send: async (m) => void mail.push(m.text) },
  });
  await auth.api.requestMagicLink({ email, ip: null });
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return r.value.user;
}

/** One sweep in its own invocation with a cap of 50 queries: its queries, its resolver calls, and its counts. */
async function sweep(scim = false) {
  const { db, count } = counting(env.DB, 50);
  const before = asked.length;
  const swept = await engine(db, scim).api.sweepExpired();
  return {
    refused: count.refused,
    calls: count.queries + (asked.length - before),
    domains: swept.ssoDomains,
    scimTokens: swept.scimTokens,
  };
}

describe("the recheck of the SSO domains inside the sweep budget on D1 (plan 12d)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    records.clear();
    asked.length = 0;
    current = new Date("2026-10-21T00:00:00.000Z");
  });

  it("checks the due domains within 50 calls per sweep, the loss transaction too", async () => {
    const ids = await verifiedDomains(25);
    expect(
      await rows("SELECT count(*) AS n FROM ta_sso_domain WHERE claimed_domain IS NOT NULL"),
    ).toBe(25);
    current = new Date(current.getTime() + 31 * DAY_MS);
    // Each sweep checks what fits beside the other steps; every one fits 50 calls.
    // The outbox and the links are idle, so the recheck takes the calls that they leave.
    const passes: { refused: number; calls: number; domains: number }[] = [];
    for (let i = 0; i < 40; i++) {
      const s = await sweep();
      passes.push(s);
      if (s.domains === 0) break;
    }
    for (const s of passes) expect([s.refused, s.calls <= 50]).toEqual([0, true]);
    // Measured 2026-10-21 (load 18.6): 9, 9, and 7 domains in sweeps of 46, 46, and 40 calls.
    // A pass costs 3 calls: two resolvers and the update. A row starts only while its worst
    // cost still fits: 5 calls, two resolvers and a loss. Before review m4 of Task 2b, a
    // sweep checked 1 domain.
    expect(passes.map((s) => s.domains)).toEqual([9, 9, 7, 0]);
    expect(passes.map((s) => s.calls)).toEqual([46, 46, 40, 19]);
    // Then every record goes: the loss path, with its transaction and audit row, in the budget.
    // The next check is due 30 days after the pass; three failures 36 hours apart lose each domain.
    records.clear();
    const lost: { refused: number; calls: number; domains: number }[] = [];
    current = new Date(current.getTime() + 30 * DAY_MS);
    for (let step = 0; step < 3; step++) {
      if (step > 0) current = new Date(current.getTime() + 36 * 60 * 60 * 1000);
      for (let i = 0; i < 40; i++) {
        const s = await sweep();
        lost.push(s);
        if (s.domains === 0) break;
      }
    }
    for (const s of lost) expect([s.refused, s.calls <= 50]).toEqual([0, true]);
    // Measured 2026-10-21 (load 18.6). A failure costs 2 calls: resolver a fails, so b is
    // not asked. The read takes at most 10 such rows, at 39 calls. A loss costs 4 calls:
    // the resolver, the read and the write of the update, and the audit row. So a sweep
    // loses 7 domains in 47 calls. Each of the three steps checks all 25 domains.
    expect(lost.map((s) => s.domains)).toEqual([10, 10, 5, 0, 10, 10, 5, 0, 7, 7, 7, 4, 0]);
    expect(Math.max(...lost.map((s) => s.calls))).toBe(47);
    expect(lost.reduce((n, s) => n + s.domains, 0)).toBe(75);
    expect(
      await rows("SELECT count(*) AS n FROM ta_sso_domain WHERE claimed_domain IS NOT NULL"),
    ).toBe(0);
    expect(
      await rows("SELECT count(*) AS n FROM ta_operator_audit WHERE action = 'sso_domain_lost'"),
    ).toBe(ids.length);
  }, 300_000);

  it("deletes the expired SCIM tokens and checks the due domains within 50 calls per sweep", async () => {
    await verifiedDomains(25);
    const auth = engine(env.DB, true);
    const orgs = (
      await env.DB.prepare("SELECT id FROM ta_organization ORDER BY id").all<{
        id: string;
      }>()
    ).results;
    expect(orgs).toHaveLength(2);
    for (const org of orgs)
      for (const name of ["a", "b"]) {
        const made = await auth.api.scim?.tokens.create({
          actor: APP,
          organizationId: org.id,
          name,
          expiresInDays: 1,
        });
        if (!made?.ok) throw new Error("the create failed");
      }
    expect(await rows("SELECT count(*) AS n FROM ta_scim_token")).toBe(4);
    current = new Date(current.getTime() + 31 * DAY_MS);
    const passes: { refused: number; calls: number; domains: number; scimTokens: number }[] = [];
    for (let i = 0; i < 40; i++) {
      const s = await sweep(true);
      passes.push(s);
      if (s.domains === 0) break;
    }
    for (const s of passes) expect([s.refused, s.calls <= 50]).toEqual([0, true]);
    expect(passes.map((s) => s.scimTokens)).toEqual([4, 0, 0, 0]);
    // Measured 2026-10-22 (load 16.6): the SCIM step costs 1 call in each sweep, so
    // 46, 46, 40, and 19 calls become 47, 47, 41, and 20. The recheck still checks 9,
    // 9, and 7 domains. After the ninth row 3 calls stay, and a row starts only while 5 fit.
    expect(passes.map((s) => s.domains)).toEqual([9, 9, 7, 0]);
    expect(passes.map((s) => s.calls)).toEqual([47, 47, 41, 20]);
    expect(await rows("SELECT count(*) AS n FROM ta_scim_token")).toBe(0);
  }, 300_000);
});
