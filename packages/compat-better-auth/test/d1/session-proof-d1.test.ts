import { applyD1Migrations, env } from "cloudflare:test";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { SoftAuthenticator } from "@authtempo/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { execD1 } from "./schema.js";

// The session proof on the D1 storage of the Better Auth tables (plan 12p
// Task 3). That storage has no isolation, as the core D1 adapter has none.
// So a claimant's session is still there between the claim's flip and its
// session delete, and the user reads as verified there. The door of a
// claimed session refuses that session and ends it (ruling 13 of plan 12q).
//
// First, the token and the change of address at the flip. Each scene runs
// twice from empty tables: the claim alone, then the claim with the
// claimant's requests right after the flip. Every table must be as the
// control left it.
//
// Then the guard of the passkey sign-in (Task 2 open point 4). Core gives
// an unverified user no passkey. Better Auth's passkey plugin needs only a
// session, so a Better Auth store can hold a passkey of an unverified user
// from before the move. The test writes that row as Better Auth writes it.

await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
// D1 Free allows 50 queries per invocation (D1 limits page updated 21
// April 2026, read 2026-10-24).
const BUDGET = 50;
const CLAIMED = "ada@example.com";
const OLD = "correct horse battery";
const COOKIE = "__Host-tempo_session";
const RP = { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] };
const RAW = Symbol("raw");
const SQL = Symbol("sql");
/** The flip of a claim on the Better Auth user table. The undo of a flip sets each value by a CASE form. */
const FLIP = /^UPDATE "user" SET "emailVerified" = \?/;
const INSERT_SESSION = /^INSERT INTO "session"/;

type Watch = (sql: string) => Promise<void>;

/**
 * A view of `db` that counts each statement, and each statement of a batch.
 * The statement past the budget throws, as D1 Free does. `before` runs
 * before each statement is sent, and `after` runs after it answers.
 */
function counting(db: D1Database, after?: Watch, before?: Watch) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (count.queries + n > BUDGET)
      throw new Error("Too many API requests by single worker invocation.");
    count.queries += n;
  };
  const around = async <T>(texts: string[], send: () => Promise<T>): Promise<T> => {
    for (const text of texts) await before?.(text);
    const done = await send();
    for (const text of texts) await after?.(text);
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
            return around([sql], () =>
              (target[key] as (...a: unknown[]) => Promise<unknown>).apply(target, args),
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
          return around(
            statements.map((s) => String((s as unknown as Record<symbol, string>)[SQL] ?? "")),
            () =>
              target.batch(
                statements.map(
                  (s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s,
                ),
              ),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted as D1Database, count };
}

const mail: MailMessage[] = [];
/** Each session end that the hook saw, as `reason:id`. */
const endings: string[] = [];

/** One invocation: core on the Better Auth tables, over the counted view or the binding. */
function make(opts: { counted: boolean; hook: boolean; after?: Watch; before?: Watch }) {
  const { db, count } = opts.counted
    ? counting(env.DB, opts.after, opts.before)
    : { db: env.DB, count: { queries: 0 } };
  const config: AuthConfig = {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: betterAuthSchemaStorage({ dialect: "d1", db }).storage,
    limiter: { allow: async () => true },
    mail: { send: async (m) => void mail.push(m) },
    password: {
      hash: createPbkdf2PasswordHash({ iterations: 1000 }),
      uniformSignUp: false,
      requireVerified: false,
    },
    passkey: RP,
    hooks: opts.hook
      ? { session: { afterEnd: (e) => void endings.push(`${e.reason}:${e.session.id}`) } }
      : {},
  };
  return { auth: createAuth(config), count };
}
type World = ReturnType<typeof make>;

let ip = 0;
const post = (path: string, body: unknown, token: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** The queries of one request, from a count of zero, with the work after the answer. */
async function measure(w: World, request: Request) {
  w.count.queries = 0;
  const after: Promise<unknown>[] = [];
  const res = await w.auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return { res, queries: w.count.queries };
}
const call = async (w: World, request: Request) => (await measure(w, request)).res;

/** The status and the error code of an answer: "200 ok", "401 unauthorized". */
async function answer(res: Response): Promise<string> {
  const body = (await res.clone().json()) as { error?: string };
  return `${res.status} ${body.error ?? "ok"}`;
}
const tokenIn = (text: string) =>
  decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
const lastTo = (email: string) => mail.findLast((m) => m.to === email)?.text ?? "";
function tokenOf(res: Response): string | null {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
  const token = line?.slice(COOKIE.length + 1).split(";")[0] ?? "";
  return token === "" ? null : token;
}

/** The tables of the rows of the app: not those of D1 and SQLite, and not `ta_meta`, which holds the versions. */
async function tables(): Promise<string[]> {
  return (
    await env.DB.prepare(
      "SELECT name AS v FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('d1_migrations', 'ta_meta') ORDER BY name",
    ).all<{ v: string }>()
  ).results.map((r) => r.v);
}

/** Empty tables, and no mail or hook record. The foreign keys wait for the end of the batch. */
async function clear() {
  const names = await tables();
  await env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = on"),
    ...names.map((t) => env.DB.prepare(`DELETE FROM "${t}"`)),
  ]);
  mail.length = 0;
  endings.length = 0;
}
beforeEach(clear);

/** Every table after a scene: the count of rows of each, and the purpose of each verification row. */
async function everyTable() {
  const counts: Record<string, number> = {};
  for (const t of await tables())
    counts[t] = Number(await env.DB.prepare(`SELECT count(*) AS n FROM "${t}"`).first("n"));
  const purposes = (
    await env.DB.prepare('SELECT "taPurpose" AS v FROM "verification" ORDER BY "taPurpose"').all<{
      v: string;
    }>()
  ).results.map((r) => r.v);
  return { counts, purposes };
}

async function userOf(email: string) {
  const row = await env.DB.prepare(
    'SELECT "id", "emailVerified" AS v FROM "user" WHERE "email" = ?',
  )
    .bind(email)
    .first<{ id: string; v: number }>();
  if (!row) throw new Error(`no user at ${email}`);
  return row;
}
const sessionsOf = async (id: string) =>
  (
    await env.DB.prepare(
      'SELECT "id", "taProved" AS proved FROM "session" WHERE "userId" = ? ORDER BY "id"',
    )
      .bind(id)
      .all<{ id: string; proved: number }>()
  ).results;

/** The claimant: a password sign-up of the owner's address and a sign-in, with 2 sessions. */
async function claimant(w: World) {
  const up = await call(w, post("/password/sign-up", { email: CLAIMED, password: OLD }));
  expect(await answer(up)).toBe("200 ok");
  const first = (await sessionsOf((await userOf(CLAIMED)).id)).map((s) => s.id);
  const signIn = await call(w, post("/password/sign-in", { email: CLAIMED, password: OLD }));
  expect(await answer(signIn)).toBe("200 ok");
  const { id } = await userOf(CLAIMED);
  const sessions = (await sessionsOf(id)).map((s) => s.id);
  expect(sessions).toHaveLength(2);
  const token = tokenOf(signIn);
  if (!token) throw new Error("the sign-in set no session cookie");
  // The sign-in's session acts.
  const actor = sessions.find((s) => !first.includes(s)) ?? "";
  return { id, sessions, actor, token };
}

/** The owner's magic link of the claimed address, mailed now: the request of its verify. */
async function ownerLink(w: World): Promise<Request> {
  expect((await call(w, post("/magic-link/request", { email: CLAIMED }))).status).toBe(200);
  return post("/magic-link/verify", { token: tokenIn(lastTo(CLAIMED)) });
}

/** One run from empty tables. With `fire`, the claimant's requests run once, right after the flip. */
async function run(hook: boolean, fire: boolean) {
  await clear();
  const other = make({ counted: false, hook });
  const c = await claimant(other);
  const verify = await ownerLink(other);
  let answers: Record<string, string> | null = null;
  let window: { verified: number; sessions: { id: string; proved: number }[] } | null = null;
  const owner = make({
    counted: true,
    hook,
    after: async (sql) => {
      if (!fire || answers !== null || !FLIP.test(sql)) return;
      answers = {};
      window = { verified: (await userOf(CLAIMED)).v, sessions: await sessionsOf(c.id) };
      answers.token = await answer(await call(other, post("/tokens", { name: "kept" }, c.token)));
      answers.change = await answer(
        await call(
          other,
          post("/user/change-email", { newEmail: "mallory@evil.example" }, c.token),
        ),
      );
    },
  });
  const proved = await measure(owner, verify);
  return {
    owner: await answer(proved.res),
    queries: proved.queries,
    claimant: c,
    answers,
    window,
    sessions: (await sessionsOf(c.id)).map((s) => ({
      claimant: c.sessions.includes(s.id),
      proved: s.proved,
    })),
    endings: [...endings].sort(),
    tables: await everyTable(),
  };
}

describe("a claimant's session at the claim's flip on the D1 storage of the Better Auth tables (plan 12p)", () => {
  for (const hook of [true, false])
    it(`refuses the API token create and the change of address, and leaves no row of them (afterEnd hook ${hook})`, async () => {
      const control = await run(hook, false);
      const raced = await run(hook, true);
      expect(control.answers).toBeNull();
      // First the actions: their refusals, and every table as the claim alone left it.
      // The first request meets the door, which ends the session; the second finds none.
      expect(raced.answers).toEqual({
        token: "401 unauthorized",
        change: "401 unauthorized",
      });
      expect(raced.tables).toEqual(control.tables);
      expect(mail.filter((m) => m.to === "mallory@evil.example")).toEqual([]);
      expect(raced.window).toEqual({
        verified: 1,
        sessions: raced.claimant.sessions
          .slice()
          .sort()
          .map((id) => ({ id, proved: 0 })),
      });
      for (const r of [control, raced]) {
        expect(r.owner).toBe("200 ok");
        expect(r.queries).toBeLessThanOrEqual(BUDGET);
        // The owner holds one proved session, and no claimant session stays.
        expect(r.sessions).toEqual([{ claimant: false, proved: 1 }]);
      }
      // The claim ends each claimant session with the reason claim. In the raced
      // run the door ended the session that acted, with the reason claimed.
      expect(control.endings).toEqual(
        hook ? control.claimant.sessions.map((id) => `claim:${id}`).sort() : [],
      );
      expect(raced.endings).toEqual(
        hook
          ? raced.claimant.sessions
              .map((id) => (id === raced.claimant.actor ? `claimed:${id}` : `claim:${id}`))
              .sort()
          : [],
      );
    });
});

/**
 * A passkey of the claimant's unverified user, as Better Auth's passkey
 * plugin writes it before the move: its own columns only. The compat
 * columns take their defaults. The key is that of `soft`.
 */
async function betterAuthPasskey(soft: SoftAuthenticator, userId: string): Promise<void> {
  // The COSE key ends the attestation object: authData is its last value, and the key ends authData.
  const att = fromBase64Url((await soft.register("Y2hhbGxlbmdl")).response.attestationObject);
  const rpHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP.rpID)),
  );
  const at = indexOf(att, rpHash);
  expect(at).toBeGreaterThan(0);
  const idLength = fromBase64Url(soft.credentialId).length;
  const cose = att.slice(at + 32 + 1 + 4 + 16 + 2 + idLength);
  await env.DB.prepare(
    'INSERT INTO "passkey" ("id","name","publicKey","userId","credentialID","counter","deviceType","backedUp","transports","createdAt","aaguid") VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, NULL)',
  )
    .bind(
      "pk-better-auth",
      "Laptop",
      btoa(String.fromCharCode(...cose)),
      userId,
      soft.credentialId,
      "singleDevice",
      "internal",
      new Date(Date.now() - 3_600_000).toISOString(),
    )
    .run();
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}
function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** The request of a passkey sign-in with `soft`: the options, then the verify. */
async function passkeySignIn(w: World, soft: SoftAuthenticator): Promise<Request> {
  const options = await call(w, post("/passkey/authenticate/options", {}));
  expect(options.status).toBe(200);
  const { challenge } = (await options.json()) as { challenge: string };
  return post("/passkey/authenticate/verify", { response: await soft.authenticate(challenge) });
}

describe("the guard of the passkey sign-in on the D1 storage of the Better Auth tables (plan 12p decision 6)", () => {
  it("signs in with the Better Auth passkey of an unverified user, and the session is unproved", async () => {
    const other = make({ counted: false, hook: false });
    const up = await call(other, post("/password/sign-up", { email: CLAIMED, password: OLD }));
    expect(await answer(up)).toBe("200 ok");
    const { id } = await userOf(CLAIMED);
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    await betterAuthPasskey(soft, id);
    const signedIn = await call(other, await passkeySignIn(other, soft));
    expect(await answer(signedIn)).toBe("200 ok");
    // The address is not verified, so the session is unproved and makes no token.
    const token = tokenOf(signedIn);
    expect((await sessionsOf(id)).map((s) => s.proved)).toEqual([0, 0]);
    expect(await answer(await call(other, post("/tokens", { name: "ci" }, token)))).toBe(
      "403 email_unverified",
    );
  });

  for (const hook of [true, false])
    it(`undoes the session of a passkey sign-in that read its passkey before the claim and inserts after it (afterEnd hook ${hook})`, async () => {
      const other = make({ counted: false, hook });
      const c = await claimant(other);
      const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
      await betterAuthPasskey(soft, c.id);
      const verify = await ownerLink(other);
      const request = await passkeySignIn(other, soft);
      let claimed: string | null = null;
      const signer = make({
        counted: true,
        hook,
        // The whole claim lands after the assertion's passkey read and before the session insert.
        before: async (sql) => {
          if (claimed !== null || !INSERT_SESSION.test(sql)) return;
          claimed = "";
          claimed = await answer(await call(other, verify));
        },
      });
      const signedIn = await measure(signer, request);
      expect(claimed).toBe("200 ok");
      expect(await answer(signedIn.res)).toBe("400 passkey_failed");
      expect(tokenOf(signedIn.res)).toBeNull();
      expect(signedIn.queries).toBeLessThanOrEqual(BUDGET);
      // The claim deleted the passkey and the claimant's sessions. The guard deleted its own session.
      expect(await userOf(CLAIMED)).toMatchObject({ v: 1 });
      expect(Number(await env.DB.prepare('SELECT count(*) AS n FROM "passkey"').first("n"))).toBe(
        0,
      );
      expect((await sessionsOf(c.id)).map((s) => s.proved)).toEqual([1]);
      expect([...endings].sort()).toEqual(hook ? c.sessions.map((s) => `claim:${s}`).sort() : []);
    });
});
