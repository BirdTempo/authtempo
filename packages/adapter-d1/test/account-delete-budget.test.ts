import { env } from "cloudflare:test";
import { createAuth } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The queries of an account delete with 0 to 3 solo organizations on the D1
// binding (rulings 29 and 30 of plan 12d). D1 Free allows 50 queries per
// invocation (D1 limits page updated 21 April 2026, read 2026-10-21). Each
// solo organization holds one domain through api.sso.domains.add. No product
// path writes a connection or a SCIM token before plan 12d Tasks 3 and 9b; a
// delete of a model costs one query with or without its rows.

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

/** The queries of the account delete of a user with `orgs` solo organizations, and the rows left. */
async function deleteWith(orgs: number): Promise<{ queries: number; left: number }> {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const mail: string[] = [];
  const make = (db: D1Database) =>
    createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createD1Adapter(db),
      limiter: { allow: async () => true },
      mail: { send: async (m) => void mail.push(m.text) },
      organizations: {},
      sso: { dns: [{ name: "a", txt: async () => [] }] },
    });
  const auth = make(env.DB);
  await auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  for (let i = 0; i < orgs; i++) {
    const made = await auth.api.createOrganization({
      user: r.value.user,
      slug: `solo-${i}`,
      name: `Solo ${i}`,
    });
    if (!made.ok) throw new Error(made.code);
    const d = await auth.api.sso?.domains.add({
      actor: { kind: "app", name: "budget" },
      organizationId: made.value.organization.id,
      domain: `solo${i}.example`,
    });
    if (!d?.ok) throw new Error("no domain");
  }
  const s = await auth.api.getSession(r.value.token);
  if (!s) throw new Error("no session");
  const { db, c } = counting(env.DB);
  const done = await make(db).api.user.delete({ session: s, ip: null, userAgent: null });
  if (!done.ok) throw new Error(done.code);
  const left = Number(
    await env.DB.prepare(
      "SELECT (SELECT count(*) FROM ta_organization) + (SELECT count(*) FROM ta_sso_domain) AS n",
    ).first("n"),
  );
  return { queries: c.n, left };
}

describe("the account delete of solo organizations on D1 (rulings 29 and 30 of plan 12d)", () => {
  it("costs the same queries for 1, 2, and 3 solo organizations, each at most 50", async () => {
    const runs = [];
    for (let orgs = 0; orgs <= 3; orgs++) runs.push(await deleteWith(orgs));
    // Measured on the binding on 2026-10-21 (load 14.5): 30, 45, 45, 45. Before ruling 30
    // the delete ran per organization: 29, 44, 59, 74 at 339bf900, so 2 solo organizations
    // passed 50. The read of the memberships before any write adds 1 to each count.
    expect(runs.map((r) => r.queries)).toEqual([30, 45, 45, 45]);
    for (const r of runs) expect([r.queries <= 50, r.left]).toEqual([true, 0]);
  }, 120_000);
});
