import { env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash, type MailMessage } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The lease of a claim on D1 (ruling 16 of plan 12p). D1 does not isolate a
// transaction. So the first statement of a claim is the lease: a
// `claim-lease` verification row of the user. It lives 60 seconds
// (`CLAIM_LEASE_MS` of core). A request that runs out of queries after its
// lease cannot undo it either, so the lease stays and the next claim meets
// it. After 60 seconds a claim takes the stale lease.
//
// Every step is a real request through `auth.handle`. The request of a step
// runs on a view of the binding. The view counts each query and refuses
// query 51, as D1 Free does. The source is the D1 limits page, updated 21
// April 2026 and read 2026-10-24 (anonymous-upgrade-budget.test.ts).

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const SQL = Symbol("sql");
const PASSWORD = "correct horse battery";
/** `CLAIM_LEASE_MS` of core: the life of a lease. */
const LEASE_MS = 60_000;
/** The lease create, the first statement of a claim on D1. The magic link writes no other verification row before it. */
const LEASE_INSERT = /^INSERT INTO ta_verification\b/;

// The counts come from the run of 2026-11-04 20:33 CST on
// <local-host> (load 1.6 3.1 5.1). The run used the D1 binding
// of this pool, with the D1 limiter on the same view. `plain` is the magic
// link that claims a password claimant with two sessions, the lease create
// included. `held` is a proof that
// meets a live lease: 409 with no claim write. `stale` is the same claim
// after it takes a stale lease. The create that meets the key (1), then the
// read of the undo and the update of the lease (2), replace the create (1).
// The `email` identity of the first request stayed, so `stale` writes no
// identity (-1). So the stale path sends two more queries than `plain`, and
// three more than a claim before plan 12p.
const PINS = { plain: 27, held: 15, stale: 28 };

type Watch = (sql: string) => Promise<void>;

/**
 * A view of `db` that counts each statement, and each statement of a batch.
 * The statement past the budget throws, as D1 Free does. `watch` runs after
 * each statement that answers.
 */
function counting(db: D1Database, watch?: Watch) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (count.queries + n > BUDGET)
      throw new Error("Too many API requests by single worker invocation.");
    count.queries += n;
  };
  const after = async <T>(value: Promise<T>, texts: string[]): Promise<T> => {
    const done = await value;
    for (const text of texts) await watch?.(text);
    return done;
  };
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === SQL) return sql;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            tick(1);
            return after(
              (target[key] as (...a: unknown[]) => Promise<unknown>).apply(target, args),
              [sql],
            );
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          tick(statements.length);
          return after(
            target.batch(
              statements.map(
                (s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s,
              ),
            ),
            statements.map((s) => String((s as unknown as Record<symbol, string>)[SQL] ?? "")),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted as D1Database, count };
}

/** The clock of every invocation of a test. */
let current = new Date("2026-11-04T00:00:00.000Z");
const clock = { now: () => current };
/** The mail of every invocation of a test. */
const mail: MailMessage[] = [];

/** One invocation: the engine on the counted view, or on the binding with no count. */
function make(counted: boolean, watch?: Watch) {
  const { db, count } = counted ? counting(env.DB, watch) : { db: env.DB, count: { queries: 0 } };
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    clock,
    mail: { send: async (m) => void mail.push(m) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    // An `afterEnd` hook: the claim reads its sessions and ends them by `deleteRows`.
    hooks: { session: { afterEnd: () => {} } },
  });
  return { auth, count };
}
type World = ReturnType<typeof make>;

/** The queries of one request, from a count of zero, with the work after the answer. */
async function measure(w: World, request: Request) {
  w.count.queries = 0;
  const after: Promise<unknown>[] = [];
  const res = await w.auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return { res, queries: w.count.queries };
}

let ip = 0;
const post = (path: string, body: unknown) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
    },
    body: JSON.stringify(body),
  });
const answer = async (res: Response) => {
  const text = await res.clone().text();
  let code = "ok";
  try {
    code = (JSON.parse(text || "{}") as { error?: string }).error ?? "ok";
  } catch {
    code = "page";
  }
  return `${res.status} ${code}`;
};

/** The claimant: a sign-up of the address and a sign-in, so the unverified user holds a password row and two sessions. */
async function claimant(email: string): Promise<string> {
  const other = make(false);
  for (const path of ["/password/sign-up", "/password/sign-in"])
    expect(
      await answer((await measure(other, post(path, { email, password: PASSWORD }))).res),
    ).toBe("200 ok");
  const user = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!user) throw new Error("no user");
  return user.id;
}

/** A magic link of the address, asked for with no count: the request of its verify. */
async function link(email: string): Promise<Request> {
  expect((await measure(make(false), post("/magic-link/request", { email }))).res.status).toBe(200);
  const text = mail.findLast((m) => m.to === email)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  return post("/magic-link/verify", { token });
}

/** The rows of a user that a claim reads or writes, on the binding. */
async function rowsOf(userId: string) {
  const user = await env.DB.prepare("SELECT email_verified AS v FROM ta_user WHERE id = ?")
    .bind(userId)
    .first<{ v: number }>();
  const count = async (table: string) =>
    (
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
        .bind(userId)
        .first<{ n: number }>()
    )?.n ?? 0;
  const lease = await env.DB.prepare(
    "SELECT purpose, identifier, expires_at AS expiresAt FROM ta_verification WHERE id = ?",
  )
    .bind(`claim-lease:${userId}`)
    .first<{ purpose: string; identifier: string; expiresAt: number | string }>();
  return {
    verified: user?.v === 1,
    passwords: await count("ta_password"),
    sessions: await count("ta_session"),
    lease: lease ? { purpose: lease.purpose, identifier: lease.identifier } : null,
  };
}

describe("the lease of a claim on D1 (ruling 16 of plan 12p)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("DELETE FROM ta_limit").run();
    mail.length = 0;
    current = new Date("2026-11-04T00:00:00.000Z");
  });

  it("claims with one query more than before: the lease, which stays after the claim", async () => {
    const userId = await claimant("ada@example.com");
    const w = make(true);
    const plain = await measure(w, await link("ada@example.com"));
    expect(await answer(plain.res)).toBe("200 ok");
    expect(await rowsOf(userId)).toEqual({
      verified: true,
      passwords: 0,
      sessions: 1,
      lease: { purpose: "claim-lease", identifier: userId },
    });
    expect(plain.queries).toBe(PINS.plain);
    expect(plain.queries).toBeLessThanOrEqual(BUDGET);
  });

  it("keeps the lease of a request that ran out of queries after it, answers 409 to a proof while it lives, and lets a claim take it after 60 seconds", async () => {
    const userId = await claimant("bea@example.com");
    // The first proof runs out of queries right after its lease, as a request at query 51 does.
    let capped = false;
    const first = make(true, async (sql) => {
      if (!capped && LEASE_INSERT.test(sql)) {
        capped = true;
        first.count.queries = BUDGET;
      }
    });
    const failed = await measure(first, await link("bea@example.com"));
    expect(capped).toBe(true);
    expect(failed.res.status).toBe(500);
    // Its undo ran out of queries too: the lease stays, and the claim wrote nothing else.
    expect(await rowsOf(userId)).toEqual({
      verified: false,
      passwords: 1,
      sessions: 2,
      lease: { purpose: "claim-lease", identifier: userId },
    });
    // While the lease lives, a proof meets it: 409, and no claim write.
    const held = await measure(make(true), await link("bea@example.com"));
    expect(await answer(held.res)).toBe("409 conflict");
    expect(await rowsOf(userId)).toEqual({
      verified: false,
      passwords: 1,
      sessions: 2,
      lease: { purpose: "claim-lease", identifier: userId },
    });
    // After 60 seconds the lease is stale, and the next claim takes it.
    current = new Date(current.getTime() + LEASE_MS + 1);
    const stale = await measure(make(true), await link("bea@example.com"));
    expect(await answer(stale.res)).toBe("200 ok");
    expect(await rowsOf(userId)).toEqual({
      verified: true,
      passwords: 0,
      sessions: 1,
      lease: { purpose: "claim-lease", identifier: userId },
    });
    const row = await env.DB.prepare("SELECT expires_at AS e FROM ta_verification WHERE id = ?")
      .bind(`claim-lease:${userId}`)
      .first<{ e: number | string }>();
    expect(new Date(row?.e ?? 0).getTime()).toBe(current.getTime() + LEASE_MS);
    expect({ held: held.queries, stale: stale.queries }).toEqual({
      held: PINS.held,
      stale: PINS.stale,
    });
    expect(Math.max(held.queries, stale.queries)).toBeLessThanOrEqual(BUDGET);
  });
});
