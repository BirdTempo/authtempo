import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of multi-session on the D1 binding (plan 12i Task 11). D1 Free
// allows 50 queries per invocation (D1 limits page updated 21 April 2026,
// read 2026-10-24). One request is one invocation. The limiter is the D1
// limiter, so its queries count too. The view of the binding refuses query
// 51 as D1 Free does. Each request runs with a full browser: max 10, so the
// active session and nine bag tokens.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const SESSION = "__Host-tempo_session";
const BAG = "__Host-tempo_sessions";
const PASSWORD = "correct horse battery";
const NOW = new Date("2026-10-25T00:00:00.000Z");
const DAY_MS = 86_400_000;
/** The time past NOW: a test moves it to make the sessions of the browser due for a refresh. */
let shift = 0;
const now = () => new Date(NOW.getTime() + shift);
// The counts of the run of 2026-10-25, with the D1 limiter and one fixed
// time, so each session read also reads the SCIM record (the worst count).
// A first sign-in in a browser reads no bag. A sign-in with a full bag reads
// every row of the browser in one query, and reads the user of the old active
// session. It ends the bag session that the browser used least recently
// (displaced), never the active one. The list and the
// switch resolve each of the nine bag tokens. The switch then reads its
// target as a request does, 3 queries more (ruling 34 H1 of plan 12i). The
// sign-out ends ten sessions.
// Update 2026-11-04 by plan 12p: each sign-up reads the claim lease (+1).
// Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
// Update 2026-11-05 by plan 12q: each sign-up opens a session, and its cap
// read adds one query (+1).
// Measured 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
const SIGN_UP_EMPTY_QUERIES = 15;
const SIGN_UP_FULL_QUERIES = 19;
const LIST_QUERIES = 31;
const SWITCH_QUERIES = 34;
const SESSION_READ_QUERIES = 3;
const SIGN_OUT_QUERIES = 33;
const IDLE_LIST_QUERIES = 32;
const IDLE_SWITCH_QUERIES = 36;
const IDLE_LIST_SAML_QUERIES = 33;
const IDLE_SWITCH_SAML_QUERIES = 38;

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

/** The engine on a counting view of the binding, with the D1 limiter on the same view. */
function make(extra: Partial<AuthConfig> = {}) {
  const { db, count } = counting(env.DB);
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db, { now }),
    mail: { send: async () => {} },
    // The detailed answer: the sign-up opens a session with the cookie, a browser sign-in.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    multiSession: { max: 10 },
    // One fixed time: each user row and its first session share a time, so
    // each session read takes the SCIM record read too, the worst count.
    clock: { now },
    ...extra,
  });
  return { auth, count };
}
type World = ReturnType<typeof make>;

/** A browser: the cookies that the answers set, sent back on each request. */
function browser() {
  const cookies = new Map<string, string>();
  return {
    cookies,
    header(): Record<string, string> {
      if (cookies.size === 0) return {};
      return { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
    },
    take(res: Response): void {
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        const value = pair.slice(eq + 1);
        if (value === "") cookies.delete(pair.slice(0, eq));
        else cookies.set(pair.slice(0, eq), value);
      }
    },
  };
}
type Browser = ReturnType<typeof browser>;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/auth${path}`, { headers });

/** The queries of one request in browser `b`, from a count of zero. */
async function measure(w: World, b: Browser, request: Request) {
  w.count.queries = 0;
  const res = await w.auth.handle(request);
  b.take(res);
  return { status: res.status, body: (await res.json()) as unknown, queries: w.count.queries };
}

/**
 * A sign-up in browser `b`: a new user, and a browser sign-in. Each from
 * its own IP, so the per-IP sign-up limit does not refuse the eleventh.
 */
let ip = 0;
const signUp = (w: World, b: Browser, email: string) =>
  measure(
    w,
    b,
    post(
      "/password/sign-up",
      { email, password: PASSWORD },
      { ...b.header(), "cf-connecting-ip": `198.51.100.${++ip}` },
    ),
  );

beforeEach(async () => {
  shift = 0;
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
});

describe("multi-session on D1 (plan 12i Task 11)", () => {
  it("keeps each request of a full browser within the D1 Free budget", async () => {
    const w = make();
    const b = browser();
    const first = await signUp(w, b, "user0@example.com");
    expect(first.status).toBe(200);
    for (let i = 1; i < 10; i++)
      expect((await signUp(w, b, `user${i}@example.com`)).status).toBe(200);
    expect(b.cookies.get(BAG)?.split(".")).toHaveLength(9);
    // The eleventh user: the bag is full, so the least recently used bag session ends.
    const full = await signUp(w, b, "user10@example.com");
    expect(full.status).toBe(200);
    expect(b.cookies.get(BAG)?.split(".")).toHaveLength(9);
    const list = await measure(w, b, get("/multi-session", b.header()));
    expect(list.status).toBe(200);
    expect((list.body as { sessions: unknown[] }).sessions).toHaveLength(10);
    const target = (
      list.body as { sessions: { sessionId: string; active: boolean }[] }
    ).sessions.at(-1);
    const activeBefore = b.cookies.get(SESSION);
    const switched = await measure(
      w,
      b,
      post("/multi-session/switch", { sessionId: target?.sessionId }, b.header()),
    );
    expect(switched.status).toBe(200);
    expect(b.cookies.get(SESSION)).not.toBe(activeBefore);
    // Any other request with a full bag: core reads no bag outside the multi-session routes.
    const read = await measure(w, b, get("/session", b.header()));
    expect(read.status).toBe(200);
    const out = await measure(w, b, post("/sign-out", {}, b.header()));
    expect(out.status).toBe(200);
    expect(b.cookies.size).toBe(0);
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM ta_session").first<{ n: number }>())?.n,
    ).toBe(0);
    expect([
      first.queries,
      full.queries,
      list.queries,
      switched.queries,
      read.queries,
      out.queries,
    ]).toEqual([
      SIGN_UP_EMPTY_QUERIES,
      SIGN_UP_FULL_QUERIES,
      LIST_QUERIES,
      SWITCH_QUERIES,
      SESSION_READ_QUERIES,
      SIGN_OUT_QUERIES,
    ]);
  });
  // Ruling 34 H1 of plan 12i: a list or a switch with idle bag sessions.
  // Eight days after the sign-ups each session is due for its sliding
  // refresh (slidingRefreshDays 7). A bag read never slides, so only the
  // active session and the switch target do: 1 update each. With sso.saml
  // on, each slide also reads the session-cap row. Before the fix, the nine
  // bag slides took a list to 51 here. The counts of the run of 2026-10-25.
  // Each leaves 12 or more queries under 50 for an app's session hooks.
  const SAML = {
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    sso: { saml: true, dns: [{ name: "a", txt: async () => [] }] },
  } satisfies Partial<AuthConfig>;
  for (const [name, extra, listQueries, switchQueries] of [
    ["the default config", {}, IDLE_LIST_QUERIES, IDLE_SWITCH_QUERIES],
    ["organizations and sso.saml on", SAML, IDLE_LIST_SAML_QUERIES, IDLE_SWITCH_SAML_QUERIES],
  ] as const)
    it(`keeps a list and a switch of idle bag sessions within the budget: ${name}`, async () => {
      const w = make(extra);
      const b = browser();
      for (let i = 0; i < 10; i++)
        expect((await signUp(w, b, `user${i}@example.com`)).status).toBe(200);
      expect(b.cookies.get(BAG)?.split(".")).toHaveLength(9);
      shift = 8 * DAY_MS;
      const list = await measure(w, b, get("/multi-session", b.header()));
      expect(list.status).toBe(200);
      const sessions = (list.body as { sessions: { sessionId: string }[] }).sessions;
      expect(sessions).toHaveLength(10);
      // Eight days more: the active session is due again, and the target was never slid.
      shift = 16 * DAY_MS;
      const switched = await measure(
        w,
        b,
        post("/multi-session/switch", { sessionId: sessions.at(-1)?.sessionId }, b.header()),
      );
      expect(switched.status).toBe(200);
      expect(b.cookies.get(BAG)?.split(".")).toHaveLength(9);
      expect([list.queries, switched.queries]).toEqual([listQueries, switchQueries]);
    });
});
