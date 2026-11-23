import { env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of each token and role act of an organization on the D1 binding (plan 13b Task 5,
// row "D1 budget"). D1 Free allows 50 queries per invocation (D1 limits page updated 21 April
// 2026, read 2026-11-23). One request is one invocation, so each act builds a new engine on a new
// counting view, as each request of the Worker does. The limiter is the D1 limiter, so its
// queries count too. The view refuses query 51, as D1 Free does.

const BASE = "https://api.example.com";
const ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const PASSWORD = "correct horse battery";

/**
 * The measured statements of each act, with the D1 limiter.
 * Measured 2026-11-23 22:13 on the lane machine, load 2.2 to 7.9, base c017af813 with migration
 * 0018. Before Task 5 the counts were: token create 13, token revoke 7, role create 13, role
 * update 8, role delete 10. Each act now sends 1 more statement, the INSERT of its audit row,
 * except the role update. That act had no transaction before Task 5. An update inside a D1
 * transaction sends a read for the undo and then the write in one batch. So the role update
 * sends 2 more: the undo read and the INSERT. The token revoke also gets a transaction, but a
 * delete inside one is still one statement (DELETE ... RETURNING). The counts are the same in
 * each run.
 */
const PINS: Record<string, number> = {
  tokenCreate: 14,
  tokenRevoke: 8,
  roleCreate: 14,
  roleUpdate: 10,
  roleDelete: 11,
};

/** A view of `db` that counts each statement, and each statement of a batch. Query 51 throws. */
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

const mail: { to: string; text: string }[] = [];

/** One engine on a new counting view: one invocation of the Worker. */
function make() {
  const { db, count } = counting(env.DB);
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async (m) => void mail.push({ to: m.to, text: m.text }) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    organizations: { dynamicRoles: {} },
  });
  return { auth, count };
}

let ip = 0;
const post = (path: string, body: unknown, cookie: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      "user-agent": "organization-audit-tokens-budget",
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

/** The queries of one request, from a count of zero, with the work after the answer. */
async function measure(request: Request) {
  const w = make();
  const after: Promise<unknown>[] = [];
  const res = await w.auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return { res, queries: w.count.queries };
}

const cookieOf = (res: Response, name: string): string =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(name))
    ?.split(";")[0] ?? "";

/** The owner: a verified user with a fresh session, who made the organization. Not measured. */
async function owner(): Promise<{ cookie: string; organizationId: string }> {
  const email = "owner@acme.example";
  const up = await measure(post("/password/sign-up", { email, password: PASSWORD }));
  const link = mail.findLast((m) => m.to === email)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(link)?.[1] ?? "");
  await measure(post("/password/verify", { token }, cookieOf(up.res, "__Host-tempo_signup=")));
  const signed = await measure(post("/password/sign-in", { email, password: PASSWORD }));
  const cookie = cookieOf(signed.res, "__Host-tempo_session=");
  const made = await measure(post("/organizations/create", { slug: "acme", name: "Acme" }, cookie));
  const organization = ((await made.res.json()) as { organization: { id: string } }).organization;
  return { cookie, organizationId: organization.id };
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
  mail.length = 0;
});

describe("the queries of each token and role act of an organization on D1 (plan 13b Task 5)", () => {
  it("D1 budget: each act sends its old count plus its audit row, under the D1 Free budget", async () => {
    const got: Record<string, number> = {};
    const boss = await owner();
    const organizationId = boss.organizationId;

    const minted = await measure(
      post("/organizations/tokens", { organizationId, name: "ci", permissions: {} }, boss.cookie),
    );
    expect(minted.res.status).toBe(200);
    got.tokenCreate = minted.queries;
    const tokenId = ((await minted.res.json()) as { apiToken: { id: string } }).apiToken.id;

    const revoked = await measure(
      post("/organizations/tokens/revoke", { organizationId, id: tokenId }, boss.cookie),
    );
    expect(revoked.res.status).toBe(200);
    got.tokenRevoke = revoked.queries;

    const role = { organizationId, name: "lead" };
    const created = await measure(
      post(
        "/organizations/roles/create",
        { ...role, rank: 1, permissions: { member: ["read"] } },
        boss.cookie,
      ),
    );
    expect(created.res.status).toBe(200);
    got.roleCreate = created.queries;

    const updated = await measure(
      post("/organizations/roles/update", { ...role, rank: 2 }, boss.cookie),
    );
    expect(updated.res.status).toBe(200);
    got.roleUpdate = updated.queries;

    const deleted = await measure(post("/organizations/roles/delete", role, boss.cookie));
    expect(deleted.res.status).toBe(200);
    got.roleDelete = deleted.queries;

    expect(got).toEqual(PINS);
    for (const count of Object.values(got)) expect(count).toBeLessThan(BUDGET);
    const rows = await env.DB.prepare(
      "SELECT action FROM ta_operator_audit WHERE organization_id = ? ORDER BY id",
    )
      .bind(organizationId)
      .all<{ action: string }>();
    expect(rows.results.map((r) => r.action)).toEqual([
      "organization_token_create",
      "organization_token_revoke",
      "organization_role_create",
      "organization_role_update",
      "organization_role_delete",
    ]);
  }, 120_000);
});
