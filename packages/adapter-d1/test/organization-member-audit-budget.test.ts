import { env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of each member and invitation act of an organization on the D1 binding (plan 13b
// Task 4, row "D1 budget"). Each act writes one audit row in its transaction, so each act sends
// one query more than before. D1 Free allows 50 queries per invocation (D1 limits page updated
// 21 April 2026, read 2026-11-23). One request is one invocation, so each act builds a new engine
// on a new counting view, as each request of the Worker does. The limiter is the D1 limiter, so
// its queries count too. The view refuses query 51, as D1 Free does. Task 11 pins the counts of
// all 11 acts in its own scene.

const BASE = "https://api.example.com";
const ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const PASSWORD = "correct horse battery";

/**
 * The measured queries of each act through its route, with the D1 limiter. `BEFORE` is the count
 * of the same scene on the base of the task (c017af813: plan 13b Tasks 0, 1, and 3, which add no
 * statement to these acts), with no audit row. Measured 2026-11-23 22:16 twice on the lane
 * machine (Mac17,14), load 21.5 10.6 9.3, with the same counts in each run.
 */
const BEFORE: Record<string, number> = {
  memberAdd: 13,
  memberRole: 11,
  invite: 10,
  accept: 16,
  revoke: 8,
  memberRemove: 18,
  leave: 15,
};
/**
 * The counts with the audit row: `BEFORE` plus 1 for each act. Measured 2026-11-23 22:21 on the
 * same machine, load 14.9 11.1 9.8, on a core dist built after the change.
 */
const PINS: Record<string, number> = {
  memberAdd: 14,
  memberRole: 12,
  invite: 11,
  accept: 17,
  revoke: 9,
  memberRemove: 19,
  leave: 16,
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
    organizations: {},
  });
  return { auth, count };
}

let ip = 0;
const post = (path: string, body: unknown, cookie: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      "user-agent": "member-audit-budget",
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

/** A verified user with a session. Not measured. */
async function person(email: string): Promise<{ cookie: string; id: string }> {
  const up = (await measure(post("/password/sign-up", { email, password: PASSWORD }))).res;
  const link = mail.findLast((m) => m.to === email)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(link)?.[1] ?? "");
  await measure(post("/password/verify", { token }, cookieOf(up, "__Host-tempo_signup=")));
  const signed = await measure(post("/password/sign-in", { email, password: PASSWORD }));
  const row = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?").bind(email).first();
  return { cookie: cookieOf(signed.res, "__Host-tempo_session="), id: String(row?.id) };
}

/** The invitation token of the last invitation mail to `email`. */
function invitationToken(email: string): string {
  const re = /invitation=(inv_[A-Za-z0-9_-]+)/;
  return re.exec(mail.findLast((m) => m.to === email && re.test(m.text))?.text ?? "")?.[1] ?? "";
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
  mail.length = 0;
});

describe("the queries of the member and invitation acts on D1 (plan 13b Task 4)", () => {
  it("sends one query more for each act, for its audit row, and stays under the D1 Free budget", async () => {
    const got: Record<string, number> = {};
    const owner = await person("owner@acme.example");
    const made = await measure(
      post("/organizations/create", { slug: "acme", name: "Acme" }, owner.cookie),
    );
    const organizationId = ((await made.res.json()) as { organization: { id: string } })
      .organization.id;
    const bo = await person("bo@acme.example");
    const cy = await person("cy@acme.example");
    const base = { organizationId };
    const run = async (name: string, request: Request) => {
      const r = await measure(request);
      expect(r.res.status, name).toBe(200);
      got[name] = r.queries;
      return (await r.res.json()) as Record<string, unknown>;
    };

    await run(
      "memberAdd",
      post("/organizations/members/add", { ...base, userId: bo.id, role: "member" }, owner.cookie),
    );
    await run(
      "memberRole",
      post("/organizations/members/role", { ...base, userId: bo.id, role: "admin" }, owner.cookie),
    );
    await run(
      "invite",
      post(
        "/organizations/invite",
        { ...base, email: "cy@acme.example", role: "member" },
        owner.cookie,
      ),
    );
    await run(
      "accept",
      post(
        "/organizations/invitations/accept",
        { token: invitationToken("cy@acme.example") },
        cy.cookie,
      ),
    );
    const other = await measure(
      post(
        "/organizations/invite",
        { ...base, email: "di@acme.example", role: "member" },
        owner.cookie,
      ),
    );
    const invitationId = ((await other.res.json()) as { invitation: { id: string } }).invitation.id;
    await run(
      "revoke",
      post("/organizations/invitations/revoke", { ...base, invitationId }, owner.cookie),
    );
    await run(
      "memberRemove",
      post("/organizations/members/remove", { ...base, userId: bo.id }, owner.cookie),
    );
    await run(
      "leave",
      post("/organizations/members/remove", { ...base, userId: cy.id }, cy.cookie),
    );

    expect(got).toEqual(PINS);
    for (const [name, count] of Object.entries(got)) {
      expect(count, name).toBe((BEFORE[name] ?? 0) + 1);
      expect(count, name).toBeLessThanOrEqual(BUDGET);
    }
  }, 120_000);
});
