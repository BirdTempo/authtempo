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

// A mailbox proof is final (decision 12 of plan 12o). The sign-up confirm and
// a password reset of the same address race on the D1 binding. D1 does not
// isolate a transaction (src/adapter.ts), so each flow reads the writes of
// the other before its commit. These are the scenes of the 12n re-review
// probe (tools/12n/tmp/rrc/probe-reset-confirm.test.ts), and two more of
// inventory-claim 3.5 of plan 12o. The last scene is the race of ruling 26:
// two Google sign-ins by the ID-token route, for two users.
//
// Every step is a real request through `auth.handle`. The request of the
// scene runs on a view of the binding that counts each query and refuses
// query 51, as D1 Free does. A step of the other request runs in a watch
// after a statement of the scene, as a parallel invocation does between two
// queries. A `session.afterEnd` hook is set, so a claim reads its sessions
// and then ends them by `deleteRows`.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
// D1 Free allows 50 queries per invocation (D1 limits page updated 21
// April 2026, read 2026-10-24, as anonymous-upgrade-budget.test.ts says).
const BUDGET = 50;
const RAW = Symbol("raw");
const SQL = Symbol("sql");
const OLD = "correct horse battery";
const NEW = "another long password";

/** The first write of the confirm: the check of its password row. */
const PASSWORD_WRITE = /^UPDATE ta_password SET/;
/** The flip of a claim, not the undo of a flip: the undo sets each value by a CASE form. */
const FLIP = /^UPDATE ta_user SET email_verified = \?/;
/** The claim's read of the sessions, before it ends them by id. */
const SESSION_READ = /^SELECT\b[\s\S]*\bFROM ta_session WHERE user_id = \?/;
/** The read of the `email` identity, before its create (`ensureEmailIdentity`). */
const IDENTITY_READ = /^SELECT\b[\s\S]*\bFROM ta_identity WHERE provider = \? AND subject = \?/;

type Watch = (sql: string) => Promise<void>;

/**
 * A view of `db` that counts each statement, and each statement of a batch.
 * The statement past the budget throws, as D1 Free does. `watch` runs after
 * each statement.
 */
function counting(db: D1Database, watch?: Watch) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (count.queries + n > BUDGET)
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

/** The session ends that the hook saw, across the invocations of one test. */
const endings: { id: string; reason: string }[] = [];

/** One invocation: the engine on the counted view, or on the binding with no count. */
function make(counted: boolean, watch?: Watch, extra: Partial<AuthConfig> = {}) {
  const { db, count } = counted ? counting(env.DB, watch) : { db: env.DB, count: { queries: 0 } };
  const mail: MailMessage[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async (m) => void mail.push(m) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    hooks: {
      session: { afterEnd: ({ session, reason }) => void endings.push({ id: session.id, reason }) },
    },
    ...extra,
  });
  return { auth, count, mail };
}
type World = ReturnType<typeof make>;

/** The queries of one request, from a count of zero, with the work after the answer. */
async function measure(w: World, request: Request) {
  w.count.queries = 0;
  const after: Promise<unknown>[] = [];
  const res = await w.auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return { res, queries: w.count.queries };
}
const call = async (w: World, request: Request) => (await measure(w, request)).res;

let ip = 0;
const post = (path: string, body: unknown, token: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      ...(token ? { cookie: `__Host-tempo_session=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const tokenIn = (text: string) =>
  decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
function setToken(res: Response): string | null {
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
  return line?.slice("__Host-tempo_session=".length).split(";")[0] || null;
}
const answer = async (res: Response) =>
  `${res.status} ${((await res.clone().json()) as { error?: string }).error ?? "ok"}`;
/** The newest confirm link to `email` in `mail`. */
const confirmLink = (mail: MailMessage[], email: string) =>
  tokenIn(mail.findLast((m) => m.to === email && m.subject.startsWith("Confirm"))?.text ?? "");

/** The rows of the address that the scenes check, read on the binding. */
async function state(email: string) {
  const user = await env.DB.prepare("SELECT id, email_verified AS v FROM ta_user WHERE email = ?")
    .bind(email)
    .first<{ id: string; v: number }>();
  const id = user?.id ?? "";
  const ids = async (sql: string) =>
    (await env.DB.prepare(sql).bind(id).all<{ id: string }>()).results.map((r) => r.id);
  const hashes = await env.DB.prepare("SELECT hash FROM ta_password WHERE user_id = ?")
    .bind(id)
    .all<{ hash: string }>();
  return {
    verified: user?.v === 1,
    hashes: hashes.results.map((r) => r.hash),
    sessions: await ids("SELECT id FROM ta_session WHERE user_id = ? ORDER BY id"),
    emailIdentities: (
      await ids("SELECT id FROM ta_identity WHERE user_id = ? AND provider = 'email'")
    ).length,
  };
}

/**
 * The claimant: a sign-up of the address and a sign-in, so the unverified
 * user holds a password row and two sessions. Answers the confirm link and
 * the two session ids.
 */
async function claimant(other: World, email: string) {
  expect(await answer(await call(other, post("/password/sign-up", { email, password: OLD })))).toBe(
    "200 ok",
  );
  expect(await answer(await call(other, post("/password/sign-in", { email, password: OLD })))).toBe(
    "200 ok",
  );
  const before = await state(email);
  expect(before.verified).toBe(false);
  expect(before.sessions).toHaveLength(2);
  return { link: confirmLink(other.mail, email), sessions: before.sessions, before };
}

/** A password reset of the address by its owner: the request, then the reset. */
async function resetBy(other: World, email: string) {
  expect(await answer(await call(other, post("/password/reset/request", { email })))).toBe(
    "200 ok",
  );
  const text = other.mail.findLast((m) => m.to === email)?.text ?? "";
  const done = await call(other, post("/password/reset", { token: tokenIn(text), password: NEW }));
  return { done: await answer(done), token: setToken(done) };
}

/** Google with the ID-token route. The seam answers `claims`: the key set is not this test's subject. */
function googleSeam() {
  const claims: { current: Record<string, unknown> } = { current: {} };
  const extra: Partial<AuthConfig> = {
    social: { google: { clientId: "gid", clientSecret: "gsecret" } },
    jwt: { verifyIdToken: async () => claims.current, signES256: async () => "es256" },
  };
  return { claims, extra };
}

let tokens = 0;
/**
 * The ID-token sign-in of the Google account `sub` with the address `email`.
 * The nonce comes from `w`. The claims go to the seam of the world that
 * takes the request.
 */
async function idTokenRequest(
  w: World,
  seam: ReturnType<typeof googleSeam>,
  sub: string,
  email: string,
) {
  const nr = await call(w, post("/social/google/id-token/nonce", {}));
  const { nonce, providerNonce } = (await nr.json()) as { nonce: string; providerNonce: string };
  const iat = Math.floor(Date.now() / 1000);
  // The provider gets the SHA-256 hex of the nonce, as id-token-budget.test.ts says.
  seam.claims.current = {
    iss: "https://accounts.google.com",
    aud: "gid",
    sub,
    email,
    email_verified: true,
    nonce: providerNonce,
    iat,
    exp: iat + 3600,
  };
  // Each token text has its own payload part, so each is a new token to the used-token row.
  const idToken = `h.${btoa(JSON.stringify({ n: ++tokens })).replace(/=+$/, "")}.s`;
  return post("/social/google/id-token", { idToken, nonce });
}

/** The end of every scene: a verified user, the reset's hash, one `email` identity, and no claimant session. */
async function expectFinal(other: World, email: string, claimantSessions: string[]) {
  const end = await state(email);
  expect(end.verified).toBe(true);
  expect(end.hashes).toHaveLength(1);
  expect(end.emailIdentities).toBe(1);
  expect(end.sessions.filter((id) => claimantSessions.includes(id))).toEqual([]);
  // The reset's hash signs in, and the claimant's password does not.
  expect(await answer(await call(other, post("/password/sign-in", { email, password: NEW })))).toBe(
    "200 ok",
  );
  expect(await answer(await call(other, post("/password/sign-in", { email, password: OLD })))).toBe(
    "401 invalid_credentials",
  );
  return end;
}

// The counts of the run of 2026-11-04 on the D1 binding of this pool, with
// the D1 limiter on the same view. Each is the request of the scene: the
// confirm, or the reset in the mirror. After ruling 23 of plan 12o, scene A
// sends no mail (17 before), and the identity race signs in (22 before, with
// the answer 500). `other` is the Google sign-in of the race of ruling 26.
// Update 2026-11-04 by plan 12p: each claim that runs writes the lease (+1).
// Scene A loses its claim and writes nothing. Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
// Update 2026-11-05 by plan 12q: a scene that signs in opens a session, and
// its cap read adds one query (+1). Scene A and `other` open none. Measured
// 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
const PINS = { a: 14, b: 25, c: 25, identity: 27, mirror: 39, other: 24 };

describe("a mailbox proof is final on D1 (decision 12 of plan 12o)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("DELETE FROM ta_limit").run();
    endings.length = 0;
  });

  it("scene A: the reset claims between the confirm's password write and its flip; the confirm answers 409 with a detail that says to sign in, mails nothing, and the same link is spent", async () => {
    const email = "eve@example.com";
    const other = make(false);
    const c = await claimant(other, email);
    let stage: "idle" | "armed" | "fired" = "idle";
    let reset = "";
    const w = make(true, async (sql) => {
      if (stage !== "armed" || !PASSWORD_WRITE.test(sql)) return;
      stage = "fired";
      reset = (await resetBy(other, email)).done;
    });
    stage = "armed";
    const v = await measure(w, post("/password/verify", { token: c.link }));
    expect(stage).toBe("fired");
    expect(reset).toBe("200 ok");
    // The reset claimed first, so the flip of the confirm matched no row.
    expect(await answer(v.res)).toBe("409 conflict");
    expect(setToken(v.res)).toBeNull();
    // The address is verified, so the answer says to sign in and no new
    // link goes (ruling 23 of plan 12o).
    expect(((await v.res.clone().json()) as { detail?: string }).detail).toBe(
      "Another proof verified this address first. Sign in.",
    );
    expect(confirmLink(w.mail, email)).toBe("");
    await expectFinal(other, email, c.sessions);
    // The same link again is spent.
    expect(await answer(await call(other, post("/password/verify", { token: c.link })))).toBe(
      "400 invalid_token",
    );
    expect(v.queries).toBe(PINS.a);
    expect(v.queries).toBeLessThanOrEqual(BUDGET);
  });

  it("scene B: the reset commits after the confirm's flip, then a sign-out lands between the confirm's session read and its delete; the confirm signs in", async () => {
    const email = "fay@example.com";
    const other = make(false);
    const c = await claimant(other, email);
    let stage: "idle" | "armed" | "flipped" | "raced" = "idle";
    const r: { reset: Awaited<ReturnType<typeof resetBy>> | null } = { reset: null };
    let signOut = "";
    const w = make(true, async (sql) => {
      if (stage === "armed" && FLIP.test(sql)) {
        stage = "flipped";
        // The reset reads the flip, so it takes the verified branch and ends every session.
        r.reset = await resetBy(other, email);
      } else if (stage === "flipped" && SESSION_READ.test(sql)) {
        stage = "raced";
        signOut = await answer(await call(other, post("/sign-out", {}, r.reset?.token ?? null)));
      }
    });
    stage = "armed";
    const v = await measure(w, post("/password/verify", { token: c.link }));
    expect(stage).toBe("raced");
    expect(r.reset?.done).toBe("200 ok");
    expect(signOut).toBe("200 ok");
    // The race ends no claim: the chunk's delete answers the rows it removed (decision 8).
    expect(await answer(v.res)).toBe("200 ok");
    const mine = setToken(v.res);
    expect(mine).not.toBeNull();
    const end = await expectFinal(other, email, c.sessions);
    const session = await other.auth.api.getSession(mine ?? "");
    expect(end.sessions).toContain(session?.session.id);
    expect(v.queries).toBe(PINS.b);
    expect(v.queries).toBeLessThanOrEqual(BUDGET);
  });

  it("scene C: the reset commits between the confirm's session read and its chunk delete; the confirm signs in", async () => {
    const email = "gil@example.com";
    const other = make(false);
    const c = await claimant(other, email);
    let stage: "idle" | "armed" | "flipped" | "fired" = "idle";
    const r: { reset: Awaited<ReturnType<typeof resetBy>> | null } = { reset: null };
    const w = make(true, async (sql) => {
      if (stage === "armed" && FLIP.test(sql)) stage = "flipped";
      else if (stage === "flipped" && SESSION_READ.test(sql)) {
        stage = "fired";
        r.reset = await resetBy(other, email);
      }
    });
    stage = "armed";
    const v = await measure(w, post("/password/verify", { token: c.link }));
    expect(stage).toBe("fired");
    expect(r.reset?.done).toBe("200 ok");
    // The reset ended the two claimant sessions first. The chunk's delete
    // answers none of them, so the confirm fires no second end for them.
    expect(await answer(v.res)).toBe("200 ok");
    expect(endings.filter((e) => c.sessions.includes(e.id))).toEqual(
      c.sessions.map((id) => ({ id, reason: "password_reset" })),
    );
    const mine = setToken(v.res);
    const end = await expectFinal(other, email, c.sessions);
    const session = await other.auth.api.getSession(mine ?? "");
    expect(end.sessions).toContain(session?.session.id);
    expect(v.queries).toBe(PINS.c);
    expect(v.queries).toBeLessThanOrEqual(BUDGET);
  });

  it("the identity race: the reset writes the email identity between the confirm's read of it and its create; the confirm finds the row and signs in", async () => {
    const email = "hal@example.com";
    const other = make(false);
    const c = await claimant(other, email);
    let stage: "idle" | "armed" | "flipped" | "fired" = "idle";
    const r: { reset: Awaited<ReturnType<typeof resetBy>> | null } = { reset: null };
    const w = make(true, async (sql) => {
      if (stage === "armed" && FLIP.test(sql)) stage = "flipped";
      else if (stage === "flipped" && IDENTITY_READ.test(sql)) {
        stage = "fired";
        r.reset = await resetBy(other, email);
      }
    });
    stage = "armed";
    const v = await measure(w, post("/password/verify", { token: c.link }));
    expect(stage).toBe("fired");
    expect(r.reset?.done).toBe("200 ok");
    // The create of the confirm meets the reset's row after `keep`. One read
    // finds the row of the same user. So the row counts as present, and the
    // confirm goes on to its session (ruling 23 of plan 12o).
    expect(await answer(v.res)).toBe("200 ok");
    const mine = setToken(v.res);
    expect(mine).not.toBeNull();
    expect(endings.filter((e) => c.sessions.includes(e.id))).toEqual(
      c.sessions.map((id) => ({ id, reason: "claim" })),
    );
    const end = await expectFinal(other, email, c.sessions);
    // The reset ran after the claim's last session delete, so its session stays beside the confirm's.
    const reset = await other.auth.api.getSession(r.reset?.token ?? "");
    const confirm = await other.auth.api.getSession(mine ?? "");
    expect(end.sessions).toContain(reset?.session.id);
    expect(end.sessions).toContain(confirm?.session.id);
    expect(v.queries).toBe(PINS.identity);
    expect(v.queries).toBeLessThanOrEqual(BUDGET);
  });

  it("the race of another user: a verified user links the same Google account between the claim's flip and its identity create; the claim stays, and the claimant gets no session", async () => {
    const email = "jon@example.com";
    const kim = "kim@example.com";
    const seam = { claim: googleSeam(), link: googleSeam() };
    const other = make(false, undefined, seam.link.extra);
    const c = await claimant(other, email);
    // Kim proves her own address by the link of her sign-up.
    expect(
      await answer(await call(other, post("/password/sign-up", { email: kim, password: OLD }))),
    ).toBe("200 ok");
    expect(
      await answer(
        await call(other, post("/password/verify", { token: confirmLink(other.mail, kim) })),
      ),
    ).toBe("200 ok");
    const owner = await env.DB.prepare(
      "SELECT id FROM ta_user WHERE email = ? AND email_verified = 1",
    )
      .bind(kim)
      .first<{ id: string }>();
    expect(owner).not.toBeNull();
    let stage: "idle" | "armed" | "fired" = "idle";
    let link = "";
    const w = make(
      true,
      async (sql) => {
        if (stage !== "armed" || !FLIP.test(sql)) return;
        stage = "fired";
        // The Google account g-1 now carries Kim's address, so her sign-in links it to her.
        const r = await idTokenRequest(other, seam.link, "g-1", kim);
        link = await answer(await call(other, r));
      },
      seam.claim.extra,
    );
    const request = await idTokenRequest(other, seam.claim, "g-1", email);
    stage = "armed";
    const v = await measure(w, request);
    expect(stage).toBe("fired");
    expect(link).toBe("200 ok");
    // The create of the claim meets Kim's row after `keep`. A row of another
    // user does not count as present (ruling 26 of plan 12o). So the error
    // passes on, and the flow opens no session.
    expect(await answer(v.res)).toBe("500 internal");
    expect(setToken(v.res)).toBeNull();
    const end = await state(email);
    expect(end.verified).toBe(true);
    expect(end.sessions).toEqual([]);
    expect(endings.filter((e) => c.sessions.includes(e.id))).toEqual(
      c.sessions.map((id) => ({ id, reason: "claim" })),
    );
    const google = await env.DB.prepare(
      "SELECT user_id FROM ta_identity WHERE provider = 'google'",
    ).all<{ user_id: string }>();
    expect(google.results.map((r) => r.user_id)).toEqual([owner?.id]);
    expect(v.queries).toBe(PINS.other);
    expect(v.queries).toBeLessThanOrEqual(BUDGET);
  });

  it("the mirror: the reset flips, the confirm reads the flip, and a sign-out lands between the reset's session read and its delete; the reset signs in", async () => {
    const email = "ivy@example.com";
    const other = make(false);
    const c = await claimant(other, email);
    // The reset is the request of this scene, so its link comes first.
    expect(await answer(await call(other, post("/password/reset/request", { email })))).toBe(
      "200 ok",
    );
    const link = tokenIn(other.mail.findLast((m) => m.to === email)?.text ?? "");
    // One more sign-in of the claimant, for the sign-out of a claimant session.
    const claimantToken = setToken(
      await call(other, post("/password/sign-in", { email, password: OLD })),
    );
    const sessions = (await state(email)).sessions;
    expect(sessions).toHaveLength(3);
    let stage: "idle" | "armed" | "flipped" | "raced" = "idle";
    let confirm = "";
    let signOut = "";
    const w = make(true, async (sql) => {
      if (stage === "armed" && FLIP.test(sql)) {
        stage = "flipped";
        // The confirm reads the flip: a verified user gets no session.
        confirm = await answer(await call(other, post("/password/verify", { token: c.link })));
      } else if (stage === "flipped" && SESSION_READ.test(sql)) {
        stage = "raced";
        signOut = await answer(await call(other, post("/sign-out", {}, claimantToken)));
      }
    });
    stage = "armed";
    const r = await measure(w, post("/password/reset", { token: link, password: NEW }));
    expect(stage).toBe("raced");
    expect(confirm).toBe("200 ok");
    expect(signOut).toBe("200 ok");
    expect(await answer(r.res)).toBe("200 ok");
    expect(setToken(r.res)).not.toBeNull();
    await expectFinal(other, email, sessions);
    expect(r.queries).toBe(PINS.mirror);
    expect(r.queries).toBeLessThanOrEqual(BUDGET);
  });
});
