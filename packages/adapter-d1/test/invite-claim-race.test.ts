import { env } from "cloudflare:test";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { coreStatements, SQLITE, TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";
import {
  createD1AdapterOn,
  createD1Limiter,
  schemaVersionCheckOn,
  schemaVersionPing,
  toStorageError,
} from "../src/seam-entry.js";

// The invitation confirm and a magic link of the same address race on the
// D1 binding. The cases hold M1 of the Task 3a review and rulings 38 and 42
// of plan 12n. An invited user has no `email` identity, so both flows
// insert one. D1 does not isolate a transaction (src/adapter.ts). So the
// confirm can meet the insert of the magic link as a unique key. Before plan
// 12o a session race then undid the claim of the magic link, with its insert
// and its flip. Since plan 12o that claim stays, so the retry of the confirm
// loses its flip or finds a verified user.
//
// Each row comes from a real flow: an operator create, impersonations,
// a magic link, and sign-outs. The app turned the impersonation tool off
// after the impersonations, so these rows are plain sessions for each
// claim (K6 of plan 12f2). Each step of the race runs in a watch after a
// statement, as a parallel request on the binding does between two queries.

const BASE = "https://api.example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const ADA = "ada@example.com";
// D1 Free allows 50 queries per invocation (D1 limits page updated 21
// April 2026, read 2026-10-24, as anonymous-upgrade-budget.test.ts says).
const BUDGET = 50;
const RAW = Symbol("raw");
const SQL = Symbol("sql");

const IDENTITY_READ = /^SELECT\b[\s\S]*\bFROM ta_identity WHERE provider = \? AND subject = \?/;
const IDENTITY_INSERT = /^INSERT INTO ta_identity\b/;
/** The spend of a link, not its undo: the undo sets each value by a CASE form. */
const CONSUME = /^UPDATE ta_verification SET consumed_at = \?/;
/** The flip of a claim, not the undo of a flip. */
const FLIP = /^UPDATE ta_user SET email_verified = \?/;
/**
 * The take of a stale lease (plan 12p). A claim runs it only when its lease
 * create met the key of another lease. The watch sees no statement that
 * throws, so it sees this one in place of the create.
 */
const LEASE = /^UPDATE ta_verification SET expires_at = \?/;
/** The claim's read of the claimant sessions, before their delete by id. */
const SESSION_READ = /^SELECT\b[\s\S]*\bFROM ta_session WHERE user_id = \?/;

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

/**
 * The D1 code over the binding with no query limit: the seam and the
 * options of `createSqliteAdapter`, which runs this code on every SQLite
 * driver. So this store keeps the D1 undo log and has no isolation.
 */
function noLimit(db: D1Database): StorageAdapter {
  const sent = { statements: 0, ready: 0 };
  return createD1AdapterOn(db, {
    statements: coreStatements(SQLITE),
    toStorageError,
    ready: schemaVersionCheckOn(db, sent),
    ping: schemaVersionPing(db, sent),
    sent,
  });
}

/** The session ends that the hook saw, across the invocations of one test. */
const endings: { id: string; reason: string }[] = [];

/**
 * The engine on `db`, one invocation, with the user tools. The
 * `session.afterEnd` hook makes a claim read its sessions and then delete
 * them by id. A sign-out between the two ends a row that the claim's delete
 * then does not answer, and the claim goes on (plan 12o).
 */
function engine(
  db: D1Database,
  sent: MailMessage[],
  opts: { impersonation: boolean; limit: boolean; limiter?: boolean },
) {
  const storage = opts.limit ? createD1Adapter(db) : noLimit(db);
  const input: AuthConfig = {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: opts.limiter ? createD1Limiter(db) : { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true, ...(opts.impersonation ? { impersonation: {} } : {}) },
    hooks: {
      session: { afterEnd: ({ session, reason }) => void endings.push({ id: session.id, reason }) },
    },
  };
  return { auth: createAuth(input), storage };
}
type Auth = ReturnType<typeof engine>["auth"];

const post = (path: string, body: unknown, cookie?: string) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "198.51.100.7",
      ...(cookie ? { cookie: `__Host-tempo_session=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** The queries of one request, from a count of zero, with the work after the answer. */
async function measure(auth: Auth, count: { queries: number }, request: Request) {
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

/** The token of the newest link to `to` whose token starts with `prefix`. */
function tokenOf(sent: MailMessage[], to: string, prefix: string): string {
  for (const m of [...sent].reverse()) {
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(m.text)?.[1] ?? "");
    if (m.to === to && token.startsWith(prefix)) return token;
  }
  throw new Error(`no ${prefix} link to ${to}`);
}

/** A magic link sign-in of `email`: the session token. */
async function signIn(auth: Auth, sent: MailMessage[], email: string): Promise<string> {
  await auth.api.requestMagicLink({ email, ip: null });
  const r = await auth.api.verifyMagicLink({
    token: tokenOf(sent, email, "ml_"),
    ip: null,
    userAgent: null,
  });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return r.value.token;
}

/**
 * Makes the rows of the race through the engine, with the impersonation
 * tool on. They are a platform operator with a password and the email
 * second factor, an invited user, and `count` impersonations of that user.
 * Answers the invitation token, and the token and the id of each
 * impersonation session.
 */
async function invitedWithSessions(sent: MailMessage[], count: number) {
  const { auth } = engine(env.DB, sent, { impersonation: true, limit: true });
  const made = await auth.api.operator.createAdmin({
    actor: APP,
    email: "op@example.com",
    reason: "First operator",
    ip: null,
    userAgent: null,
  });
  if (!made.ok) throw new Error(made.code);
  const opToken = await signIn(auth, sent, "op@example.com");
  const op = await auth.api.getSession(opToken);
  if (!op) throw new Error("no session");
  const changed = await auth.api.password?.change({
    session: op,
    newPassword: "correct horse battery",
  });
  if (!changed?.ok) throw new Error("no password");
  const enabled = await auth.handle(
    post("/second-factor/email/enable", { password: "correct horse battery" }, opToken),
  );
  if (enabled.status !== 200) throw new Error(`enable answered ${enabled.status}`);
  const operator = await auth.api.getSession(opToken);
  if (!operator) throw new Error("no session");
  const invited = await auth.api.operator.users.create({
    actor: APP,
    email: ADA,
    reason: "Ticket 4521",
    ip: null,
    userAgent: null,
  });
  if (!invited.ok) throw new Error(invited.code);
  const tokens: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = await auth.api.operator.impersonate({
      operator,
      userId: invited.value.userId,
      reason: `Ticket ${i}`,
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
    tokens.push(r.value.token);
    ids.push(r.value.session.id);
  }
  return { userId: invited.value.userId, invite: tokenOf(sent, ADA, "ui_"), tokens, ids };
}

/** The rows of the invited user that a claim writes, read on the binding. */
async function rowsOf(userId: string) {
  const user = await env.DB.prepare("SELECT email_verified AS v FROM ta_user WHERE id = ?")
    .bind(userId)
    .first<{ v: number }>();
  const ids = async (sql: string) =>
    (await env.DB.prepare(sql).bind(userId).all<{ id: string }>()).results.map((r) => r.id);
  const invite = await env.DB.prepare(
    "SELECT consumed_at AS c FROM ta_verification WHERE purpose = 'user-invite' AND identifier = ?",
  )
    .bind(userId)
    .first<{ c: unknown }>();
  return {
    verified: user?.v === 1,
    emailIdentities: (
      await ids("SELECT id FROM ta_identity WHERE user_id = ? AND provider = 'email'")
    ).length,
    sessions: await ids("SELECT id FROM ta_session WHERE user_id = ? ORDER BY id"),
    inviteSpent: invite !== null && invite.c !== null,
  };
}

/** A step that one flow opens and another flow waits for. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open: () => open(), opened };
}

// The counts of the run of 2026-11-04 on the D1 binding of this pool (plan
// 12o). The first is the request of the race. The second is the request
// that the client sends again. Each is one invocation with the D1 limiter on
// the same view. On 2026-11-03 the race took 36 and the request again 27.
const PINS = { race: 28, again: 15 };

describe("the invitation confirm beside a magic link of the address on D1 (rulings 38 and 42 of plan 12n, plan 12o)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("DELETE FROM ta_limit").run();
    endings.length = 0;
  });

  /**
   * The magic link of the address, in its own invocation, on the binding
   * with no count. It inserts the email identity and waits. When `resume`
   * opens, it goes on to its flip, opens `flipped`, and waits for `race`.
   * Then a sign-out lands between the read of its claim and the delete. The
   * claim goes on and ends the other rows (plan 12o).
   */
  function magicLink(
    sent: MailMessage[],
    signOut: () => Promise<void>,
    limit: boolean,
    outs: string[],
  ) {
    const inserted = gate();
    const resume = gate();
    const flipped = gate();
    const race = gate();
    let step: "insert" | "flip" | "race" | "end" = "insert";
    const side = engine(
      view(
        env.DB,
        async (sql) => {
          if (step === "insert" && IDENTITY_INSERT.test(sql)) {
            // 1. It inserts the email identity, and the confirm goes on.
            step = "flip";
            inserted.open();
            await resume.opened;
          } else if (step === "flip" && FLIP.test(sql)) {
            // 3. It flips the user after the confirm read the user, and the confirm goes on.
            step = "race";
            flipped.open();
            await race.opened;
          } else if (step === "race" && SESSION_READ.test(sql)) {
            // 5. A sign-out between the read of its claim and the delete.
            step = "end";
            outs.push("magic link");
            await signOut();
          }
        },
        null,
      ).db,
      sent,
      { impersonation: false, limit },
    ).auth;
    return { side, inserted, resume, flipped, race };
  }

  it("answers 409 conflict to a lost flip within the D1 Free budget, keeps the link, and signs in at the request again", async () => {
    const sent: MailMessage[] = [];
    const s = await invitedWithSessions(sent, 3);
    // Each sign-out is a request in another invocation, on the binding with no count.
    const quiet = engine(env.DB, sent, { impersonation: false, limit: true }).auth;
    expect((await quiet.handle(post("/magic-link/request", { email: ADA }))).status).toBe(200);
    const link = tokenOf(sent, ADA, "ml_");
    const mark = endings.length;
    const outs: string[] = [];
    const m = magicLink(sent, () => quiet.api.signOut(s.tokens[0] ?? ""), true, outs);
    let answer: Promise<Response> | null = null;
    let stage: "first" | "retry" | "flip" = "first";
    const v = view(
      env.DB,
      async (sql) => {
        if (stage === "first" && IDENTITY_READ.test(sql)) {
          // The confirm read no identity. The magic link runs up to its insert.
          stage = "retry";
          answer = m.side.handle(post("/magic-link/verify", { token: link }));
          await m.inserted.opened;
        } else if (stage === "retry" && IDENTITY_READ.test(sql)) {
          // 2. The insert of the confirm met the unique key. Its retry read
          // an unverified user and found the identity of the magic link.
          // 4. The magic link flips first: the flip of the confirm matches no row.
          stage = "flip";
          m.resume.open();
          await m.flipped.opened;
        }
      },
      BUDGET,
    );
    const { auth } = engine(v.db, sent, { impersonation: false, limit: true, limiter: true });
    const race = await measure(auth, v.count, post("/user/invite/confirm", { token: s.invite }));
    expect(stage).toBe("flip");
    // On a store with a query limit, the confirm runs no claim retry (ruling 32 of plan 12n).
    expect([race.res.status, await race.res.json()]).toEqual([409, { error: "conflict" }]);
    expect(setToken(race.res)).toBeNull();
    // The magic link goes on: the race ends one row, and its claim stays.
    m.race.open();
    const won = (await answer) as Response | null;
    expect(won?.status).toBe(200);
    expect(outs).toEqual(["magic link"]);
    const signedIn = await quiet.api.getSession(setToken(won as Response) ?? "");
    // The undo of the confirm left the invitation link usable.
    expect(await rowsOf(s.userId)).toEqual({
      verified: true,
      emailIdentities: 1,
      sessions: [signedIn?.session.id],
      inviteSpent: false,
    });
    // Each claimant row ended once: one by the sign-out, the rest by the claim.
    expect(endings.slice(mark)).toEqual([
      { id: s.ids[0], reason: "sign_out" },
      { id: s.ids[1], reason: "claim" },
      { id: s.ids[2], reason: "claim" },
    ]);

    // The client sends the request again, in a new invocation. The user is verified now.
    const next = view(env.DB, null, BUDGET);
    const later = engine(next.db, sent, { impersonation: false, limit: true, limiter: true }).auth;
    const again = await measure(
      later,
      next.count,
      post("/user/invite/confirm", { token: s.invite }),
    );
    expect(again.res.status).toBe(200);
    const me = await quiet.api.getSession(setToken(again.res) ?? "");
    expect(me?.user.id).toBe(s.userId);
    expect(me?.user.emailVerified).toBe(true);
    const after = await rowsOf(s.userId);
    expect(after).toMatchObject({ verified: true, emailIdentities: 1, inviteSpent: true });
    expect(after.sessions.sort()).toEqual([signedIn?.session.id, me?.session.id].sort());
    expect(endings.slice(mark + 3)).toEqual([]);
    expect({ race: race.queries, again: again.queries }).toEqual(PINS);
    expect(Math.max(race.queries, again.queries)).toBeLessThanOrEqual(BUDGET);
  });

  // The counter case of decision 13 holds on a store with no query limit.
  // Since plan 12o a session race throws nothing, so the one claim retry is
  // the lost claim. Since plan 12p the claim loses at its lease.
  it("signs in after a unique-key retry and a lost claim on the D1 code with no query limit", async () => {
    const sent: MailMessage[] = [];
    const s = await invitedWithSessions(sent, 4);
    const quiet = engine(env.DB, sent, { impersonation: false, limit: false }).auth;
    expect((await quiet.handle(post("/magic-link/request", { email: ADA }))).status).toBe(200);
    const link = tokenOf(sent, ADA, "ml_");
    const mark = endings.length;
    const outs: string[] = [];
    const m = magicLink(sent, () => quiet.api.signOut(s.tokens[0] ?? ""), false, outs);
    let answer: Promise<Response> | null = null;
    let stage = 0;
    let flips = 0;
    let leases = 0;
    const v = view(
      env.DB,
      async (sql) => {
        if (FLIP.test(sql)) flips++;
        if (LEASE.test(sql)) leases++;
        if (stage === 0 && IDENTITY_READ.test(sql)) {
          // The confirm read no identity. The magic link runs up to its insert.
          stage = 1;
          answer = m.side.handle(post("/magic-link/verify", { token: link }));
          await m.inserted.opened;
        } else if (stage === 1 && IDENTITY_READ.test(sql)) {
          // 2. The insert of the confirm met the unique key. Its retry read
          // an unverified user and found the identity of the magic link.
          stage = 2;
          m.resume.open();
          await m.flipped.opened;
        } else if (stage === 2 && CONSUME.test(sql)) {
          // 4. The lease of the confirm met the lease of the magic link: a
          // claim retry spent the link again. The magic link ends its claim first.
          stage = 3;
          m.race.open();
          await answer;
        }
      },
      null,
    );
    const { auth, storage } = engine(v.db, sent, {
      impersonation: false,
      limit: false,
      limiter: true,
    });
    expect(storage.queryLimitPerInvocation).toBeUndefined();
    const res = await auth.handle(post("/user/invite/confirm", { token: s.invite }));
    expect(stage).toBe(3);
    expect(outs).toEqual(["magic link"]);
    expect(res.status).toBe(200);
    // The lost lease only (plan 12p): no flip, and the retry found a verified user and claimed nothing.
    expect({ leases, flips }).toEqual({ leases: 1, flips: 0 });
    const me = await quiet.api.getSession(setToken(res) ?? "");
    expect(me?.user.id).toBe(s.userId);
    expect(me?.user.emailVerified).toBe(true);
    const late = (await answer) as Response | null;
    expect(late?.status).toBe(200);
    const after = await rowsOf(s.userId);
    expect(after).toMatchObject({ verified: true, emailIdentities: 1, inviteSpent: true });
    expect(after.sessions).toHaveLength(2);
    expect(after.sessions).toContain(me?.session.id);
    // Each impersonation row ended once: one by a sign-out, the rest by the magic link's claim.
    expect(endings.slice(mark)).toEqual([
      { id: s.ids[0], reason: "sign_out" },
      { id: s.ids[1], reason: "claim" },
      { id: s.ids[2], reason: "claim" },
      { id: s.ids[3], reason: "claim" },
    ]);
  });
});
