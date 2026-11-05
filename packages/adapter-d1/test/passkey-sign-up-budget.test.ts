import { env } from "cloudflare:test";
import { type AuthConfig, createAuth } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { SoftAuthenticator } from "@authtempo/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of the passkey-first sign-up on the D1 binding (plan 12i Task
// 8). D1 Free allows 50 queries per invocation (D1 limits page updated 21
// April 2026, read 2026-10-24). One request is one invocation. The limiter
// is the D1 limiter, so its queries count too. The view of the binding
// refuses query 51 as D1 Free does. Every hook that the sign-up can run is
// set, so each count is the worst case.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
// The counts of the run of 2026-10-25, with the D1 limiter. `options` and
// `verify` are a sign-up with no session. `upgrade` is the verify that
// replaces an anonymous user: the claim, the session end, and the delete.
// `taken` is the verify of a credential id that exists. The daily cap of
// ruling 38 M3 adds one limiter query to each options call.
// Update 2026-11-05 by plan 12q: `verify` and `upgrade` open a session, and
// its cap read adds one query (+1).
// Measured 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
const PINS = { options: 4, verify: 8, upgradeOptions: 5, upgrade: 21, taken: 4 };

/** A view of `db` that counts each statement, and each statement of a batch. Query `BUDGET + 1` throws. */
function counting(db: D1Database) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (count.queries + n > BUDGET)
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

function make(extra: Partial<AuthConfig> = {}) {
  const { db, count } = counting(env.DB);
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async () => {} },
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE], signUp: true },
    anonymous: {},
    hooks: {
      user: { beforeCreate: () => {}, afterCreate: () => {}, afterDelete: () => {} },
      session: { beforeCreate: () => {}, afterCreate: () => {}, afterEnd: () => {} },
      anonymous: { beforeLink: () => {}, afterLink: () => {} },
    },
    ...extra,
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
const post = (path: string, body: unknown, cookie: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

/** The bytes of a base64url text. */
function bytesOf(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}

/** The options and the registration of `soft`, or of a new authenticator. */
async function ceremony(w: World, cookie: string | null, soft?: SoftAuthenticator) {
  const options = await measure(w, post("/passkey/sign-up/options", { name: "Ana" }, cookie));
  expect(options.res.status).toBe(200);
  const o = (await options.res.json()) as { challenge: string; user: { id: string } };
  const auth = soft ?? (await SoftAuthenticator.create({ rpID: "api.example.com", origin: BASE }));
  const response = await auth.register(o.challenge, bytesOf(o.user.id));
  return { soft: auth, response, queries: options.queries };
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
});

describe("the passkey-first sign-up on D1 (plan 12i Task 8)", () => {
  it("keeps the options and the verify within the D1 Free budget", async () => {
    const w = make();
    const first = await ceremony(w, null);
    const done = await measure(w, post("/passkey/sign-up/verify", { response: first.response }));
    expect(done.res.status).toBe(200);

    // The upgrade of an anonymous user in the same browser.
    const anon = await measure(w, post("/anonymous/sign-in", {}));
    const line = anon.res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
    const jar = line?.split(";")[0] ?? null;
    const upgrade = await ceremony(w, jar);
    const linked = await measure(
      w,
      post("/passkey/sign-up/verify", { response: upgrade.response }, jar),
    );
    expect(linked.res.status).toBe(200);

    // The same authenticator again: its credential id exists.
    const again = await ceremony(w, null, first.soft);
    const taken = await measure(w, post("/passkey/sign-up/verify", { response: again.response }));
    expect(await taken.res.json()).toEqual({ error: "passkey_failed" });
    // The refused sign-up wrote no user: the passkey row comes first. The
    // pin `taken` also holds that order: the user row first adds its insert
    // and its undo (ruling 38 L2). Core's write-order test names the order.
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM ta_user").first<{ n: number }>();
    expect(users?.n).toBe(2);

    expect({
      options: first.queries,
      verify: done.queries,
      upgradeOptions: upgrade.queries,
      upgrade: linked.queries,
      taken: taken.queries,
    }).toEqual(PINS);
    for (const n of Object.values(PINS)) expect(n).toBeLessThanOrEqual(BUDGET);
  });
});
