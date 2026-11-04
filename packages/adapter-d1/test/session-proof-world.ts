import { env } from "cloudflare:test";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { createRecordingSms } from "@authtempo/core/testing";
import { expect } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The world of the session proof tests on the D1 binding (plan 12p Task 3).
// It holds the engine on a counted view, the requests, and the reads of the
// tables. session-proof-window.test.ts and session-proof-straddle.test.ts
// share it.

export const BASE = "https://api.example.com";
export const APP_ORIGIN = "https://app.example.com";
// D1 Free allows 50 queries per invocation (D1 limits page updated 21
// April 2026, read 2026-10-24, as anonymous-upgrade-budget.test.ts says).
export const BUDGET = 50;
export const CLAIMED = "ada@example.com";
export const OLD = "correct horse battery";
export const NEW = "another long password";
export const PHONE = "+14155550100";
export const REDIRECT = "https://client.example.com/callback";
export const RESOURCE = `${BASE}/mcp`;
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const COOKIE = "__Host-tempo_session";
const RAW = Symbol("raw");
const SQL = Symbol("sql");
/** The flip of a claim. The undo of a flip sets each value by a CASE form, so it does not match. */
export const FLIP = /^UPDATE ta_user SET email_verified = \?/;
/** The first statement of a claim on D1: the create of its lease (ruling 16 of plan 12p). */
export const LEASE = /^INSERT INTO ta_verification\b/;

/** A step that runs beside one statement of a request. */
export type Watch = (sql: string) => Promise<void>;

/**
 * A view of `db` that counts each statement, and each statement of a batch.
 * The statement past the budget throws, as D1 Free does. `before` runs
 * before each statement is sent, and `after` runs after it answers.
 */
export function counting(db: D1Database, after?: Watch, before?: Watch) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (count.queries + n > BUDGET)
      throw new Error("Too many API requests by single worker invocation.");
    count.queries += n;
  };
  const around = async <T>(texts: string[], send: () => Promise<T>): Promise<T> => {
    for (const text of texts) await before?.(text);
    const done = await send();
    for (const text of texts) await after?.(text);
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
            return around([sql], () =>
              (target[key] as (...a: unknown[]) => Promise<unknown>).apply(target, args),
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
          return around(
            statements.map((s) => String((s as unknown as Record<symbol, string>)[SQL] ?? "")),
            () =>
              target.batch(
                statements.map(
                  (s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s,
                ),
              ),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted as D1Database, count };
}

export const mail: MailMessage[] = [];
export const sms = createRecordingSms();
/** Each session end that the hook saw, as `reason:id`. */
export const endings: string[] = [];
/** The claims that the ID-token seam answers next. */
export const claims: { current: Record<string, unknown> } = { current: {} };

/** One invocation: the engine on the counted view, or on the binding with no count. */
export function make(opts: { counted: boolean; hook: boolean; after?: Watch; before?: Watch }) {
  const { db, count } = opts.counted
    ? counting(env.DB, opts.after, opts.before)
    : { db: env.DB, count: { queries: 0 } };
  const config: AuthConfig = {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async (m) => void mail.push(m) },
    password: {
      hash: createPbkdf2PasswordHash({ iterations: 1000 }),
      uniformSignUp: false,
      requireVerified: false,
    },
    social: {
      google: { clientId: "gid", clientSecret: "gsecret" },
      fetch: async () =>
        Response.json({ id_token: "idtok", access_token: "at", token_type: "Bearer" }),
    },
    jwt: { verifyIdToken: async () => claims.current, signES256: async () => "es256" },
    organizations: { teams: {} },
    username: {},
    phone: { sms, regions: ["+1"] },
    passkey: { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] },
    oauth: {
      resources: [RESOURCE],
      scopes: { "mcp:read": "Read your documents" },
      registration: { cimd: false, dynamic: true },
      device: {},
    },
    hooks: opts.hook
      ? { session: { afterEnd: (e) => void endings.push(`${e.reason}:${e.session.id}`) } }
      : {},
  };
  return { auth: createAuth(config), count };
}
export type World = ReturnType<typeof make>;

let ip = 0;
const nextIp = () => `198.51.100.${(++ip % 250) + 1}`;
export const post = (path: string, body: unknown, token: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": nextIp(),
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
export const get = (path: string, token: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    headers: { "cf-connecting-ip": nextIp(), ...(token ? { cookie: `${COOKIE}=${token}` } : {}) },
  });
/** A form post of the OAuth routes, from the origin of the base URL, as their pages send it. */
export const form = (path: string, body: Record<string, string>, token: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      "cf-connecting-ip": nextIp(),
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });

/** The queries of one request, from a count of zero, with the work after the answer. */
export async function measure(w: World, request: Request) {
  w.count.queries = 0;
  const after: Promise<unknown>[] = [];
  const res = await w.auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return { res, queries: w.count.queries };
}
export const call = async (w: World, request: Request) => (await measure(w, request)).res;

/** The status and the error code of an answer: "200 ok", "403 email_unverified", "200 page". */
export async function answer(res: Response): Promise<string> {
  const text = await res.clone().text();
  let code = "ok";
  try {
    code = (JSON.parse(text || "{}") as { error?: string }).error ?? "ok";
  } catch {
    code = "page";
  }
  return `${res.status} ${code}`;
}
export const tokenIn = (text: string) =>
  decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
export const lastTo = (email: string) => mail.findLast((m) => m.to === email)?.text ?? "";
/** The session token that an answer sets in the cookie, or null. */
export function tokenOf(res: Response): string | null {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
  const token = line?.slice(COOKIE.length + 1).split(";")[0] ?? "";
  return token === "" ? null : token;
}
export function setToken(res: Response): string {
  const token = tokenOf(res);
  if (token === null) throw new Error("the answer set no session cookie");
  return token;
}

/** Empty tables, an empty limiter, and no mail, SMS, or hook record. */
export async function clear() {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
  mail.length = 0;
  sms.sent.length = 0;
  endings.length = 0;
}

/**
 * Every table after a scene, in a form that two runs can share. It holds
 * the count of rows of each table and the purpose of each verification row.
 * It also holds the status of each device grant, and the fields of the
 * claimed user that a request can set.
 */
export async function everyTable() {
  const counts: Record<string, number> = {};
  for (const table of Object.values(TABLES).sort())
    counts[table] = Number(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"));
  const column = async (sql: string) =>
    (await env.DB.prepare(sql).all<{ v: string }>()).results.map((r) => r.v);
  return {
    counts,
    purposes: await column("SELECT purpose AS v FROM ta_verification ORDER BY purpose"),
    devices: await column("SELECT status AS v FROM ta_oauth_device ORDER BY status"),
    user: await env.DB.prepare(
      "SELECT email_verified AS verified, username, phone FROM ta_user WHERE email = ?",
    )
      .bind(CLAIMED)
      .first(),
  };
}

export async function userId(email: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!row) throw new Error(`no user at ${email}`);
  return row.id;
}
export const sessionsOf = async (id: string) =>
  (
    await env.DB.prepare("SELECT id, proved FROM ta_session WHERE user_id = ? ORDER BY id")
      .bind(id)
      .all<{ id: string; proved: number }>()
  ).results;

/** A verified user by a magic link of its own address: the session token. */
export async function verified(w: World, email: string): Promise<string> {
  expect((await call(w, post("/magic-link/request", { email }))).status).toBe(200);
  const res = await call(w, post("/magic-link/verify", { token: tokenIn(lastTo(email)) }));
  expect(await answer(res)).toBe("200 ok");
  return setToken(res);
}

/** The owner's magic link of the claimed address, mailed now: the request of its verify. */
export async function ownerLink(w: World): Promise<Request> {
  expect((await call(w, post("/magic-link/request", { email: CLAIMED }))).status).toBe(200);
  return post("/magic-link/verify", { token: tokenIn(lastTo(CLAIMED)) });
}

let idTokens = 0;
/** An ID-token sign-in by Google with `sub`, for the claimed address, with the provider's flag. */
export async function googleIdToken(w: World, sub: string, emailVerified: boolean) {
  const nonce = (await (await call(w, post("/social/google/id-token/nonce", {}))).json()) as {
    nonce: string;
    providerNonce: string;
  };
  const iat = Math.floor(Date.now() / 1000);
  claims.current = {
    iss: "https://accounts.google.com",
    aud: "gid",
    sub,
    email: CLAIMED,
    email_verified: emailVerified,
    nonce: nonce.providerNonce,
    iat,
    exp: iat + 3600,
  };
  // Core refuses a replay of one ID token, so each sign-in sends a new token text.
  return post("/social/google/id-token", {
    idToken: `h.${btoa(`${sub}:${++idTokens}`).replace(/=/g, "")}.s`,
    nonce: nonce.nonce,
  });
}
