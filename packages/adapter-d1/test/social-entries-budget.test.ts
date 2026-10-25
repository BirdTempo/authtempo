import { env } from "cloudflare:test";
import { type AuthConfig, createAuth } from "@authtempo/core";
import { tiktokEntry, wechatEntry } from "@authtempo/core/social-entries";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of each TikTok and WeChat callback on the D1 binding (plan 12i
// Task 22). D1 Free allows 50 queries per invocation (D1 limits page updated
// 21 April 2026, read 2026-10-24). One request is one invocation. The limiter
// is the D1 limiter, so its queries count too. The view of the binding
// refuses query 51 as D1 Free does. The provider calls go to a fake fetch.

const BASE = "https://api.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
// The counts of the run of 2026-10-24, with the D1 limiter: the first
// sign-in makes the user, and the second finds it by the identity. The
// second sign-in of a user with an unverified address (a Better Auth-era
// placeholder, or none) keeps the guard on its identity row: two queries.
const START_QUERIES = 3;
const FIRST_QUERIES = 7;
const AGAIN_QUERIES = 8;

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

/** The answers of the two providers, by URL with no query. */
const ANSWERS: Record<string, unknown> = {
  "https://open.tiktokapis.com/v2/oauth/token/": { access_token: "act.d1", open_id: "-000d1" },
  "https://open.tiktokapis.com/v2/user/info/": {
    data: { user: { open_id: "-000d1", display_name: "Tia" } },
    error: { code: "ok", message: "", log_id: "1" },
  },
  "https://api.weixin.qq.com/sns/oauth2/access_token": {
    access_token: "wx-d1",
    openid: "owxd1",
    unionid: "uwxd1",
  },
  "https://api.weixin.qq.com/sns/userinfo": { openid: "owxd1", unionid: "uwxd1", nickname: "Wen" },
};

const fakeFetch: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = url.split("?")[0] ?? "";
  return Object.hasOwn(ANSWERS, path)
    ? Response.json(ANSWERS[path])
    : new Response("nf", { status: 404 });
};

/** The engine on a counting view of the binding, with the D1 limiter on the same view. */
function make(extra: Partial<AuthConfig> = {}) {
  const { db, count } = counting(env.DB);
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async () => {} },
    social: {
      oauth2: [
        tiktokEntry({ clientKey: "tt-key", clientSecret: "tt-secret" }),
        wechatEntry({ appId: "wx-app", appSecret: "wx-secret" }),
      ],
      fetch: fakeFetch,
    },
    ...extra,
  });
  return { auth, count };
}

/** One sign-in through the routes: the queries of the start and of the callback. */
async function signIn(w: ReturnType<typeof make>, provider: string) {
  w.count.queries = 0;
  const start = await w.auth.handle(new Request(`${BASE}/auth/social/${provider}/start`));
  const startQueries = w.count.queries;
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const bind = /^([^=]+=[^;]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1] ?? "";
  w.count.queries = 0;
  const done = await w.auth.handle(
    new Request(
      `${BASE}/auth/social/${provider}/callback?code=c1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: bind } },
    ),
  );
  const signedIn = done.headers.getSetCookie().some((c) => c.startsWith("__Host-tempo_session="));
  return { startQueries, queries: w.count.queries, status: done.status, signedIn };
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
});

describe("the TikTok and WeChat entries on D1 (plan 12i Task 22)", () => {
  it("signs in by the identity within the D1 Free budget", async () => {
    for (const provider of ["tiktok", "wechat"]) {
      const w = make();
      const first = await signIn(w, provider);
      expect(first, provider).toMatchObject({ status: 302, signedIn: true });
      expect(first.startQueries, provider).toBe(START_QUERIES);
      expect(first.queries, provider).toBe(FIRST_QUERIES);
      const again = await signIn(w, provider);
      expect(again, provider).toMatchObject({ status: 302, signedIn: true });
      expect(again.queries, provider).toBe(AGAIN_QUERIES);
      expect(Math.max(first.startQueries, first.queries, again.queries)).toBeLessThanOrEqual(
        BUDGET,
      );
    }
    const users = await env.DB.prepare("SELECT email FROM ta_user").all<{ email: string | null }>();
    expect(users.results.map((u) => u.email)).toEqual([null, null]);
  });
});
