import { env } from "cloudflare:test";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// A SCIM User create and a magic link of the same address race on the D1
// binding (decisions 1 and 2 of plan 12o). An unverified user holds the
// address. A password sign-up writes no email identity, so the create
// inserts one before its flip. The magic link runs after that insert and
// before the flip, as a parallel request does between two queries. So the
// magic link claims first, and the flip of the create matches no row. On a
// store with a query limit per invocation, the create runs no claim retry
// (ruling 32 of plan 12n). It answers 409 after the undo.
//
// The undo deletes the email identity of the create by its id. The magic
// link found that row and inserted none. So the user has no email identity
// until the next proof makes it again (follow-up 2 of the 12n close line).
// The create that the directory sends again makes it.
//
// Each row comes from a real flow. The owner signs in by a magic link and
// makes an organization, a verified domain, and a SCIM token. The password
// sign-up of Ada stays unverified. The watch after each statement is the
// form of invite-claim-race.test.ts of plan 12n.

const API = "https://api.example.com";
const APP = { kind: "app", name: "race" } as const;
const ADA = "ada@acme.example";
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const ERROR_URN = "urn:ietf:params:scim:api:messages:2.0:Error";
// D1 Free allows 50 queries per invocation (D1 limits page updated 21
// April 2026, read 2026-10-24, as anonymous-upgrade-budget.test.ts says).
const BUDGET = 50;
const RAW = Symbol("raw");
const SQL = Symbol("sql");

/** The claim's insert of the email identity. The lease of the claim comes next (plan 12p). */
const IDENTITY_INSERT = /^INSERT INTO ta_identity\b/;
/** The flip of a claim, not the undo of a flip. */
const FLIP = /^UPDATE ta_user SET email_verified = \?/;
/**
 * The take of a stale lease (plan 12p). A claim runs it only when its lease
 * create met the key of another lease. The watch sees no statement that
 * throws, so it sees this one in place of the create.
 */
const LEASE = /^UPDATE ta_verification SET expires_at = \?/;
/** The detail of the SCIM answer to a lost claim race (decision 1 of plan 12o). */
const RACE = "Another request changed this resource at the same time. Send the request again.";

/** A step that runs after each statement of a view, with its SQL text. */
type Watch = (sql: string) => Promise<void>;

/**
 * A view of `db` that counts each statement, and each statement of a
 * batch. With a cap, the statement past the cap throws, as D1 Free does.
 * `watch` runs after each statement.
 */
function view(db: D1Database, watch: Watch | null, cap: number | null) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (cap !== null && count.queries + n > cap)
      throw new Error("Too many API requests by single worker invocation.");
    count.queries += n;
  };
  const after = async <T>(value: Promise<T>, texts: string[]): Promise<T> => {
    const done = await value;
    for (const text of texts) await watch?.(text);
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
            return after(
              (target[key] as (...a: unknown[]) => Promise<unknown>).apply(target, args),
              [sql],
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
          return after(
            target.batch(
              statements.map(
                (s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s,
              ),
            ),
            statements.map((s) => String((s as unknown as Record<symbol, string>)[SQL] ?? "")),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted as D1Database, count };
}

const sent: MailMessage[] = [];
const txt: Record<string, string[]> = {};
/** The after hooks of the claim, across the invocations of one test. */
const events: string[] = [];

/**
 * The engine on `db`, one invocation. `limiter` serves it with the D1
 * limiter, as worker-d1 does. A password sign-up stays unverified. The
 * `session.afterEnd` hook makes a claim read its sessions and then delete
 * them by id.
 */
function engine(db: D1Database, limiter: boolean) {
  const input: AuthConfig = {
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    limiter: limiter ? createD1Limiter(db) : { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    password: {
      hash: createPbkdf2PasswordHash({ iterations: 1000 }),
      requireVerified: false,
      uniformSignUp: false,
    },
    organizations: {},
    sso: { dns: [{ name: "a", txt: async (name) => txt[name] ?? [] }] },
    scim: {},
    hooks: {
      user: { afterVerify: ({ user, via }) => void events.push(`verify ${user.id} ${via}`) },
      session: {
        afterEnd: ({ session, reason }) => void events.push(`end ${session.id} ${reason}`),
      },
    },
  };
  return createAuth(input);
}
type Auth = ReturnType<typeof engine>;

/** The token of the newest link to `to`. */
function lastToken(to: string): string {
  const text = sent.filter((m) => m.to === to).at(-1)?.text ?? "";
  return decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
}

/** A magic link sign-in of `email`: the user and the session token. */
async function signIn(auth: Auth, email: string) {
  await auth.api.requestMagicLink({ email, ip: null });
  const r = await auth.api.verifyMagicLink({ token: lastToken(email), ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return r.value;
}

/** The organization `acme` with its verified domain and a SCIM token. */
async function acme(auth: Auth) {
  const owner = await signIn(auth, "owner@acme.example");
  const made = await auth.api.createOrganization({ user: owner.user, slug: "acme", name: "Acme" });
  if (!made.ok) throw new Error(made.code);
  const organizationId = made.value.organization.id;
  const sso = auth.api.sso;
  const scim = auth.api.scim;
  if (!sso || !scim) throw new Error("no sso or scim api");
  const domain = await sso.domains.add({ actor: APP, organizationId, domain: "acme.example" });
  if (!domain.ok || domain.value.record === null) throw new Error("no domain");
  txt[domain.value.record.name] = [domain.value.record.value];
  if (!(await sso.domains.verify({ actor: APP, id: domain.value.id })).ok)
    throw new Error("no proof");
  const token = await scim.tokens.create({ actor: APP, organizationId, name: "directory" });
  if (!token.ok) throw new Error(token.code);
  return { organizationId, token: token.value.token };
}

/** The SCIM create of the User of Ada with the bearer `token`. */
const create = (token: string) =>
  new Request(`${API}/auth/scim/v2/Users`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
    body: JSON.stringify({ schemas: [USER_URN], userName: ADA }),
  });

/** A JSON POST of an auth route. */
const post = (path: string, body: unknown) =>
  new Request(`${API}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" },
    body: JSON.stringify(body),
  });

/**
 * The queries of one request, from a count of zero, with the work after
 * the answer. The `lastUsedAt` of the SCIM token goes back 2 minutes first,
 * so each request writes it: the worst case of a SCIM route.
 */
async function measure(auth: Auth, count: { queries: number }, request: Request) {
  await env.DB.prepare("UPDATE ta_scim_token SET last_used_at = last_used_at - 120000").run();
  count.queries = 0;
  const after: Promise<unknown>[] = [];
  const res = await auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return { res, queries: count.queries };
}

/** The session token that an answer set, or null. */
function setToken(res: Response): string | null {
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
  return line?.slice("__Host-tempo_session=".length).split(";")[0] || null;
}

/** The rows of the user at the address that a claim and a SCIM create write, read on the binding. */
async function rowsOf(userId: string, organizationId: string) {
  const user = await env.DB.prepare("SELECT email_verified AS v FROM ta_user WHERE id = ?")
    .bind(userId)
    .first<{ v: number }>();
  const ids = async (sql: string, ...values: string[]) =>
    (
      await env.DB.prepare(sql)
        .bind(...values)
        .all<{ id: string }>()
    ).results.map((r) => r.id);
  return {
    verified: user?.v === 1,
    users: (await ids("SELECT id FROM ta_user WHERE email = ?", ADA)).length,
    emailIdentities: (
      await ids("SELECT id FROM ta_identity WHERE user_id = ? AND provider = 'email'", userId)
    ).length,
    passwords: (await ids("SELECT id FROM ta_password WHERE user_id = ?", userId)).length,
    sessions: await ids("SELECT id FROM ta_session WHERE user_id = ? ORDER BY id", userId),
    members: await ids(
      "SELECT role AS id FROM ta_member WHERE user_id = ? AND organization_id = ?",
      userId,
      organizationId,
    ),
    scimUsers: await ids("SELECT user_id AS id FROM ta_scim_user WHERE user_name = ?", ADA),
    creates: (await ids("SELECT id FROM ta_operator_audit WHERE action = 'scim_user_create'"))
      .length,
  };
}

// The counts of the run of 2026-11-04 on the D1 binding of this pool. The
// first is the create of the race: 14 queries, with the undo. The second is
// the create that the directory sends again: 21 queries. Each is one
// invocation with the D1 limiter on the same view.
const PINS = { race: 14, again: 21 };

describe("the SCIM User create that loses a claim race on D1 (decisions 1 and 2 of plan 12o)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("DELETE FROM ta_limit").run();
    sent.length = 0;
    events.length = 0;
  });

  it("answers 409 with the race sentence and no scimType inside 50 queries, and links the verified user at the request again", async () => {
    const setup = engine(env.DB, false);
    const { organizationId, token } = await acme(setup);
    const up = await setup.api.password?.signUp({
      email: ADA,
      password: "a claimant's password",
      ip: null,
      userAgent: null,
    });
    if (!up?.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    const userId = up.value.user.id;
    const before = await rowsOf(userId, organizationId);
    expect(before).toMatchObject({ verified: false, emailIdentities: 0, passwords: 1 });
    expect(before.sessions).toHaveLength(1);
    const claimant = before.sessions[0] ?? "";
    expect((await setup.handle(post("/magic-link/request", { email: ADA }))).status).toBe(200);
    const link = lastToken(ADA);
    const mark = events.length;
    // The magic link of the address, in its own invocation on the binding.
    const side = engine(env.DB, false);
    const magic: { answer: Response | null } = { answer: null };
    let flips = 0;
    let leases = 0;
    const v = view(
      env.DB,
      async (sql) => {
        if (FLIP.test(sql)) flips++;
        else if (LEASE.test(sql)) leases++;
        else if (magic.answer === null && IDENTITY_INSERT.test(sql)) {
          // The create inserted the email identity, and its lease comes next. The magic link claims first.
          magic.answer = await side.handle(post("/magic-link/verify", { token: link }));
        }
      },
      BUDGET,
    );
    const race = await measure(engine(v.db, true), v.count, create(token));
    expect(magic.answer?.status).toBe(200);
    // The lease of the create met the lease of the magic link (plan 12p): no
    // flip, and no claim retry.
    expect({ leases, flips }).toEqual({ leases: 1, flips: 0 });
    expect(race.res.status).toBe(409);
    expect(race.res.headers.get("content-type")).toContain("application/scim+json");
    expect(await race.res.json()).toStrictEqual({
      schemas: [ERROR_URN],
      status: "409",
      detail: RACE,
    });
    // The magic link claimed. The undo of the create left no row of its own,
    // and took the email identity that the magic link found (follow-up 2 of 12n).
    const mine = await setup.api.getSession(setToken(magic.answer ?? new Response()) ?? "");
    expect(mine?.user.id).toBe(userId);
    expect(await rowsOf(userId, organizationId)).toEqual({
      verified: true,
      users: 1,
      emailIdentities: 0,
      passwords: 0,
      sessions: [mine?.session.id],
      members: [],
      scimUsers: [],
      creates: 0,
    });
    // The after hooks of the one claim: the magic link's. The lost claim fired none.
    expect(events.slice(mark)).toEqual([`verify ${userId} magic_link`, `end ${claimant} claim`]);

    // The directory sends the request again, in a new invocation.
    const next = view(env.DB, null, BUDGET);
    const again = await measure(engine(next.db, true), next.count, create(token));
    expect(again.res.status).toBe(201);
    expect(await again.res.json()).toMatchObject({ userName: ADA, active: true });
    expect(await rowsOf(userId, organizationId)).toEqual({
      verified: true,
      users: 1,
      emailIdentities: 1,
      passwords: 0,
      sessions: [mine?.session.id],
      members: ["member"],
      scimUsers: [userId],
      creates: 1,
    });
    // The user was verified already: no claim, and no after hook of a claim. The
    // create made the email identity again, and no second one.
    expect(events.slice(mark + 2)).toEqual([]);
    expect({ race: race.queries, again: again.queries }).toEqual(PINS);
    expect(Math.max(race.queries, again.queries)).toBeLessThanOrEqual(BUDGET);
  });
});
