import { env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash, type MailMessage } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The undo guard of a claim on D1 (decision 6 of plan 12q, rr-fix6 Minor 1
// of plan 12p). D1 can apply a write and lose its answer: its error page
// names "Network connection lost." An update that throws pushes no undo
// entry. So a flip whose answer is lost stands, and the undo still runs the
// entries before it. Before the guard, that undo put back the claimant's
// password on a verified user. Now the claim calls `undoOnlyWhile` after its
// lease. The undo of each later delete puts its rows back only while the
// user is unverified.
//
// Every step is a real request through `auth.handle`. The owner's magic
// link runs on a view of the binding that throws once at one statement.
// The scenes are the probes U0, U1, and U2 of rr-fix6, and the plan's form
// of U2:
// - U0 (the control): the flip throws before it runs.
// - U1: the flip runs, and then its answer is lost.
// - U2: the session delete runs, and then its answer is lost.
// - U3 (probe U2 of rr-fix6): the session delete throws before it runs.
//
// The claim is final at its flip (ruling 38 of plan 12q). So in U2 and U3
// the undo puts back no flip, and the claimant's rows stay gone. Before
// that ruling, U2 put the claimant's rows back with the unverified user.
//
// U1 and U3 leave the claimant's session from before the proof on a verified
// user. The door of a claimed session refuses it and ends it at its first
// read (ruling 13 of plan 12q). The third block holds that for four acts.
// The last block holds a throw in the session chunks after the owner signed
// in by a second link (Minor 1 of rr-wave2).

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const RAW = Symbol("raw");
const SQL = Symbol("sql");
const PASSWORD = "correct horse battery";
const EMAIL = "ada@example.com";
/** The flip: the update of the user row that marks the address verified. */
const FLIP = /^UPDATE ta_user SET email_verified = \?/;
/** The session delete of the claim, its last step. */
const SESSION_DELETE = /^DELETE FROM ta_session\b/;
/** The undo's restore of the flip: an update of the user row by id. */
const USER_UPDATE = /^UPDATE ta_user\b/;
/** The text of a lost answer, as D1 names it. */
const LOST = "D1_ERROR: Network connection lost.";

/** A check of one statement: it runs before the statement, or after it with its answer in hand. */
type Gate = (sql: string) => Promise<void>;

/**
 * A view of `db` that runs `before` ahead of each statement and `after`
 * behind it, also for each statement of a batch. A throw in `before` stops
 * the statement. A throw in `after` loses the answer of a statement that ran.
 */
function viewOf(db: D1Database, before: Gate, after: Gate): D1Database {
  const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === SQL) return sql;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return async (...args: unknown[]) => {
            await before(sql);
            const out = await (target[key] as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
            await after(sql);
            return out;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const texts = statements.map((s) =>
            String((s as unknown as Record<symbol, string>)[SQL] ?? ""),
          );
          for (const text of texts) await before(text);
          const out = await target.batch(
            statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s),
          );
          for (const text of texts) await after(text);
          return out;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

let current = new Date("2026-11-05T00:00:00.000Z");
const clock = { now: () => current };
const mail: MailMessage[] = [];
/** Each session end that the hook saw, as `reason:id`. */
const ends: string[] = [];

/** One invocation of the engine on `db`. An `afterEnd` hook, so the claim ends its sessions by `deleteRows`. */
function make(db: D1Database = env.DB) {
  return createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(env.DB),
    clock,
    mail: { send: async (m) => void mail.push(m) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    hooks: { session: { afterEnd: (e) => void ends.push(`${e.reason}:${e.session.id}`) } },
  });
}

let ip = 0;
/** A JSON request of the routes, with the Origin of the app and a new client IP. */
function post(path: string, body: unknown, cookie: string | null = null): Request {
  ip++;
  return new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(ip % 250) + 1}`,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** A GET of the routes with the session of `cookie`. */
function getWith(path: string, cookie: string): Request {
  ip++;
  return new Request(`${BASE}/auth${path}`, {
    headers: { origin: APP_ORIGIN, "cf-connecting-ip": `198.51.100.${(ip % 250) + 1}`, cookie },
  });
}

/** `handle`, and the work after the answer. */
async function call(auth: ReturnType<typeof make>, request: Request): Promise<Response> {
  const after: Promise<unknown>[] = [];
  const res = await auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return res;
}

/** The status and the error code of an answer, or "ok". */
async function answer(res: Response): Promise<string> {
  const body = (await res.clone().text()) || "{}";
  try {
    return `${res.status} ${(JSON.parse(body) as { error?: string }).error ?? "ok"}`;
  } catch {
    return `${res.status} page`;
  }
}

/** The session cookie that an answer sets, as a Cookie header. */
function cookieOf(res: Response): string {
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
  const token = line?.slice("__Host-tempo_session=".length).split(";")[0] ?? "";
  expect(token).not.toBe("");
  return `__Host-tempo_session=${token}`;
}

/** The token of the last magic link in the mail. */
function linkToken(): string {
  return decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "");
}

/** The rows of the claimed user after a step. */
async function rows() {
  const user = await env.DB.prepare("SELECT id, email_verified AS v FROM ta_user WHERE email = ?")
    .bind(EMAIL)
    .first<{ id: string; v: number }>();
  const count = async (sql: string, ...values: unknown[]) =>
    (
      await env.DB.prepare(sql)
        .bind(...values)
        .first<{ n: number }>()
    )?.n ?? -1;
  return {
    verified: user?.v === 1,
    passwords: await count("SELECT COUNT(*) AS n FROM ta_password WHERE user_id = ?", user?.id),
    sessions: await count("SELECT COUNT(*) AS n FROM ta_session WHERE user_id = ?", user?.id),
    leases: await count("SELECT COUNT(*) AS n FROM ta_verification WHERE purpose = 'claim-lease'"),
  };
}

/** The sessions of the claimed user, by id, with their proof flag. */
async function sessions() {
  return (
    await env.DB.prepare(
      "SELECT id, proved FROM ta_session WHERE user_id = (SELECT id FROM ta_user WHERE email = ?) ORDER BY id",
    )
      .bind(EMAIL)
      .all<{ id: string; proved: number }>()
  ).results;
}

/** The claimant's sign-up with a password: one password row and one unproved session. */
async function claimant(): Promise<string> {
  const up = await call(make(), post("/password/sign-up", { email: EMAIL, password: PASSWORD }));
  expect(await answer(up)).toBe("200 ok");
  return cookieOf(up);
}

/** The owner's magic link, verified on `db`. */
async function ownerLink(db: D1Database = env.DB): Promise<string> {
  expect((await call(make(), post("/magic-link/request", { email: EMAIL }))).status).toBe(200);
  return answer(await call(make(db), post("/magic-link/verify", { token: linkToken() })));
}

/** A password sign-in of the claimant. */
async function claimantSignIn(): Promise<string> {
  return answer(
    await call(make(), post("/password/sign-in", { email: EMAIL, password: PASSWORD })),
  );
}

/** An API token create, a verified-only act, with the session of `cookie`. */
async function tokenWith(cookie: string): Promise<string> {
  return answer(await call(make(), post("/tokens", { name: "ci" }, cookie)));
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
  mail.length = 0;
  ends.length = 0;
  current = new Date("2026-11-05T00:00:00.000Z");
});

describe("the undo of a claim whose answer is lost on D1 (decision 6 of plan 12q)", () => {
  it("U0, the control: a flip that throws before it runs leaves the user unverified with the claimant's rows, and the owner's next link claims", async () => {
    const session = await claimant();
    let thrown = 0;
    const view = viewOf(
      env.DB,
      async (sql) => {
        if (thrown === 0 && FLIP.test(sql)) {
          thrown++;
          throw new Error("D1_ERROR: the flip failed before it ran.");
        }
      },
      async () => {},
    );
    expect(await ownerLink(view)).toBe("500 internal");
    expect(thrown).toBe(1);
    expect(await rows()).toEqual({ verified: false, passwords: 1, sessions: 1, leases: 0 });
    // The claimant is back where it was: an unverified user with its password.
    expect(await claimantSignIn()).toBe("200 ok");
    expect(await tokenWith(session)).toBe("403 email_unverified");
    // The owner's next link claims.
    expect(await ownerLink()).toBe("200 ok");
    expect(await rows()).toMatchObject({ verified: true, passwords: 0 });
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
  });

  it("U1: a flip that ran and lost its answer leaves the user verified, and no row of the claimant comes back", async () => {
    const session = await claimant();
    let thrown = 0;
    const view = viewOf(
      env.DB,
      async () => {},
      async (sql) => {
        if (thrown === 0 && FLIP.test(sql)) {
          thrown++;
          throw new Error(LOST);
        }
      },
    );
    expect(await ownerLink(view)).toBe("500 internal");
    expect(thrown).toBe(1);
    // The flip stands. The undo put back no password and deleted the lease.
    // The session delete never ran, so the claimant's session stays.
    expect(await rows()).toEqual({ verified: true, passwords: 0, sessions: 1, leases: 0 });
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
    // That session came before the proof, and the user is verified now. So the
    // door of a claimed session refuses it and ends it (ruling 13 of plan 12q).
    expect(await tokenWith(session)).toBe("401 unauthorized");
    expect(await rows()).toMatchObject({ sessions: 0 });
    // The owner signs in with a new link. The user is verified, so no claim runs.
    expect(await ownerLink()).toBe("200 ok");
    expect(await rows()).toMatchObject({ verified: true, passwords: 0 });
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
  });

  it("U2: a session delete that ran and lost its answer keeps the flip, and no row of the claimant comes back", async () => {
    await claimant();
    let thrown = 0;
    const view = viewOf(
      env.DB,
      async () => {},
      async (sql) => {
        if (thrown === 0 && SESSION_DELETE.test(sql)) {
          thrown++;
          throw new Error(LOST);
        }
      },
    );
    expect(await ownerLink(view)).toBe("500 internal");
    expect(thrown).toBe(1);
    // The session delete stands, and the claim is final at its flip (ruling
    // 38 of plan 12q). So the user stays verified, and the password stays
    // gone. The lease stays for the sweep, as after a claim that ends.
    expect(await rows()).toEqual({ verified: true, passwords: 0, sessions: 0, leases: 1 });
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
    // The owner signs in with a new link. The user is verified, so no claim runs.
    expect(await ownerLink()).toBe("200 ok");
    expect(await rows()).toMatchObject({ verified: true, passwords: 0 });
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
  });

  it("U3: a session delete that throws before it runs keeps the flip, and the undo sends no update of the user row", async () => {
    const session = await claimant();
    let thrown = 0;
    let flipped = false;
    let userUpdates = 0;
    const view = viewOf(
      env.DB,
      async (sql) => {
        if (FLIP.test(sql)) flipped = true;
        else if (flipped && thrown === 0 && SESSION_DELETE.test(sql)) {
          thrown++;
          throw new Error("D1_ERROR: the session delete failed.");
        } else if (thrown === 1 && USER_UPDATE.test(sql)) userUpdates++;
      },
      async () => {},
    );
    expect(await ownerLink(view)).toBe("500 internal");
    expect(thrown).toBe(1);
    // The claim is final at its flip (ruling 38 of plan 12q). So the undo
    // has no restore of the flip, and it puts back no password.
    expect(userUpdates).toBe(0);
    expect(await rows()).toEqual({ verified: true, passwords: 0, sessions: 1, leases: 1 });
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
    // The door of a claimed session refuses the claimant's session and ends it (ruling 13 of plan 12q).
    expect(await tokenWith(session)).toBe("401 unauthorized");
    expect(await rows()).toMatchObject({ sessions: 0 });
    expect(await ownerLink()).toBe("200 ok");
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
  });
});

describe("the claimant's session after a lost flip answer on D1 (ruling 13 of plan 12q)", () => {
  // Scene U1 leaves the user verified with the claimant's sign-up session. It
  // is unproved, and fresh for a day by default. Before the door it read the
  // account, listed and ended the owner's sessions, and deleted the account
  // (open point 1 of the Task 4 report). Now each act meets the door first.
  const ACTS: [string, (cookie: string) => Request][] = [
    ["GET /session", (c) => getWith("/session", c)],
    ["GET /sessions", (c) => getWith("/sessions", c)],
    ["POST /sessions/revoke-others", (c) => post("/sessions/revoke-others", {}, c)],
    ["POST /user/delete", (c) => post("/user/delete", {}, c)],
  ];
  for (const [name, act] of ACTS)
    it(`${name} answers 401, ends the claimant's session once with the reason claimed, and the owner's session lives`, async () => {
      const session = await claimant();
      let thrown = 0;
      const view = viewOf(
        env.DB,
        async () => {},
        async (sql) => {
          if (thrown === 0 && FLIP.test(sql)) {
            thrown++;
            throw new Error(LOST);
          }
        },
      );
      expect(await ownerLink(view)).toBe("500 internal");
      expect(thrown).toBe(1);
      // The owner signs in with a new link. The user is verified, so no claim runs.
      expect((await call(make(), post("/magic-link/request", { email: EMAIL }))).status).toBe(200);
      const signedIn = await call(make(), post("/magic-link/verify", { token: linkToken() }));
      expect(await answer(signedIn)).toBe("200 ok");
      const owner = cookieOf(signedIn);
      const before = await sessions();
      expect(before.map((s) => s.proved).sort()).toEqual([0, 1]);
      const claimed = before.find((s) => s.proved === 0)?.id;
      expect(ends).toEqual([]);
      // The act meets the door: 401, and the hook sees one end with the reason claimed.
      expect(await answer(await call(make(), act(session)))).toBe("401 unauthorized");
      expect(ends).toEqual([`claimed:${claimed}`]);
      expect(await answer(await call(make(), getWith("/session", session)))).toBe(
        "401 unauthorized",
      );
      expect(ends).toHaveLength(1);
      // The owner keeps the verified account and its own proved session.
      expect(await rows()).toEqual({ verified: true, passwords: 0, sessions: 1, leases: 0 });
      expect((await sessions()).map((s) => s.proved)).toEqual([1]);
      expect(await answer(await call(make(), getWith("/session", owner)))).toBe("200 ok");
    });
});

describe("a throw in the session chunks after the owner signed in by a second link on D1 (ruling 38 of plan 12q)", () => {
  // Minor 1 of rr-wave2. Claim A is the owner's first magic link. A flips the
  // user and pauses before its session chunks. The owner then signs in by a
  // second link B: the user is verified, so B claims nothing. Then A throws
  // in its chunks. Before ruling 38, A's undo put back the flip first. The
  // guarded entries then put back the claimant's password beside the owner's
  // proved session. Now the claim is final at its flip.
  const AFTER_FLIP: [string, "before" | "after", RegExp][] = [
    ["the first statement after the flip throws before it runs", "before", /./],
    ["the session delete throws before it runs", "before", SESSION_DELETE],
    ["the session delete runs and loses its answer", "after", SESSION_DELETE],
  ];
  for (const [name, mode, target] of AFTER_FLIP)
    it(`${name}: the user stays verified, the password stays gone, and each claimant session answers 401`, async () => {
      // The claimant: a sign-up and a sign-in, so one password and two unproved sessions.
      const first = await claimant();
      current = new Date(current.getTime() + 1);
      const second = await call(
        make(),
        post("/password/sign-in", { email: EMAIL, password: PASSWORD }),
      );
      expect(await answer(second)).toBe("200 ok");
      const claimantSessions = [first, cookieOf(second)];
      current = new Date(current.getTime() + 1000);
      // Two links of the owner: A first, then B.
      expect((await call(make(), post("/magic-link/request", { email: EMAIL }))).status).toBe(200);
      const tokenA = linkToken();
      expect((await call(make(), post("/magic-link/request", { email: EMAIL }))).status).toBe(200);
      const tokenB = linkToken();
      expect(tokenB).not.toBe(tokenA);
      // A pauses after its flip ran, then throws once at the target statement.
      let flipped = false;
      let thrown = 0;
      let resume = () => {};
      const go = new Promise<void>((r) => {
        resume = r;
      });
      let paused = () => {};
      const atPause = new Promise<void>((r) => {
        paused = r;
      });
      const hit = (sql: string) => flipped && thrown === 0 && target.test(sql);
      const view = viewOf(
        env.DB,
        async (sql) => {
          if (mode === "before" && hit(sql)) {
            thrown++;
            throw new Error("D1_ERROR: the statement failed before it ran.");
          }
        },
        async (sql) => {
          if (mode === "after" && hit(sql)) {
            thrown++;
            throw new Error(LOST);
          }
          if (!flipped && FLIP.test(sql)) {
            flipped = true;
            paused();
            await go;
          }
        },
      );
      const claimA = call(make(view), post("/magic-link/verify", { token: tokenA }));
      await atPause;
      expect(await rows()).toMatchObject({ verified: true, passwords: 0 });
      // B in A's gap: the user is verified, so B signs in with a proved session.
      const resB = await call(make(), post("/magic-link/verify", { token: tokenB }));
      expect(await answer(resB)).toBe("200 ok");
      const owner = cookieOf(resB);
      resume();
      expect(await answer(await claimA)).toBe("500 internal");
      expect(thrown).toBe(1);
      // The claim stands: verified, and no password of the claimant came back.
      expect(await rows()).toMatchObject({ verified: true, passwords: 0, leases: 1 });
      expect(await claimantSignIn()).toBe("401 invalid_credentials");
      // Each claimant session answers 401: the door ends it, or the chunk did.
      for (const c of claimantSessions)
        expect(await answer(await call(make(), getWith("/session", c)))).toBe("401 unauthorized");
      // A lost answer of the session delete leaves that delete in place. It
      // ended B's session too, as a claim that ends does. Else B's session lives.
      expect(await answer(await call(make(), getWith("/session", owner)))).toBe(
        mode === "after" ? "401 unauthorized" : "200 ok",
      );
      expect((await sessions()).map((s) => s.proved)).toEqual(mode === "after" ? [] : [1]);
      // The owner's next link signs in, and the claimant still has no way in.
      expect(await ownerLink()).toBe("200 ok");
      expect(await rows()).toMatchObject({ verified: true, passwords: 0 });
      expect(await claimantSignIn()).toBe("401 invalid_credentials");
    });
});
