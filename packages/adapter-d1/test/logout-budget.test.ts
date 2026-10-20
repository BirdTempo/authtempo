import { env } from "cloudflare:test";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  type LimiterPort,
} from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The call budget of the sweep on real D1 (ruling 37 of plan 12f, review
// m3). D1 Free allows 50 queries per invocation (D1 limits page updated 21
// April 2026, read 2026-10-21). Workers Free allows 50 subrequests per
// invocation (Workers limits page updated 12 October 2026, read
// 2026-10-21). The view of the binding refuses query 51 as D1 Free does,
// and the test counts the posts of the sweep beside the queries.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const REDIRECT = "https://client.example.com/callback";
const APP = { kind: "app", name: "support-tool" } as const;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
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
/** Each post of a logout token: the URI and the `sid` and `aud` of its token. */
const posts: { uri: string; sid: string; aud: string }[] = [];

/** The claims of a JWT, with no check: the test reads what the client got. */
function claims(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/"))) as Record<
    string,
    unknown
  >;
}

/**
 * The engine on `db`, with a `session.afterEnd` hook and the OAuth
 * provider. `switched` adds secret version 2 as the current one, so a key
 * sealed under version 1 reseals at its first signature. Each call makes a
 * new adapter: one invocation. `limiter` replaces the limiter that allows
 * all and has no sweep.
 */
function engine(
  db: D1Database,
  mail: string[],
  switched = false,
  limiter: LimiterPort = { allow: async () => true },
) {
  const storage = createD1Adapter(db);
  const input: AuthConfig = {
    baseURL: BASE,
    ...(switched
      ? {
          secrets: [
            { version: 2, value: "fedcba9876543210fedcba9876543210" },
            { version: 1, value: "0123456789abcdef0123456789abcdef" },
          ],
        }
      : { secret: "0123456789abcdef0123456789abcdef" }),
    trustedOrigins: [APP_ORIGIN],
    storage,
    clock,
    limiter,
    mail: {
      send: async (m) => {
        mail.push(m.text);
      },
    },
    // A low iteration count: the test is about the count of statements, not hash work.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    session: { ttlDays: 7 },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    oauth: {
      resources: [`${BASE}/mcp`],
      scopes: { "mcp:read": "Read" },
      registration: { cimd: false, dynamic: true },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const token = new URLSearchParams(String(init?.body)).get("logout_token") ?? "";
        const c = claims(token);
        posts.push({ uri: String(url), sid: String(c.sid), aud: String(c.aud) });
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    },
    operator: { users: true },
    hooks: { session: { afterEnd: () => {} } },
  };
  return { auth: createAuth(input), storage };
}
type Engine = ReturnType<typeof engine>;

/** One sign-in by a magic link: the token and the session id. */
async function signIn(e: Engine, mail: string[], email: string) {
  await e.auth.api.requestMagicLink({ email, ip: null });
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "");
  const r = await e.auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  const s = await e.auth.api.getSession(r.value.token);
  if (!s) throw new Error("no session");
  return { token: r.value.token, sessionId: s.session.id, userId: s.user.id };
}

/** A client of the register route with a back-channel URI. */
async function client(e: Engine, name: string, pairwise: boolean): Promise<string> {
  const res = await e.auth.handle(
    new Request(`${BASE}/auth/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        backchannel_logout_uri: `https://client.example.com/bc/${name}`,
        ...(pairwise ? { subject_type: "pairwise" } : {}),
      }),
    }),
  );
  if (res.status !== 201) throw new Error(`register answered ${res.status}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

const base64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** The code flow with an ID token for the session of `token`: the token step links the session to the client. */
async function link(e: Engine, token: string, clientId: string) {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const cookie = `__Host-tempo_session=${token}`;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid mcp:read offline_access",
    resource: `${BASE}/mcp`,
    state: "st-1",
    nonce: "n-1",
  });
  const page = await e.auth.handle(
    new Request(`${BASE}/auth/oauth/authorize?${query}`, { headers: { cookie } }),
  );
  let location = page.headers.get("location");
  if (page.status === 200) {
    const id = /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
    const done = await e.auth.handle(
      new Request(`${BASE}/auth/oauth/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: BASE,
          cookie,
        },
        body: new URLSearchParams({ request_id: id ?? "", decision: "allow" }).toString(),
      }),
    );
    location = done.headers.get("location");
  }
  const code = new URL(location ?? "").searchParams.get("code");
  if (!code) throw new Error("no code");
  const res = await e.auth.handle(
    new Request(`${BASE}/auth/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: `${BASE}/mcp`,
      }).toString(),
    }),
  );
  if (res.status !== 200) throw new Error(`token answered ${res.status}`);
}

const rows = async (table: string) =>
  Number(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"));

describe("the logouts of the operator acts and the sweep on D1 with a cap of 50 queries (ruling 37 of plan 12f)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    posts.length = 0;
    current = new Date("2026-10-21T00:00:00.000Z");
  });

  it("an endUser of the app after a secret switch, with 10 pairwise links, sends no post and fits 50 queries", async () => {
    const mail: string[] = [];
    const setup = engine(env.DB, mail);
    const s = await signIn(setup, mail, "ada@example.com");
    for (let i = 0; i < 10; i++) await link(setup, s.token, await client(setup, `p${i}`, true));
    // Each call is one invocation after the switch: a delivery would reseal the key per row.
    const calls: { queries: number; ended: number; more: boolean }[] = [];
    for (let i = 0; i < 5; i++) {
      const { db, count } = counting(env.DB, 50);
      const done = await engine(db, mail, true).auth.api.operator.sessions.endUser({
        actor: APP,
        userId: s.userId,
        reason: "Lost laptop",
        ip: null,
        userAgent: null,
      });
      if (!done.ok) throw new Error(done.code);
      expect(count.refused).toBe(0);
      calls.push({ queries: count.queries, ended: done.value.ended, more: done.value.more });
      if (!done.value.more) break;
    }
    // Measured 2026-10-21: 50 queries in call 1 (the session, the links, the families) and 24 in
    // call 2. When each row signed and resealed in the call (review M2), call 1 met query 51 in
    // endFamilies after its commit.
    expect(calls.map((c) => [c.ended, c.more])).toEqual([
      [1, true],
      [0, false],
    ]);
    for (const c of calls) expect(c.queries).toBeLessThanOrEqual(50);
    expect(posts).toEqual([]);
    expect(await rows("ta_oauth_logout")).toBe(10);
    expect(await rows("ta_session")).toBe(0);
  }, 120_000);

  /**
   * 90 links of 45 sessions, ended by an app endAll, then sweeps until no link and no outbox
   * row stays. Each sweep is one invocation after a secret switch: its first signature reseals
   * the key. `order` sets the order of the links: each session's public link, then its
   * pairwise link, or all 45 pairwise links first. Each link gets its own millisecond, so the
   * link step reads the links in that order. With one time for all, the random part of each id
   * set the order, and the sweep count changed by run: 21 or 22 in the runs of 2026-10-21
   * (ruling 55 of plan 12f).
   */
  async function sweepNinety(order: "by session" | "pairwise first") {
    const mail: string[] = [];
    const setup = engine(env.DB, mail);
    const sessions: { token: string; sessionId: string }[] = [];
    for (let i = 0; i < 45; i++) sessions.push(await signIn(setup, mail, "ada@example.com"));
    const publicClient = await client(setup, "public", false);
    const pairwiseClient = await client(setup, "pairwise", true);
    const pairs: { token: string; clientId: string }[] =
      order === "by session"
        ? sessions.flatMap((s) => [
            { token: s.token, clientId: publicClient },
            { token: s.token, clientId: pairwiseClient },
          ])
        : [
            ...sessions.map((s) => ({ token: s.token, clientId: pairwiseClient })),
            ...sessions.map((s) => ({ token: s.token, clientId: publicClient })),
          ];
    for (const { token, clientId } of pairs) {
      await link(setup, token, clientId);
      current = new Date(current.getTime() + 1);
    }
    expect(await rows("ta_oauth_session_client")).toBe(90);
    // The app ends all sessions: a page with a hook has no room for links, so each link stays.
    const ended = await engine(env.DB, mail).auth.api.operator.sessions.endAll({
      actor: APP,
      reason: "Key leak",
      ip: null,
      userAgent: null,
    });
    if (!ended.ok) throw new Error(ended.code);
    expect([ended.value.ended, await rows("ta_session"), await rows("ta_oauth_logout")]).toEqual([
      45, 0, 0,
    ]);
    expect(await rows("ta_oauth_session_client")).toBe(90);
    const sweeps: { queries: number; posts: number; links: number; logouts: number }[] = [];
    for (let i = 0; i < 40; i++) {
      current = new Date(current.getTime() + HOUR_MS);
      const { db, count } = counting(env.DB, 50);
      const before = posts.length;
      const swept = await engine(db, mail, true).auth.api.sweepExpired();
      expect(count.refused, `sweep ${i + 1}`).toBe(0);
      sweeps.push({
        queries: count.queries,
        posts: posts.length - before,
        links: swept.oauthSessionLinks,
        logouts: swept.oauthLogouts,
      });
      if ((await rows("ta_oauth_session_client")) + (await rows("ta_oauth_logout")) === 0) break;
    }
    // Every sweep fits 50 calls with its posts: 47 at the most in the runs of 2026-10-21. While
    // links stay, the link step makes 16 rows a sweep; then each sweep sends 5 or 6 rows. The
    // read of the pending-end rows (ruling 50 of plan 12f) takes 1 call: it was 17 before.
    for (const s of sweeps) expect(s.queries + s.posts).toBeLessThanOrEqual(50);
    expect(sweeps.map((s) => s.links).slice(0, 6)).toEqual([16, 16, 16, 16, 16, 10]);
    // Each link gave one post: no row went out twice.
    const sent = posts.map((p) => `${p.aud}:${p.sid}`);
    expect(sent).toHaveLength(90);
    expect(new Set(sent).size).toBe(90);
    expect(
      posts
        .filter((p) => p.aud === publicClient)
        .map((p) => p.sid)
        .sort(),
    ).toEqual(sessions.map((s) => s.sessionId).sort());
    expect(await rows("ta_oauth_session_client")).toBe(0);
    expect(await rows("ta_oauth_logout")).toBe(0);
    return sweeps;
  }

  // The cost of the order (ruling 57 of plan 12f). The outbox rows of one link page have one
  // due time, and the read gives them in the order of the page. A pairwise row costs 1 call
  // more than a public row: the read of its subject. Before each row, the outbox step keeps 9
  // calls for it and 2 for each claimed row that waits. Sweep 1 spends 1 more call on the
  // reseal of the key. Sweeps 4 and 5 read the outbox twice, because 50 or more rows wait. So
  // in sweeps 1, 4, and 5, a pairwise row first takes the call that a second row needs. The
  // link sweeps 1 to 6 send 2, 2, 2, 2, 2, and 3 rows with a public row first. With a pairwise
  // row first, they send 1, 2, 2, 1, 1, and 3. After the links, a sweep sends 6 rows when a
  // public row is first and fewer than 50 rows wait. Every other sweep after the links sends 5.
  // So no order sends fewer than 10 rows in the 6 link sweeps, or fewer than 5 in a later
  // sweep: at most 6 + 80 / 5 = 22 sweeps. The best order takes 20.

  it("delivers each of 90 links once, and leaves no link and no outbox row, after a secret switch", async () => {
    const sweeps = await sweepNinety("by session");
    expect(sweeps.map((s) => s.posts)).toEqual([
      2, 2, 2, 2, 2, 3, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6,
    ]);
    // All 90 rows are sent and deleted within 22 sweeps in any order: 22 hours with an hourly
    // cron. This order takes 20.
    expect(sweeps.length).toBeLessThanOrEqual(22);
  }, 300_000);

  it("takes 22 sweeps for 90 links when the pairwise links come first, the worst order", async () => {
    const sweeps = await sweepNinety("pairwise first");
    // A pairwise row is first at sweeps 1, 4, and 5, and after the links until the public rows
    // lead: 10 rows in the 6 link sweeps, then 5 a sweep, then 6. This order meets the bound.
    expect(sweeps.map((s) => s.posts)).toEqual([
      1, 2, 2, 1, 1, 3, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 2,
    ]);
    expect(sweeps.length).toBe(22);
  }, 300_000);

  it("makes link rows in each sweep beside 30 idle clients, and sends each of 90 links once", async () => {
    const mail: string[] = [];
    const setup = engine(env.DB, mail);
    // A client of the register route that no flow sees for 90 days is idle: the sweep deletes it.
    for (let i = 0; i < 30; i++) await client(setup, `idle${i}`, false);
    current = new Date(current.getTime() + 91 * DAY_MS);
    const sessions: { token: string }[] = [];
    for (let i = 0; i < 45; i++) sessions.push(await signIn(setup, mail, "ada@example.com"));
    const publicClient = await client(setup, "public", false);
    const pairwiseClient = await client(setup, "pairwise", true);
    // Each link gets its own millisecond, so the order of the links, and the count of each sweep,
    // is the same in each run (ruling 55 of plan 12f).
    for (const s of sessions) {
      await link(setup, s.token, publicClient);
      current = new Date(current.getTime() + 1);
      await link(setup, s.token, pairwiseClient);
      current = new Date(current.getTime() + 1);
    }
    const ended = await engine(env.DB, mail).auth.api.operator.sessions.endAll({
      actor: APP,
      reason: "Key leak",
      ip: null,
      userAgent: null,
    });
    if (!ended.ok) throw new Error(ended.code);
    expect([await rows("ta_oauth_session_client"), await rows("ta_oauth_client")]).toEqual([
      90, 32,
    ]);
    const sweeps: {
      queries: number;
      posts: number;
      links: number;
      clients: number;
      waiting: number;
    }[] = [];
    for (let i = 0; i < 60; i++) {
      current = new Date(current.getTime() + HOUR_MS);
      const waiting = await rows("ta_oauth_session_client");
      const { db, count } = counting(env.DB, 50);
      const before = posts.length;
      // The limiter on D1 adds its delete to the count of the sweep.
      const swept = await engine(
        db,
        mail,
        false,
        createD1Limiter(db, clock),
      ).auth.api.sweepExpired();
      expect(count.refused, `sweep ${i + 1}`).toBe(0);
      sweeps.push({
        queries: count.queries,
        posts: posts.length - before,
        links: swept.oauthSessionLinks,
        clients: swept.oauthClients,
        waiting,
      });
      if ((await rows("ta_oauth_session_client")) + (await rows("ta_oauth_logout")) === 0) break;
    }
    for (const s of sweeps) expect(s.queries + s.posts).toBeLessThanOrEqual(50);
    // The idle client step ends at 50 - 16 - 8 = 26 calls, after every single-statement step. So
    // the link step gets 8 calls or more: its page makes at least 4 rows while links wait. The
    // outbox step gets 16 calls or more, so it sends at least 1 row. These floors do not change
    // with the count of idle clients. So the 90 links go out within 90 sweeps for any count.
    expect(sweeps.reduce((n, s) => n + s.clients, 0)).toBe(30);
    expect(sweeps[0]?.clients).toBeGreaterThan(0);
    for (const [i, s] of sweeps.entries()) {
      expect(s.links, `sweep ${i + 1}`).toBeGreaterThanOrEqual(Math.min(4, s.waiting));
      expect(s.posts, `sweep ${i + 1}`).toBeGreaterThanOrEqual(1);
    }
    expect(sweeps.length).toBeLessThanOrEqual(90);
    // Measured 2026-10-21: 7 link rows and 3 idle clients a sweep, at most 46 calls, and the last row
    // at sweep 24. Before the change, sweeps 1 to 6 made no link row, and the last row went out at
    // sweep 27 (review m1, probe N2). On d791dbe0 (2026-10-21), sweeps 1 to 10 make 6 link rows
    // each, and the last row goes out at sweep 26 in each run.
    expect(sweeps.length).toBe(26);
    expect(sweeps.length).toBeLessThanOrEqual(30);
    const sent = posts.map((p) => `${p.aud}:${p.sid}`);
    expect(sent).toHaveLength(90);
    expect(new Set(sent).size).toBe(90);
    expect(await rows("ta_oauth_session_client")).toBe(0);
    expect(await rows("ta_oauth_logout")).toBe(0);
    expect(await rows("ta_oauth_client")).toBe(2);
  }, 300_000);
});
