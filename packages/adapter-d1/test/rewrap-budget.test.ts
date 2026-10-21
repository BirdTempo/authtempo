import { env } from "cloudflare:test";
import { createAuth } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The queries of one rewrap call with SSO client secrets on the D1 binding
// (ruling 31 of plan 12d). D1 Free allows 50 queries per invocation (D1
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
