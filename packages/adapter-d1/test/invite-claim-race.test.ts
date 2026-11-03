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
// confirm can meet the insert of the magic link as a unique key. Then the
// magic link can undo its insert and its flip, and the retry of the
// confirm meets an unverified user and claims.
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
/** The undo of an identity create. The claim's own identity delete names the user id. */
const IDENTITY_UNDO = /^DELETE FROM ta_identity WHERE id = \?/;
/** The spend of a link, not its undo: the undo sets each value by a CASE form. */
const CONSUME = /^UPDATE ta_verification SET consumed_at = \?/;
/** The flip of a claim, not the undo of a flip. */
const FLIP = /^UPDATE ta_user SET email_verified = \?/;
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
 * them by id. So a sign-out between the two undoes the claim.
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

// The counts of the run of 2026-11-03 on the D1 binding of this pool. The
// first is the request of the race. The second is the request that the
// client sends again. Each is one invocation with the D1 limiter on the
// same view.
const PINS = { race: 36, again: 27 };

describe("the invitation confirm after a magic link undid its email identity on D1 (rulings 38 and 42 of plan 12n)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("DELETE FROM ta_limit").run();
    endings.length = 0;
  });

  it("answers 409 conflict within the D1 Free budget when the confirm meets an unverified user and loses its claim, and signs in at the request again", async () => {
    const sent: MailMessage[] = [];
    const s = await invitedWithSessions(sent, 3);
    // Each sign-out is a request in another invocation, on the binding with no count.
    const quiet = engine(env.DB, sent, { impersonation: false, limit: true }).auth;
    expect((await quiet.handle(post("/magic-link/request", { email: ADA }))).status).toBe(200);
    const link = tokenOf(sent, ADA, "ml_");
    const mark = endings.length;
    const inserted = gate();
    const resume = gate();
    const outs: string[] = [];
    const magic: { answer: Promise<Response> | null; gated: boolean; flipped: boolean } = {
      answer: null,
      gated: false,
      flipped: false,
    };
    // The magic link of the address, in its own invocation.
    const side = engine(
      view(
        env.DB,
        async (sql) => {
          if (!magic.gated && IDENTITY_INSERT.test(sql)) {
            // 1. It inserts the email identity, and the confirm goes on.
            magic.gated = true;
            inserted.open();
            await resume.opened;
          } else if (FLIP.test(sql)) magic.flipped = true;
          else if (magic.flipped && outs.length === 0 && SESSION_READ.test(sql)) {
            // 3. A sign-out between the read of its claim and the delete:
            // its claim loses, and its undo takes the identity and the flip.
            outs.push("magic link");
            await quiet.api.signOut(s.tokens[0] ?? "");
          }
        },
        null,
      ).db,
      sent,
      { impersonation: false, limit: true },
    ).auth;
    let stage: "first" | "retry" | "claim" | "done" = "first";
    let flipped = false;
    const v = view(
      env.DB,
      async (sql) => {
        if (stage === "first" && IDENTITY_READ.test(sql)) {
          // The confirm read no identity. The magic link runs up to its insert.
          stage = "retry";
          magic.answer = side.handle(post("/magic-link/verify", { token: link }));
          await inserted.opened;
        } else if (stage === "retry" && CONSUME.test(sql)) {
          // 2. The insert of the confirm met the unique key, and the retry
          // spent the link again. The magic link goes on and undoes.
          stage = "claim";
          resume.open();
          await magic.answer;
        } else if (stage === "claim" && FLIP.test(sql)) flipped = true;
        else if (stage === "claim" && flipped && SESSION_READ.test(sql)) {
          // 4. The retry met an unverified user and claimed. A sign-out
          // between the read of its claim and the delete makes it lose.
          stage = "done";
          outs.push("confirm");
          await quiet.api.signOut(s.tokens[1] ?? "");
        }
      },
      BUDGET,
    );
    const { auth } = engine(v.db, sent, { impersonation: false, limit: true, limiter: true });
    const race = await measure(auth, v.count, post("/user/invite/confirm", { token: s.invite }));
    expect(stage).toBe("done");
    expect(outs).toEqual(["magic link", "confirm"]);
    // On a store with a query limit, the confirm runs no claim retry (ruling 32 of plan 12n).
    expect([race.res.status, await race.res.json()]).toEqual([409, { error: "conflict" }]);
    expect(setToken(race.res)).toBeNull();
    const lost = await magic.answer;
    expect([lost?.status, await lost?.json()]).toEqual([409, { error: "conflict" }]);
    // The undos left no write of either claim, and the invitation link stays usable.
    expect(await rowsOf(s.userId)).toEqual({
      verified: false,
      emailIdentities: 0,
      sessions: [s.ids[2]],
      inviteSpent: false,
    });
    // Each signed-out row ended once. The undone runs ended no row.
    expect(endings.slice(mark)).toEqual([
      { id: s.ids[0], reason: "sign_out" },
      { id: s.ids[1], reason: "sign_out" },
    ]);

    // The client sends the request again, in a new invocation.
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
    expect(await rowsOf(s.userId)).toEqual({
      verified: true,
      emailIdentities: 1,
      sessions: [me?.session.id],
      inviteSpent: true,
    });
    expect(endings.slice(mark + 2)).toEqual([{ id: s.ids[2], reason: "claim" }]);
    expect({ race: race.queries, again: again.queries }).toEqual(PINS);
    expect(Math.max(race.queries, again.queries)).toBeLessThanOrEqual(BUDGET);
  });

  // The counter case of decision 13 holds on a store with no query limit.
  // In the run of 2026-11-03 the confirm sent 97 queries on the binding:
  // a D1 Free invocation cannot run these retries.
  it("signs in after a unique-key retry, a lost flip, and two session races on the D1 code with no query limit", async () => {
    const sent: MailMessage[] = [];
    const s = await invitedWithSessions(sent, 4);
    const quiet = engine(env.DB, sent, { impersonation: false, limit: false }).auth;
    expect((await quiet.handle(post("/magic-link/request", { email: ADA }))).status).toBe(200);
    const link = tokenOf(sent, ADA, "ml_");
    const mark = endings.length;
    const inserted = gate();
    const toFlip = gate();
    const flippedFirst = gate();
    const toRace = gate();
    const undone = gate();
    const toEnd = gate();
    const outs: string[] = [];
    const magic: {
      answer: Promise<Response> | null;
      step: "insert" | "flip" | "race" | "undo" | "end";
    } = { answer: null, step: "insert" };
    const side = engine(
      view(
        env.DB,
        async (sql) => {
          if (magic.step === "insert" && IDENTITY_INSERT.test(sql)) {
            // 1. It inserts the email identity, and the confirm goes on.
            magic.step = "flip";
            inserted.open();
            await toFlip.opened;
          } else if (magic.step === "flip" && FLIP.test(sql)) {
            // 3. It flips the user after the confirm read the user, and the confirm goes on.
            magic.step = "race";
            flippedFirst.open();
            await toRace.opened;
          } else if (magic.step === "race" && SESSION_READ.test(sql)) {
            // 5. A sign-out between the read of its claim and the delete:
            // its claim loses, and its undo takes the flip and the identity.
            magic.step = "undo";
            outs.push("magic link");
            await quiet.api.signOut(s.tokens[0] ?? "");
          } else if (magic.step === "undo" && IDENTITY_UNDO.test(sql)) {
            // Its retry waits until the confirm answers.
            magic.step = "end";
            undone.open();
            await toEnd.opened;
          }
        },
        null,
      ).db,
      sent,
      { impersonation: false, limit: false },
    ).auth;
    let stage = 0;
    let flipped = false;
    let flips = 0;
    const v = view(
      env.DB,
      async (sql) => {
        if (FLIP.test(sql)) flips++;
        if (stage === 0 && IDENTITY_READ.test(sql)) {
          // The confirm read no identity. The magic link runs up to its insert.
          stage = 1;
          magic.answer = side.handle(post("/magic-link/verify", { token: link }));
          await inserted.opened;
        } else if (stage === 1 && IDENTITY_READ.test(sql)) {
          // 2. The insert of the confirm met the unique key. Its retry read
          // an unverified user and found the identity of the magic link.
          stage = 2;
          toFlip.open();
          await flippedFirst.opened;
        } else if (stage === 2 && CONSUME.test(sql)) {
          // 4. The flip of the confirm matched no row: a claim retry spent the
          // link again. The magic link goes on and undoes.
          stage = 3;
          toRace.open();
          await undone.opened;
        } else if ((stage === 3 || stage === 4) && FLIP.test(sql)) flipped = true;
        else if ((stage === 3 || stage === 4) && flipped && SESSION_READ.test(sql)) {
          // 6 and 7. The retry met an unverified user and claimed. A sign-out
          // between the read of its claim and the delete makes it lose.
          flipped = false;
          outs.push("confirm");
          await quiet.api.signOut(s.tokens[stage - 2] ?? "");
          stage++;
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
    toEnd.open();
    const late = await magic.answer;
    expect(stage).toBe(5);
    expect(outs).toEqual(["magic link", "confirm", "confirm"]);
    expect(res.status).toBe(200);
    // The lost flip, two runs that a race undid, and the run that holds.
    expect(flips).toBe(4);
    const me = await quiet.api.getSession(setToken(res) ?? "");
    expect(me?.user.id).toBe(s.userId);
    expect(me?.user.emailVerified).toBe(true);
    // The retry of the magic link found a verified user and signed in with no claim.
    expect(late?.status).toBe(200);
    const after = await rowsOf(s.userId);
    expect(after).toMatchObject({ verified: true, emailIdentities: 1, inviteSpent: true });
    expect(after.sessions).toHaveLength(2);
    expect(after.sessions).toContain(me?.session.id);
    // Each impersonation row ended once: three by a sign-out, and the last by the claim.
    expect(endings.slice(mark)).toEqual([
      { id: s.ids[0], reason: "sign_out" },
      { id: s.ids[1], reason: "sign_out" },
      { id: s.ids[2], reason: "sign_out" },
      { id: s.ids[3], reason: "claim" },
    ]);
  });
});
