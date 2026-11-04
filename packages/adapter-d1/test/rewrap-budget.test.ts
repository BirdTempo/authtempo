import { env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of one rewrap call on the D1 binding (rulings 31 and 33 of
// plan 12d). D1 Free allows 50 queries per invocation (D1
// limits page updated 21 April 2026, read 2026-10-21). Each connection comes
// from api.sso.connections.create under version 1; the rewrap runs under
// versions 2 and 1.

const V1 = "0123456789abcdef0123456789abcdef";
const V2 = "Zq7Xw2Lp9Vt4Rk8Nc3Hm6Bf1Jd5Gs0Ya";

/** A view of `db` that counts each statement, and each statement of a batch. */
function counting(db: D1Database) {
  const c = { n: 0 };
  const hit = (b: PropertyKey) => b === "run" || b === "all" || b === "first" || b === "raw";
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(a, b) {
        if (b === "bind") return (...v: unknown[]) => wrap(a.bind(...v));
        if (hit(b)) c.n++;
        const x = Reflect.get(a, b);
        return typeof x === "function" ? x.bind(a) : x;
      },
    });
  const counted = new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
      if (k === "batch")
        return (st: D1PreparedStatement[]) => {
          c.n += st.length;
          return t.batch(st);
        };
      const x = Reflect.get(t, k);
      return typeof x === "function" ? x.bind(t) : x;
    },
  });
  return { db: counted as D1Database, c };
}

/** The queries of a rewrap of `n` connections, and the rows it resealed. */
async function rewrapWith(n: number): Promise<{ queries: number; resealed: number }> {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const mail: string[] = [];
  const make = (db: D1Database, secrets: { version: number; value: string }[]) =>
    createAuth({
      baseURL: "https://api.example.com",
      secrets,
      trustedOrigins: [],
      storage: createD1Adapter(db),
      limiter: { allow: async () => true },
      mail: { send: async (m) => void mail.push(m.text) },
      organizations: {},
      sso: { oidc: true, dns: [{ name: "a", txt: async () => [] }] },
    });
  const v1 = make(env.DB, [{ version: 1, value: V1 }]);
  await v1.api.requestMagicLink({ email: "ada@example.com", ip: null });
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "");
  const r = await v1.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  const made = await v1.api.createOrganization({ user: r.value.user, slug: "acme", name: "Acme" });
  if (!made.ok) throw new Error(made.code);
  for (let i = 0; i < n; i++) {
    const c = await v1.api.sso?.connections.create({
      actor: { kind: "app", name: "budget" },
      organizationId: made.value.organization.id,
      kind: "oidc",
      label: `IdP ${i}`,
      issuer: "https://login.idp.example/acme",
      clientId: `client-${i}`,
      clientSecret: `secret-${i}-0123456789`,
    });
    if (!c?.ok) throw new Error("no connection");
  }
  const { db, c } = counting(env.DB);
  const pass = await make(db, [
    { version: 2, value: V2 },
    { version: 1, value: V1 },
  ]).api.secrets.rewrap({ limit: 100 });
  if (!pass.ok) throw new Error(pass.code);
  return { queries: c.n, resealed: pass.value.resealed };
}

describe("the rewrap of SSO client secrets on D1 (ruling 31 of plan 12d)", () => {
  it("costs one query per resealed client secret", async () => {
    const runs = [];
    for (const n of [0, 1, 2, 3]) runs.push(await rewrapWith(n));
    // Measured on the binding on 2026-10-21: 7, 8, 9, 10. The ready check of
    // the storage costs 1. The pass reads the three sealed tables once, and it
    // asks once per table whether a row is left: 6 more. Each resealed secret
    // adds its one conditional update. So one call reseals at most 43 client
    // secrets inside 50 queries, and the default limit of 100 does not fit.
    expect(runs.map((r) => [r.queries, r.resealed])).toEqual([
      [7, 0],
      [8, 1],
      [9, 2],
      [10, 3],
    ]);
  }, 120_000);
});

const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
/** The operator secret of the route calls. */
const OPERATOR = "operator-secret-0123456789abcdef-0123456789";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const PW = "correct horse battery";

/**
 * 20 TOTP setups, 20 signing keys, and 20 connections under version 1, each
 * made through the API. The clock then moves 16 minutes, so no setup is
 * live and each of the 60 rows can move.
 */
async function sixtyRows() {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const clock = { now: () => now };
  const mail: { to: string; text: string }[] = [];
  const make = (db: D1Database, secrets: { version: number; value: string }[]) =>
    createAuth({
      baseURL: "https://api.example.com",
      secrets,
      trustedOrigins: [],
      storage: createD1Adapter(db),
      limiter: { allow: async () => true },
      mail: { send: async (m) => void mail.push({ to: m.to, text: m.text }) },
      clock,
      password: { hash: FAST, uniformSignUp: false },
      organizations: {},
      sso: {
        oidc: true,
        dns: [{ name: "a", txt: async () => [] }],
        limits: { connectionsPerOrganization: 20 },
      },
    });
  const v1 = make(env.DB, [{ version: 1, value: V1 }]);
  const password = v1.api.password;
  const totp = v1.api.totp;
  const jwt = v1.api.jwt;
  if (!password || !totp || !jwt) throw new Error("no api");
  let owner: Parameters<typeof v1.api.createOrganization>[0]["user"] | null = null;
  for (let i = 0; i < 20; i++) {
    const email = `user${i}@example.com`;
    const up = await password.signUp({ email, password: PW, ip: null, userAgent: null });
    if (!up.ok || !("user" in up.value)) throw new Error("no user");
    const token = /token=([A-Za-z0-9_%-]+)/.exec(mail.findLast((m) => m.to === email)?.text ?? "");
    const verified = await password.verifyEmail({
      token: decodeURIComponent(token?.[1] ?? ""),
      ip: null,
      userAgent: null,
    });
    if (!verified.ok || verified.value.signedIn === null) throw new Error("no verify session");
    owner ??= verified.value.user;
    // The setup takes the session of the verify link (plan 12p).
    const session = await v1.api.getSession(verified.value.signedIn.token);
    if (!session) throw new Error("no session");
    const setup = await totp.setup({ session, password: PW });
    if (!setup.ok) throw new Error(setup.code);
  }
  await jwt.jwks();
  for (let i = 1; i < 20; i++) await jwt.rotate();
  if (!owner) throw new Error("no owner");
  const made = await v1.api.createOrganization({ user: owner, slug: "acme", name: "Acme" });
  if (!made.ok) throw new Error(made.code);
  for (let i = 0; i < 20; i++) {
    const c = await v1.api.sso?.connections.create({
      actor: { kind: "app", name: "budget" },
      organizationId: made.value.organization.id,
      kind: "oidc",
      label: `IdP ${i}`,
      issuer: "https://login.idp.example/acme",
      clientId: `client-${i}`,
      clientSecret: `secret-${i}-0123456789`,
    });
    if (!c?.ok) throw new Error("no connection");
  }
  now = new Date(now.getTime() + 16 * 60_000);
  const rows = Number(
    await env.DB.prepare(
      "SELECT (SELECT count(*) FROM ta_totp) + (SELECT count(*) FROM ta_jwk) + (SELECT count(*) FROM ta_sso_connection) AS n",
    ).first("n"),
  );
  /** One rewrap call under versions 2 and 1 on a counting view of the binding. */
  const pass = async (after?: string) => {
    const { db, c } = counting(env.DB);
    const r = await make(db, [
      { version: 2, value: V2 },
      { version: 1, value: V1 },
    ]).api.secrets.rewrap({ limit: 100, ...(after ? { after } : {}) });
    if (!r.ok) throw new Error(r.code);
    return { queries: c.n, ...r.value };
  };
  /**
   * One call of POST /auth/operator/secrets/rewrap under versions 2 and 1,
   * as the worker-d1 setup serves it: the D1 limiter and the D1 adapter on
   * one counting view of the binding, so the count holds the whole invocation.
   */
  const routePass = async (after?: string) => {
    const { db, c } = counting(env.DB);
    const auth = createAuth({
      baseURL: "https://api.example.com",
      secrets: [
        { version: 2, value: V2 },
        { version: 1, value: V1 },
      ],
      trustedOrigins: [],
      storage: createD1Adapter(db),
      limiter: createD1Limiter(db, clock),
      mail: { send: async () => {} },
      clock,
      password: { hash: FAST, uniformSignUp: false },
      organizations: {},
      operator: { secretHash: await sha256Hex(OPERATOR) },
      sso: {
        oidc: true,
        dns: [{ name: "a", txt: async () => [] }],
        limits: { connectionsPerOrganization: 20 },
      },
    });
    const res = await auth.handle(
      new Request("https://api.example.com/auth/operator/secrets/rewrap", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          authorization: `Operator ${OPERATOR}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ limit: 100, ...(after ? { after } : {}) }),
      }),
    );
    const value = (await res.json()) as {
      resealed: number;
      failed: number;
      skipped: number;
      more: boolean;
      next: string | null;
    };
    return { queries: c.n, status: res.status, ...value };
  };
  return { rows, pass, routePass };
}

describe("the call budget of the rewrap on D1 (ruling 33 of plan 12d)", () => {
  it("stops one call inside 50 queries with more true, and the second call ends the pass", async () => {
    const w = await sixtyRows();
    expect(w.rows).toBe(60);
    const first = await w.pass();
    expect(first.queries).toBeLessThanOrEqual(50);
    expect([first.more, first.failed, first.skipped]).toEqual([true, 0, 0]);
    expect(first.next).toMatch(/^(totp|jwk|ssoConnection):/);
    const second = await w.pass(first.next ?? undefined);
    expect(second.queries).toBeLessThanOrEqual(50);
    expect([second.more, second.failed, second.skipped]).toEqual([false, 0, 0]);
    expect(first.resealed + second.resealed).toBe(60);
    // Measured on the binding on 2026-10-21: the first call sends 50 queries
    // and reseals 43 rows, the second sends 22 and reseals 17. Each call has 7
    // fixed queries: the ready check, the three page reads, and the three end
    // reads. Without the meter one call reseals all 60 rows in 67 queries.
    expect([first.queries, first.resealed, second.queries, second.resealed]).toEqual([
      50, 43, 22, 17,
    ]);
  }, 300_000);
});

describe("the rewrap route on D1 with the D1 limiter (ruling 34 of plan 12d)", () => {
  it("keeps each route call inside 50 queries with the limiter query of the route", async () => {
    const w = await sixtyRows();
    expect(w.rows).toBe(60);
    const first = await w.routePass();
    expect(first.status).toBe(200);
    expect(first.queries).toBeLessThanOrEqual(50);
    expect([first.more, first.failed, first.skipped]).toEqual([true, 0, 0]);
    const second = await w.routePass(first.next ?? undefined);
    expect(second.status).toBe(200);
    expect(second.queries).toBeLessThanOrEqual(50);
    expect([second.more, second.failed, second.skipped]).toEqual([false, 0, 0]);
    expect(first.resealed + second.resealed).toBe(60);
    // Measured on the binding on 2026-10-21: the first call sends 50 queries
    // and reseals 42 rows, the second sends 24 and reseals 18. The limiter
    // query of the route comes before the 7 fixed queries of the api call.
    // With the limiter query left out of the meter, the first call sent 51.
    expect([first.queries, first.resealed, second.queries, second.resealed]).toEqual([
      50, 42, 24, 18,
    ]);
  }, 300_000);
});
