import { env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash, type UserRow } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of the organization audit on the D1 binding (plan 13b Task 11). The scene runs
// each of the 11 audited acts of an organization through its route, and one read of the audit
// of 100 rows with 100 member actors. D1 Free allows 50 queries per invocation (D1 limits page
// updated 21 April 2026, read 2026-11-23). One request is one invocation, so each request builds
// a new engine on a new counting view, as each request of the Worker does. The limiter is the
// D1 limiter, so its queries count too. The view refuses query 51, as D1 Free does.

const BASE = "https://api.example.com";
const ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const PASSWORD = "correct horse battery";

type Act =
  | "memberAdd"
  | "memberRole"
  | "invite"
  | "accept"
  | "revoke"
  | "memberRemove"
  | "leave"
  | "tokenCreate"
  | "tokenRevoke"
  | "roleCreate"
  | "roleUpdate"
  | "roleDelete";

/**
 * The queries of each act before plan 13b: this scene on the base db7b3f8c2 (schema 17, no audit
 * row for these acts). Measured 2026-11-23 23:45 twice on the lane machine (Mac17,14), load 5.9
 * 7.7 8.8, with the same counts in each run. Plan 13b Tasks 4 and 5 measured the same counts on
 * c017af813.
 */
const BEFORE: Record<Act, number> = {
  memberAdd: 13,
  memberRole: 11,
  invite: 10,
  accept: 16,
  revoke: 8,
  memberRemove: 18,
  leave: 15,
  tokenCreate: 13,
  tokenRevoke: 7,
  roleCreate: 13,
  roleUpdate: 8,
  roleDelete: 10,
};

/**
 * The queries that plan 13b adds to each act. Each act writes its audit row in its transaction:
 * one INSERT. The role update had no transaction before plan 13b. An update inside a D1
 * transaction sends a read for the undo and then the write, so the role update sends 2 more:
 * the undo read and the INSERT. The token revoke also gets a transaction, but its delete is still
 * one statement (DELETE ... RETURNING).
 */
const ADDED: Record<Act, number> = {
  memberAdd: 1,
  memberRole: 1,
  invite: 1,
  accept: 1,
  revoke: 1,
  memberRemove: 1,
  leave: 1,
  tokenCreate: 1,
  tokenRevoke: 1,
  roleCreate: 1,
  roleUpdate: 2,
  roleDelete: 1,
};

/**
 * The queries of each act with its audit row, through its route, with the D1 limiter. Measured
 * 2026-11-23 23:45 on the same machine, load 7.0 7.9 9.0, head 67481880a with a core dist built
 * from it. The member and invitation pins are those of plan 13b Task 4, and the token and role
 * pins those of Task 5: this file takes them over.
 */
const PINS: Record<Act, number> = {
  memberAdd: 14,
  memberRole: 12,
  invite: 11,
  accept: 17,
  revoke: 9,
  memberRemove: 19,
  leave: 16,
  tokenCreate: 14,
  tokenRevoke: 8,
  roleCreate: 14,
  roleUpdate: 10,
  roleDelete: 11,
};

/**
 * The queries of one read of 100 rows with 100 member actors: the schema version, the session,
 * its user, the organization (read twice: once by `standing`, once by `membership`), the
 * member, the audit page, and the users of the actors in 2 statements of 50 ids. Measured
 * 2026-11-23 23:45 on the same machine, load 7.0 7.9 9.0, head 67481880a.
 */
const READ_PIN = 9;

/** A view of `db` that counts each statement, and each statement of a batch. Query 51 throws. */
function counting(db: D1Database) {
  const count = { queries: 0, sql: [] as string[] };
  const tick = (sql: string[]) => {
    if (count.queries + sql.length > BUDGET)
      throw new Error("Too many API requests by single worker invocation.");
    count.queries += sql.length;
    count.sql.push(...sql);
  };
  const SQL = new WeakMap<D1PreparedStatement, string>();
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            tick([sql]);
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    SQL.set(proxy, sql);
    return proxy;
  };
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          tick(statements.map((s) => SQL.get(s) ?? "?"));
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

type Organizations = NonNullable<Parameters<typeof createAuth>[0]["organizations"]>;

/** One engine on `db`, with the D1 limiter on the same view. */
function engine(db: D1Database, organizations: Organizations) {
  return createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async (m) => void mail.push({ to: m.to, text: m.text }) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    organizations,
  });
}

let ip = 0;
const headers = (cookie: string | null) => ({
  "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
  "user-agent": "organization-audit-budget",
  origin: ORIGIN,
  ...(cookie ? { cookie } : {}),
});
const post = (path: string, body: unknown, cookie: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: { ...headers(cookie), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string, cookie: string) =>
  new Request(`${BASE}/auth${path}`, { method: "GET", headers: headers(cookie) });

/** The queries of one request on a new engine, from a count of zero, with the work after the answer. */
async function measure(request: Request, organizations: Organizations = {}) {
  const { db, count } = counting(env.DB);
  const auth = engine(db, organizations);
  const after: Promise<unknown>[] = [];
  const res = await auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return { res, queries: count.queries, sql: count.sql };
}

const cookieOf = (res: Response, name: string): string =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(name))
    ?.split(";")[0] ?? "";

/** A verified user with a session, through the routes of a sign-up. Not measured. */
async function person(email: string): Promise<{ cookie: string; id: string }> {
  const up = (await measure(post("/password/sign-up", { email, password: PASSWORD }))).res;
  const link = mail.findLast((m) => m.to === email)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(link)?.[1] ?? "");
  await measure(post("/password/verify", { token }, cookieOf(up, "__Host-tempo_signup=")));
  const signed = await measure(post("/password/sign-in", { email, password: PASSWORD }));
  const row = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?").bind(email).first();
  return { cookie: cookieOf(signed.res, "__Host-tempo_session="), id: String(row?.id) };
}

/** A person with a session who made the organization `acme`. Not measured. */
async function owner(
  organizations: Organizations,
): Promise<{ cookie: string; id: string; organizationId: string }> {
  const me = await person("owner@acme.example");
  const made = await measure(
    post("/organizations/create", { slug: "acme", name: "Acme" }, me.cookie),
    organizations,
  );
  const organizationId = ((await made.res.json()) as { organization: { id: string } }).organization
    .id;
  return { ...me, organizationId };
}

/** The invitation token of the last invitation mail to `email`. */
function invitationToken(email: string): string {
  const re = /invitation=(inv_[A-Za-z0-9_-]+)/;
  return re.exec(mail.findLast((m) => m.to === email && re.test(m.text))?.text ?? "")?.[1] ?? "";
}

/** The actions of the audit rows of `organizationId`, oldest first. */
async function actions(organizationId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT action FROM ta_operator_audit WHERE organization_id = ? ORDER BY id",
  )
    .bind(organizationId)
    .all<{ action: string }>();
  return rows.results.map((r) => r.action);
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
  mail.length = 0;
});

describe("the queries of the organization audit on D1 (plan 13b Task 11)", () => {
  it("each act sends its old count plus its audit row, under the D1 Free budget", async () => {
    const got: Partial<Record<Act, number>> = {};
    const run = async (name: Act, request: Request, organizations: Organizations) => {
      const r = await measure(request, organizations);
      expect(r.res.status, name).toBe(200);
      got[name] = r.queries;
      return (await r.res.json()) as Record<string, unknown>;
    };

    // The member and invitation acts, with the organizations of the `ranks` form.
    const ranks: Organizations = {};
    const boss = await owner(ranks);
    const base = { organizationId: boss.organizationId };
    const bo = await person("bo@acme.example");
    const cy = await person("cy@acme.example");
    await run(
      "memberAdd",
      post("/organizations/members/add", { ...base, userId: bo.id, role: "member" }, boss.cookie),
      ranks,
    );
    await run(
      "memberRole",
      post("/organizations/members/role", { ...base, userId: bo.id, role: "admin" }, boss.cookie),
      ranks,
    );
    await run(
      "invite",
      post(
        "/organizations/invite",
        { ...base, email: "cy@acme.example", role: "member" },
        boss.cookie,
      ),
      ranks,
    );
    await run(
      "accept",
      post(
        "/organizations/invitations/accept",
        { token: invitationToken("cy@acme.example") },
        cy.cookie,
      ),
      ranks,
    );
    const other = await measure(
      post(
        "/organizations/invite",
        { ...base, email: "di@acme.example", role: "member" },
        boss.cookie,
      ),
      ranks,
    );
    const invitationId = ((await other.res.json()) as { invitation: { id: string } }).invitation.id;
    await run(
      "revoke",
      post("/organizations/invitations/revoke", { ...base, invitationId }, boss.cookie),
      ranks,
    );
    await run(
      "memberRemove",
      post("/organizations/members/remove", { ...base, userId: bo.id }, boss.cookie),
      ranks,
    );
    await run(
      "leave",
      post("/organizations/members/remove", { ...base, userId: cy.id }, cy.cookie),
      ranks,
    );

    // The token and role acts, with the stored roles on, in the same organization.
    const roles: Organizations = { dynamicRoles: {} };
    const minted = await run(
      "tokenCreate",
      post("/organizations/tokens", { ...base, name: "ci", permissions: {} }, boss.cookie),
      roles,
    );
    const tokenId = (minted as { apiToken: { id: string } }).apiToken.id;
    await run(
      "tokenRevoke",
      post("/organizations/tokens/revoke", { ...base, id: tokenId }, boss.cookie),
      roles,
    );
    const role = { ...base, name: "lead" };
    await run(
      "roleCreate",
      post(
        "/organizations/roles/create",
        { ...role, rank: 1, permissions: { member: ["read"] } },
        boss.cookie,
      ),
      roles,
    );
    await run(
      "roleUpdate",
      post("/organizations/roles/update", { ...role, rank: 2 }, boss.cookie),
      roles,
    );
    await run("roleDelete", post("/organizations/roles/delete", role, boss.cookie), roles);

    expect(got).toEqual(PINS);
    for (const [name, count] of Object.entries(got) as [Act, number][]) {
      expect(count, name).toBe((BEFORE[name] ?? 0) + (ADDED[name] ?? 0));
      expect(count, name).toBeLessThanOrEqual(BUDGET);
    }
    // One row for each act. The second invite is not measured, so its row is in the list too.
    expect(await actions(boss.organizationId)).toEqual([
      "organization_member_add",
      "organization_member_role_change",
      "organization_invitation_create",
      "organization_invitation_accept",
      "organization_invitation_create",
      "organization_invitation_revoke",
      "organization_member_remove",
      "organization_member_remove",
      "organization_token_create",
      "organization_token_revoke",
      "organization_role_create",
      "organization_role_update",
      "organization_role_delete",
    ]);
  }, 120_000);

  it("reads one page of 100 rows with 100 member actors under the D1 Free budget, the users in 2 chunks", async () => {
    const ranks: Organizations = {};
    const boss = await owner(ranks);
    const organizationId = boss.organizationId;
    // The setup runs on the plain binding: it is not measured.
    const plain = engine(env.DB, ranks);
    const storage = createD1Adapter(env.DB);
    const ownerRow = (await storage.findOne("user", [
      { field: "id", op: "eq", value: boss.id },
    ])) as UserRow;
    // 100 verified users, each an admin of the organization. Each invites one person, so the
    // audit holds 100 invitation rows of 100 distinct member actors. Each invite spends the
    // limit of its own inviter and its own address, so no limit refuses one.
    const t0 = new Date();
    for (let i = 0; i < 100; i++) {
      const user = await storage.create("user", {
        id: `u${String(i).padStart(3, "0")}`,
        email: `admin${i}@acme.example`,
        emailVerified: true,
        name: null,
        image: null,
        bannedAt: null,
        banReason: null,
        banUntil: null,
        username: null,
        displayUsername: null,
        phone: null,
        isAnonymous: false,
        createdAt: t0,
        updatedAt: t0,
      });
      const added = await plain.api.addMember({
        user: ownerRow,
        organizationId,
        userId: user.id,
        role: "admin",
      });
      if (!added.ok) throw new Error(added.code);
      const invited = await plain.api.inviteMember({
        user,
        organizationId,
        email: `guest${i}@acme.example`,
        role: "member",
      });
      if (!invited.ok) throw new Error(invited.code);
    }

    const r = await measure(
      get(
        `/organizations/audit?organizationId=${organizationId}&action=organization_invitation_create&limit=100`,
        boss.cookie,
      ),
      ranks,
    );
    expect(r.res.status).toBe(200);
    const page = (await r.res.json()) as {
      rows: { actor: { kind: string; id: string | null; email: string | null } }[];
      next: string | null;
    };
    expect(page.rows).toHaveLength(100);
    expect(page.next).toBeNull();
    expect(page.rows.every((row) => row.actor.kind === "member" && row.actor.email !== null)).toBe(
      true,
    );
    expect(new Set(page.rows.map((row) => row.actor.id)).size).toBe(100);
    // The read of the users of the actors: `findManyIn` sends 50 ids in each statement.
    const userReads = r.sql.filter(
      (sql) => /\bFROM\s+"?ta_user"?/i.test(sql) && /\bIN\b/i.test(sql),
    );
    expect(userReads).toHaveLength(2);
    expect(r.queries).toBe(READ_PIN);
    expect(r.queries).toBeLessThanOrEqual(BUDGET);
  }, 120_000);
});
