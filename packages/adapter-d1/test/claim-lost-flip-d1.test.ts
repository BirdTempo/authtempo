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
// - U2: the session delete runs, and then its answer is lost. The undo
//   restores the flip, so the rows come back as one piece.
// - U3 (probe U2 of rr-fix6): the session delete throws before it runs, and
//   the undo's restore of the flip throws too.

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
    hooks: { session: { afterEnd: () => {} } },
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
    // That session came before the proof, so it is not proved: no verified-only act.
    expect(await tokenWith(session)).toBe("403 email_unverified");
    // The owner signs in with a new link. The user is verified, so no claim runs.
    expect(await ownerLink()).toBe("200 ok");
    expect(await rows()).toMatchObject({ verified: true, passwords: 0 });
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
  });

  it("U2: a session delete that ran and lost its answer undoes the flip first, so the claimant's rows come back as one piece", async () => {
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
    // The session delete stands. The undo restored the flip, and then the
    // guarded entries found the user unverified, so the password is back.
    expect(await rows()).toEqual({ verified: false, passwords: 1, sessions: 0, leases: 0 });
    expect(await claimantSignIn()).toBe("200 ok");
    // The owner's next link claims.
    expect(await ownerLink()).toBe("200 ok");
    expect(await rows()).toMatchObject({ verified: true, passwords: 0 });
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
  });

  it("U3: a session delete that throws, then a restore of the flip that throws, leaves the user verified with no row of the claimant", async () => {
    const session = await claimant();
    let thrown = 0;
    let flipped = false;
    const view = viewOf(
      env.DB,
      async (sql) => {
        if (FLIP.test(sql)) flipped = true;
        else if (flipped && thrown === 0 && SESSION_DELETE.test(sql)) {
          thrown++;
          throw new Error("D1_ERROR: the session delete failed.");
        } else if (thrown === 1 && USER_UPDATE.test(sql)) {
          thrown++;
          throw new Error("D1_ERROR: the restore of the flip failed.");
        }
      },
      async () => {},
    );
    expect(await ownerLink(view)).toBe("500 internal");
    expect(thrown).toBe(2);
    // The flip stands, so the guarded entries put back no password.
    expect(await rows()).toEqual({ verified: true, passwords: 0, sessions: 1, leases: 0 });
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
    expect(await tokenWith(session)).toBe("403 email_unverified");
    expect(await ownerLink()).toBe("200 ok");
    expect(await claimantSignIn()).toBe("401 invalid_credentials");
  });
});
