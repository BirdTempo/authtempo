import { describe, expect, it } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { requireOperatorUser } from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { addMember } from "../src/engine/organizations.js";
import { openSession, resolveSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, makeAuth, post } from "./helpers.js";
import { authorized, exchange, pkce, REDIRECT, RESOURCE, SCOPES } from "./oauth-helpers.js";
import { OPERATOR_SECRETS, operatorFixture, sessionOf } from "./operator-helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";
import { enrolled, PASSWORD } from "./totp-helpers.js";

const APP = { kind: "app", name: "support-tool" } as const;
const SESSIONS = { kind: "secret", name: "support", scopes: ["sessions"] } as const;
const USERS_ONLY = { kind: "secret", name: "support", scopes: ["users", "audit"] } as const;
const BACKCHANNEL = "https://client.example.com/backchannel";
/** The sign-up limit is 10 per IP per hour: a gap of 7 minutes keeps a run of sign-ups under it. */
const SIGN_UP_GAP_MS = 7 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The HTTP view and the engine view of one config input on one storage,
 * clock, and limiter. The config has password sign-in, the OAuth provider
 * with a recorder as `oauth.fetch`, and the operator tools. `hook: true` sets
 * `session.afterEnd`, which records each end as `<session id>:<reason>`.
 * `users: false` turns the operator tools off.
 */
async function world(options: { hook?: boolean; users?: boolean } = {}) {
  const base = makeAuth();
  const ended: string[] = [];
  const sent: string[] = [];
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: {
      send: async (m) => {
        base.mail.push(m);
      },
    },
    clock: base.clock,
    limiter: createMemoryLimiter(base.clock),
    password: { hash: FAST, uniformSignUp: false },
    oauth: {
      resources: [RESOURCE],
      scopes: SCOPES,
      registration: { cimd: false, dynamic: true },
      fetch: (async (url: string | URL | Request) => {
        sent.push(String(url));
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    },
    operator: {
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(OPERATOR_SECRETS.support),
          scopes: ["users", "sessions", "audit"],
        },
      ],
      // The key is true or absent: absent turns the tools off.
      ...(options.users === false ? {} : { users: true as const }),
    },
    ...(options.hook
      ? {
          hooks: {
            session: {
              afterEnd: ({ session, reason }) => {
                ended.push(`${session.id}:${reason}`);
              },
            },
          },
        }
      : {}),
  };
  const config = resolveConfig(input);
  return {
    auth: createAuth(input),
    config,
    engine: { ...base, config },
    storage: base.storage,
    clock: base.clock,
    ended,
    sent,
    api: operatorApi(config),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/**
 * A user with `count` sessions: the session of the sign-up, then sign-ins
 * through `openSession`, the one way every flow opens a session.
 */
async function userWith(w: World, email: string, count: number): Promise<UserRow> {
  w.clock.advance(SIGN_UP_GAP_MS);
  await signUpAndVerify(w.engine, email, PASSWORD);
  const user = await w.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error("no user");
  for (let i = 1; i < count; i++)
    await openSession(w.config, { user, ip: null, userAgent: null, via: "password" });
  return user;
}

const sessionsOf = (storage: StorageAdapter, userId?: string) =>
  storage.findMany(
    "session",
    userId === undefined ? [] : [{ field: "userId", op: "eq", value: userId }],
  );

const auditRows = (storage: StorageAdapter) =>
  storage.findMany("operatorAudit", [], { sort: { field: "id", dir: "asc" } });

/**
 * Counts each storage call on `storage`, also inside a transaction, and
 * the session rows that each read answers. `log` holds each call as
 * `<method>:<model>`. The memory adapter gives a
 * transaction its own adapter object, so no call counts twice. An update
 * inside a transaction counts 2, as on D1: the D1 adapter sends the prior
 * read and the write as one batch of two statements.
 */
function countCalls(storage: StorageAdapter) {
  const counts = { calls: 0, sessionRowsRead: 0, log: [] as string[] };
  const wrap = (target: StorageAdapter, inTransaction = false): StorageAdapter => ({
    ...target,
    create: ((model, data) => {
      counts.calls++;
      counts.log.push(`create:${model}`);
      return target.create(model, data);
    }) as StorageAdapter["create"],
    findOne: ((model, where) => {
      counts.calls++;
      counts.log.push(`findOne:${model}`);
      return target.findOne(model, where);
    }) as StorageAdapter["findOne"],
    findMany: (async (model, where, opts) => {
      counts.calls++;
      counts.log.push(`findMany:${model}`);
      const rows = await target.findMany(model, where, opts);
      if (model === "session") counts.sessionRowsRead += rows.length;
      return rows;
    }) as StorageAdapter["findMany"],
    update: ((model, where, data) => {
      counts.calls += inTransaction ? 2 : 1;
      counts.log.push(`update:${model}`);
      return target.update(model, where, data);
    }) as StorageAdapter["update"],
    delete: ((model, where) => {
      counts.calls++;
      counts.log.push(`delete:${model}`);
      return target.delete(model, where);
    }) as StorageAdapter["delete"],
  });
  // The bound methods of the store before the patch, so a patched method never calls itself.
  const plain = wrap({
    ...storage,
    create: storage.create.bind(storage),
    findOne: storage.findOne.bind(storage),
    findMany: storage.findMany.bind(storage),
    update: storage.update.bind(storage),
    delete: storage.delete.bind(storage),
  });
  const transaction = storage.transaction.bind(storage);
  storage.create = plain.create;
  storage.findOne = plain.findOne;
  storage.findMany = plain.findMany;
  storage.update = plain.update;
  storage.delete = plain.delete;
  storage.transaction = ((fn) =>
    transaction((tx) => fn(wrap(tx, true)))) as StorageAdapter["transaction"];
  return counts;
}

/**
 * Runs the sweep until no client link and no outbox row stays, 10 times at
 * most. Each sweep makes the logouts of the links with no session, and
 * sends the due rows. Answers the count of sweeps.
 */
async function sweepAll(w: World): Promise<number> {
  for (let n = 1; n <= 10; n++) {
    w.clock.advance(1);
    await sweepExpired(w.config);
    const links = await w.storage.findMany("oauthSessionClient", []);
    const outbox = await w.storage.findMany("oauthLogout", []);
    if (links.length === 0 && outbox.length === 0) return n;
  }
  throw new Error("links or outbox rows stay after 10 sweeps");
}

/** A client of the register route with a back-channel logout URI. */
async function backchannelClient(w: World): Promise<string> {
  const res = await w.auth.handle(
    post("/auth/oauth/register", {
      redirect_uris: [REDIRECT],
      backchannel_logout_uri: BACKCHANNEL,
    }),
  );
  if (res.status !== 201) throw new Error(`register answered ${res.status}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** An ID token and a refresh token for the session of `token`: the token step links the session to the client. */
async function linked(w: World, token: string, clientId: string): Promise<void> {
  const p = await pkce();
  const { code } = await authorized(w, `__Host-tempo_session=${token}`, {
    clientId,
    challenge: p.challenge,
    scope: "openid mcp:read offline_access",
    nonce: "n-1",
  });
  const res = await w.auth.handle(exchange(code, clientId, p.verifier));
  if (res.status !== 200) throw new Error(`token answered ${res.status}`);
  const body = (await res.json()) as { id_token?: string; refresh_token?: string };
  if (!body.id_token || !body.refresh_token) throw new Error("no id_token or refresh_token");
}

describe("the end of sessions by an operator (plan 12f Task 7)", () => {
  it("deletes an expired session of one user with no operator event", async () => {
    const w = await world({ hook: true });
    const user = await userWith(w, "ada@example.com", 1);
    // One hour before the old row expires, a new sign-in; two hours later only the new row is live.
    w.clock.advance(w.config.session.ttlDays * DAY_MS - HOUR_MS);
    const fresh = await openSession(w.config, { user, ip: null, userAgent: null, via: "password" });
    w.clock.advance(2 * HOUR_MS);
    expect(await sessionsOf(w.storage, user.id)).toHaveLength(2);
    w.ended.length = 0;
    const done = await w.api.sessions.endUser({
      actor: APP,
      userId: user.id,
      reason: "Lost laptop",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    expect(done.value.ended).toBe(1);
    expect(w.ended).toEqual([`${fresh.session.id}:operator`]);
    expect(await sessionsOf(w.storage, user.id)).toEqual([]);
  });

  it("deletes an expired session in the end of all sessions with no operator event", async () => {
    const w = await world({ hook: true });
    const user = await userWith(w, "ada@example.com", 1);
    w.clock.advance(w.config.session.ttlDays * DAY_MS - HOUR_MS);
    const fresh = await openSession(w.config, { user, ip: null, userAgent: null, via: "password" });
    w.clock.advance(2 * HOUR_MS);
    expect(await sessionsOf(w.storage, user.id)).toHaveLength(2);
    w.ended.length = 0;
    const done = await w.api.sessions.endAll({
      actor: APP,
      reason: "Key leak",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    // The count holds every deleted row; the event goes to the live row only.
    expect([done.value.ended, done.value.more]).toEqual([2, false]);
    expect(w.ended).toEqual([`${fresh.session.id}:operator`]);
    expect(await sessionsOf(w.storage)).toEqual([]);
  });

  it("ends every session of one user, and fires afterEnd with the reason operator", async () => {
    const w = await world({ hook: true });
    const user = await userWith(w, "ada@example.com", 3);
    const other = await userWith(w, "bob@example.com", 1);
    const sessions = await sessionsOf(w.storage, user.id);
    expect(sessions).toHaveLength(3);
    // The address proof of each sign-up ended a session with the reason claim.
    w.ended.length = 0;
    const done = await w.api.sessions.endUser({
      actor: APP,
      userId: user.id,
      reason: "Lost laptop",
      ip: "203.0.113.9",
      userAgent: "Support/1",
    });
    if (!done.ok) throw new Error(done.code);
    expect(done.value.ended).toBe(3);
    expect([...w.ended].sort()).toEqual(sessions.map((s) => `${s.id}:operator`).sort());
    expect(await sessionsOf(w.storage, user.id)).toEqual([]);
    expect(await sessionsOf(w.storage, other.id)).toHaveLength(1);
    const rows = await auditRows(w.storage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: done.value.auditId,
      actorKind: "app",
      actorId: "support-tool",
      action: "sessions_end_user",
      targetUserId: user.id,
      reason: "Lost laptop",
      data: { ended: 3 },
      ip: "203.0.113.9",
      userAgent: "Support/1",
    });
  });

  it("ends 1200 sessions in three calls and keeps the actor's session", async () => {
    const f = await operatorFixture();
    const api = operatorApi(f.auth.config);
    const actor = await requireOperatorUser(f.auth.config, f.operator);
    if (!actor.ok) throw new Error(actor.code);
    for (let u = 0; u < 40; u++) {
      const email = `user${u}@example.com`;
      f.auth.clock.advance(SIGN_UP_GAP_MS);
      await signUpAndVerify(f.auth, email, PASSWORD);
      const user = await f.auth.storage.findOne("user", [
        { field: "email", op: "eq", value: email },
      ]);
      if (!user) throw new Error("no user");
      // The sign-up opened the first session; 29 sign-ins make 30.
      for (let i = 1; i < 30; i++)
        await openSession(f.auth.config, { user, ip: null, userAgent: null, via: "password" });
    }
    const all = await sessionsOf(f.auth.storage);
    expect(all.filter((s) => s.id !== f.operator.session.id)).toHaveLength(1200);
    const answers: { ended: number; more: boolean }[] = [];
    for (let call = 0; call < 3; call++) {
      f.auth.clock.advance(1);
      const done = await api.sessions.endAll({
        actor: actor.value,
        reason: "Key leak",
        limit: 500,
        ip: null,
        userAgent: null,
      });
      if (!done.ok) throw new Error(done.code);
      answers.push({ ended: done.value.ended, more: done.value.more });
    }
    expect(answers).toEqual([
      { ended: 500, more: true },
      { ended: 500, more: true },
      { ended: 200, more: false },
    ]);
    expect((await sessionsOf(f.auth.storage)).map((s) => s.id)).toEqual([f.operator.session.id]);
    expect(await sessionOf(f.auth, f.operator.token)).toMatchObject({
      session: { id: f.operator.session.id },
    });
    const rows = await auditRows(f.auth.storage);
    expect(rows.map((r) => [r.action, r.actorKind, r.actorId, r.targetUserId, r.data])).toEqual([
      ["sessions_end_all", "user", f.operator.user.id, null, { ended: 500 }],
      ["sessions_end_all", "user", f.operator.user.id, null, { ended: 500 }],
      ["sessions_end_all", "user", f.operator.user.id, null, { ended: 200 }],
    ]);
  });

  it("holds the user row before the first delete of one user's sessions", async () => {
    const w = await world();
    const user = await userWith(w, "ada@example.com", 2);
    const counts = countCalls(w.storage);
    const done = await w.api.sessions.endUser({
      actor: APP,
      userId: user.id,
      reason: "Lost laptop",
      ip: null,
      userAgent: null,
    });
    expect(done.ok && done.value.ended).toBe(2);
    // The target read, then the hold: a read and a write of the user row (user-hold.ts).
    const first = counts.log.findIndex((c) => c.startsWith("delete:"));
    expect(counts.log.slice(0, first)).toEqual(["findOne:user", "findOne:user", "update:user"]);
  });

  it("refuses the actor's own user and a platform operator target for a user actor", async () => {
    const f = await operatorFixture();
    const api = operatorApi(f.auth.config);
    const actor = await requireOperatorUser(f.auth.config, f.operator);
    if (!actor.ok) throw new Error(actor.code);
    const other = await enrolled(f.auth, "op2@example.com");
    const added = await addMember(f.auth.config, {
      user: f.root,
      organizationId: f.platformOrg.id,
      userId: other.user.id,
      role: "operator",
    });
    if (!added.ok) throw new Error(added.code);
    const input = { reason: "Test", ip: null, userAgent: null };
    expect(
      await api.sessions.endUser({ ...input, actor: actor.value, userId: f.operator.user.id }),
    ).toEqual({ ok: false, code: "operator_self", status: 409 });
    expect(
      await api.sessions.endUser({ ...input, actor: actor.value, userId: other.user.id }),
    ).toEqual({ ok: false, code: "operator_required", status: 403 });
    expect(await api.sessions.endUser({ ...input, actor: APP, userId: "no-such-user" })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    expect(await auditRows(f.auth.storage)).toEqual([]);
    expect(await resolveSession(f.auth.config, f.operator.token)).not.toBeNull();
    expect(await resolveSession(f.auth.config, other.session.token)).not.toBeNull();
    // A secret and the app can act on a platform operator.
    const done = await api.sessions.endUser({ ...input, actor: SESSIONS, userId: other.user.id });
    expect(done.ok && done.value.ended).toBe(1);
    expect(await resolveSession(f.auth.config, other.session.token)).toBeNull();
  });

  it("refuses a secret without the sessions scope", async () => {
    const w = await world();
    const user = await userWith(w, "ada@example.com", 2);
    const input = { reason: "Test", ip: null, userAgent: null };
    const refused = { ok: false, code: "operator_required", status: 403 };
    expect(await w.api.sessions.endUser({ ...input, actor: USERS_ONLY, userId: user.id })).toEqual(
      refused,
    );
    expect(await w.api.sessions.endAll({ ...input, actor: USERS_ONLY })).toEqual(refused);
    expect(await sessionsOf(w.storage, user.id)).toHaveLength(2);
    expect(await auditRows(w.storage)).toEqual([]);
    const done = await w.api.sessions.endAll({ ...input, actor: SESSIONS });
    expect(done.ok && [done.value.ended, done.value.more]).toEqual([2, false]);
    expect((await auditRows(w.storage)).map((r) => [r.actorKind, r.actorId])).toEqual([
      ["secret", "support"],
    ]);
  });

  it("answers not_found while operator.users is off, and invalid_body for a bad limit", async () => {
    const off = await world({ users: false });
    const input = { actor: APP, reason: "Test", ip: null, userAgent: null };
    const notFound = { ok: false, code: "not_found", status: 404 };
    expect(await off.api.sessions.endUser({ ...input, userId: "u" })).toEqual(notFound);
    expect(await off.api.sessions.endAll(input)).toEqual(notFound);
    const w = await world();
    await userWith(w, "ada@example.com", 1);
    for (const limit of [0, 1001, 1.5])
      expect(await w.api.sessions.endAll({ ...input, limit })).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    // 47 calls before the act leave 2 for the work: less than the read, a link read, and a delete.
    for (const callsUsed of [-1, 1.5, 47, 50])
      expect(await w.api.sessions.endAll({ ...input, callsUsed })).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    // endUser of the app: 30 calls before leave 19, the least call; 31 leave 18.
    const user = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "ada@example.com" },
    ]);
    if (!user) throw new Error("no user");
    expect(
      await w.api.sessions.endUser({ ...input, userId: user.id, callsUsed: 31 }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await sessionsOf(w.storage)).toHaveLength(1);
    expect(await auditRows(w.storage)).toEqual([]);
    expect(
      await w.api.sessions.endUser({ ...input, userId: user.id, callsUsed: 30 }),
    ).toMatchObject({ ok: true, value: { ended: 1, more: false } });
    expect(await w.api.sessions.endAll({ ...input, reason: "a\nb" })).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(await sessionsOf(w.storage)).toEqual([]);
    expect((await auditRows(w.storage)).map((r) => r.action)).toEqual(["sessions_end_user"]);
  });

  it("writes the logouts of two users' linked sessions and sends none in the call (ruling 1)", async () => {
    const w = await world();
    const clientId = await backchannelClient(w);
    const ada = await userWith(w, "ada@example.com", 1);
    const bob = await userWith(w, "bob@example.com", 1);
    // The test keeps no token of the sign-up session, so a second session gives the cookie.
    const adaOpen = await openSession(w.config, {
      user: ada,
      ip: null,
      userAgent: null,
      via: "password",
    });
    const bobOpen = await openSession(w.config, {
      user: bob,
      ip: null,
      userAgent: null,
      via: "password",
    });
    await linked(w, adaOpen.token, clientId);
    await linked(w, bobOpen.token, clientId);
    expect(await w.storage.findMany("oauthSessionClient", [])).toHaveLength(2);
    const tokens = await w.storage.findMany("oauthToken", []);
    expect(tokens.length).toBeGreaterThan(0);
    const done = await w.api.sessions.endAll({
      actor: APP,
      reason: "Key leak",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    expect([done.value.ended, done.value.more]).toEqual([4, false]);
    expect(await sessionsOf(w.storage)).toEqual([]);
    expect(await w.storage.findMany("oauthSessionClient", [])).toEqual([]);
    const outbox = await w.storage.findMany("oauthLogout", []);
    expect(outbox.map((r) => [r.userId, r.sessionId, r.clientId]).sort()).toEqual(
      [
        [ada.id, adaOpen.session.id, clientId],
        [bob.id, bobOpen.session.id, clientId],
      ].sort(),
    );
    // The rows are due now; the sweep sends them, not the call.
    expect(outbox.every((r) => r.nextAttemptAt.getTime() === w.clock.now().getTime())).toBe(true);
    expect(w.sent).toEqual([]);
    // The sessions only: the OAuth tokens of every user stay.
    expect(await w.storage.findMany("oauthToken", [])).toEqual(tokens);
  });

  it("sends the back-channel logout of one user's linked session after the commit", async () => {
    const w = await world();
    const clientId = await backchannelClient(w);
    const ada = await userWith(w, "ada@example.com", 1);
    const open = await openSession(w.config, {
      user: ada,
      ip: null,
      userAgent: null,
      via: "password",
    });
    await linked(w, open.token, clientId);
    const done = await w.api.sessions.endUser({
      actor: APP,
      userId: ada.id,
      reason: "Lost laptop",
      ip: null,
      userAgent: null,
    });
    expect(done.ok && done.value.ended).toBe(2);
    expect(w.sent).toEqual([BACKCHANNEL]);
    expect(await w.storage.findMany("oauthLogout", [])).toEqual([]);
    // The ban list of deletes: the OAuth tokens of the user go too.
    expect(await w.storage.findMany("oauthToken", [])).toEqual([]);
  });

  it("costs 22 storage calls for a call of 500 with no hook and no link", async () => {
    const w = await world();
    for (let u = 0; u < 13; u++) await userWith(w, `user${u}@example.com`, 40);
    expect(await sessionsOf(w.storage)).toHaveLength(520);
    const counts = countCalls(w.storage);
    const done = await w.api.sessions.endAll({
      actor: APP,
      reason: "Key leak",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    expect([done.value.ended, done.value.more]).toEqual([500, true]);
    // One read of 501 rows, 10 link reads by 50 ids, 10 deletes by 50 ids, and the audit row.
    expect([counts.calls, counts.sessionRowsRead]).toEqual([22, 501]);
  });

  it("keeps each call of the app at 49 storage calls or fewer, and ends each session once", async () => {
    const cases = [
      { size: 1, linked: 0 },
      { size: 50, linked: 0 },
      { size: 500, linked: 0 },
      // A linked session is a new sign-in after the sign-up, so the smallest case has 2.
      { size: 2, linked: 1 },
      { size: 50, linked: 5 },
      { size: 500, linked: 5 },
    ];
    for (const hook of [false, true])
      for (const { size, linked: linkCount } of cases) {
        const label = `hook ${hook}, ${size} sessions, ${linkCount} linked`;
        const w = await world({ hook });
        const clientId = linkCount > 0 ? await backchannelClient(w) : null;
        let made = 0;
        for (let u = 0; made < size; u++) {
          const user = await userWith(w, `user${u}@example.com`, 1);
          made++;
          for (let i = 1; i < 40 && made < size; i++, made++) {
            const open = await openSession(w.config, {
              user,
              ip: null,
              userAgent: null,
              via: "password",
            });
            if (clientId && made <= linkCount) await linked(w, open.token, clientId);
          }
        }
        const all = await sessionsOf(w.storage);
        expect(all, label).toHaveLength(size);
        expect(await w.storage.findMany("oauthSessionClient", []), label).toHaveLength(linkCount);
        w.ended.length = 0;
        const counts = countCalls(w.storage);
        let more = true;
        let ended = 0;
        for (let call = 0; more && call < 20; call++) {
          counts.calls = 0;
          const done = await w.api.sessions.endAll({
            actor: APP,
            reason: "Key leak",
            ip: null,
            userAgent: null,
          });
          if (!done.ok) throw new Error(done.code);
          // The work of 48 and the audit row; the schema check of D1 makes 50.
          expect(counts.calls, label).toBeLessThanOrEqual(49);
          expect(done.value.ended, label).toBeGreaterThan(0);
          ended += done.value.ended;
          more = done.value.more;
        }
        expect([more, ended], label).toEqual([false, size]);
        expect(await sessionsOf(w.storage), label).toEqual([]);
        // The calls write the logouts that fit; the sweep writes the rest and sends them all.
        await sweepAll(w);
        expect(w.sent, label).toHaveLength(linkCount);
        if (hook)
          expect([...w.ended].sort(), label).toEqual(all.map((x) => `${x.id}:operator`).sort());
      }
  });

  it("ends 60 sessions in one call and leaves the links past the budget to the sweep", async () => {
    const w = await world();
    const clientId = await backchannelClient(w);
    const user = await userWith(w, "ada@example.com", 1);
    const open = () => openSession(w.config, { user, ip: null, userAgent: null, via: "password" });
    for (let i = 0; i < 25; i++) await linked(w, (await open()).token, clientId);
    for (let i = 0; i < 34; i++) await open();
    expect(await sessionsOf(w.storage)).toHaveLength(60);
    const counts = countCalls(w.storage);
    const done = await w.api.sessions.endAll({
      actor: APP,
      reason: "Key leak",
      ip: null,
      userAgent: null,
    });
    // The read, 2 link reads, and 2 deletes cost 5; 21 links take 42 of the 48; then the audit row.
    expect(done.ok && [done.value.ended, done.value.more, counts.calls]).toEqual([60, false, 48]);
    expect(await sessionsOf(w.storage)).toEqual([]);
    expect(await w.storage.findMany("oauthLogout", [])).toHaveLength(21);
    expect(await w.storage.findMany("oauthSessionClient", [])).toHaveLength(4);
    await sweepAll(w);
    expect(w.sent).toHaveLength(25);
  });

  it("ends a session with 30 client links in one call inside the budget (review M1)", async () => {
    const w = await world({ hook: true });
    const clients: string[] = [];
    // The register limit is 10 per IP per hour: the gap of the sign-ups keeps 30 under it.
    for (let i = 0; i < 30; i++) {
      w.clock.advance(SIGN_UP_GAP_MS);
      clients.push(await backchannelClient(w));
    }
    const user = await userWith(w, "ada@example.com", 1);
    const opened = await openSession(w.config, {
      user,
      ip: null,
      userAgent: null,
      via: "password",
    });
    for (const clientId of clients) await linked(w, opened.token, clientId);
    expect(await w.storage.findMany("oauthSessionClient", [])).toHaveLength(30);
    w.ended.length = 0;
    const counts = countCalls(w.storage);
    const calls: number[] = [];
    let more = true;
    for (let call = 0; more && call < 5; call++) {
      counts.calls = 0;
      const done = await w.api.sessions.endAll({
        actor: APP,
        reason: "Key leak",
        ip: null,
        userAgent: null,
      });
      if (!done.ok) throw new Error(done.code);
      calls.push(counts.calls);
      more = done.value.more;
      // The linked session goes in the first call, with its event.
      if (call === 0) expect(await resolveSession(w.config, opened.token)).toBeNull();
    }
    expect(calls).toEqual([49]);
    expect(w.ended).toContain(`${opened.session.id}:operator`);
    expect(await sessionsOf(w.storage)).toEqual([]);
    // Two sessions: the read, the link read, and 2 deletes cost 4. So 22 logouts fit the
    // work of 48, and the sweep makes the other 8 and sends all 30.
    expect(await w.storage.findMany("oauthLogout", [])).toHaveLength(22);
    expect(await w.storage.findMany("oauthSessionClient", [])).toHaveLength(8);
    await sweepAll(w);
    expect(w.sent).toHaveLength(30);
  });

  it("fits a whole user-actor call of endAll with a hook and a full page in 50 calls (review M2)", async () => {
    const limited = { calls: 0 };
    const f = await operatorFixture({
      config: {
        // The D1 limiter sends one statement per check.
        limiter: {
          allow: async () => {
            limited.calls++;
            return true;
          },
        },
        // A slide of 6 hours, so the read of the session makes its refresh write too.
        session: { slidingRefreshDays: 0.25 },
        hooks: { session: { afterEnd: () => {} } },
      },
    });
    // 90 sessions: two full pages.
    for (let u = 0; u < 3; u++) {
      const email = `user${u}@example.com`;
      f.auth.clock.advance(SIGN_UP_GAP_MS);
      await signUpAndVerify(f.auth, email, PASSWORD);
      const user = await f.auth.storage.findOne("user", [
        { field: "email", op: "eq", value: email },
      ]);
      if (!user) throw new Error("no user");
      for (let i = 1; i < 30; i++)
        await openSession(f.auth.config, { user, ip: null, userAgent: null, via: "password" });
    }
    const api = operatorApi(f.auth.config);
    // The D1 adapter checks the schema version with one query before the first call of an invocation.
    const SCHEMA_CHECK = 1;
    const whole = async (callsUsed: "count" | "default") => {
      // 7 hours: past the slide, and inside the 1440 fresh minutes of the sign-in.
      f.auth.clock.advance(7 * HOUR_MS);
      const counts = countCalls(f.auth.storage);
      limited.calls = 0;
      const resolved = await resolveSession(f.auth.config, f.operator.token);
      if (!resolved) throw new Error("the session ended");
      const actor = await requireOperatorUser(f.auth.config, resolved);
      if (!actor.ok) throw new Error(actor.code);
      const before = counts.calls + limited.calls + SCHEMA_CHECK;
      const done = await api.sessions.endAll({
        actor: actor.value,
        reason: "Key leak",
        ip: null,
        userAgent: null,
        ...(callsUsed === "count" ? { callsUsed: before } : {}),
      });
      if (!done.ok) throw new Error(done.code);
      return {
        before,
        total: counts.calls + limited.calls + SCHEMA_CHECK,
        ended: done.value.ended,
      };
    };
    // The session, the user, the refresh; the platform organization, the member, the factor, the limiter; the schema check.
    // With the reserve of 9 the work gets 40 calls: the read, the link read, and 38 deletes.
    expect(await whole("default")).toEqual({ before: 8, total: 49, ended: 38 });
    // With the count of 8 the work gets 41 calls, and the whole call makes 50.
    expect(await whole("count")).toEqual({ before: 8, total: 50, ended: 39 });
  });

  it("ends one user's 100 sessions and 5 links in pages of 49 calls or fewer (review m2)", async () => {
    for (const hook of [false, true]) {
      const label = `hook ${hook}`;
      const w = await world({ hook });
      const clientId = await backchannelClient(w);
      const user = await userWith(w, "ada@example.com", 1);
      for (let i = 1; i < 100; i++) {
        // The id is time-ordered across milliseconds: the linked sessions come first.
        w.clock.advance(1);
        const open = await openSession(w.config, {
          user,
          ip: null,
          userAgent: null,
          via: "password",
        });
        if (i <= 5) await linked(w, open.token, clientId);
      }
      const all = await sessionsOf(w.storage, user.id);
      expect(all, label).toHaveLength(100);
      w.ended.length = 0;
      const counts = countCalls(w.storage);
      const pages: { ended: number; more: boolean; calls: number }[] = [];
      let more = true;
      for (let call = 0; more && call < 10; call++) {
        counts.calls = 0;
        const done = await w.api.sessions.endUser({
          actor: APP,
          userId: user.id,
          reason: "Lost laptop",
          ip: null,
          userAgent: null,
        });
        if (!done.ok) throw new Error(done.code);
        pages.push({ ended: done.value.ended, more: done.value.more, calls: counts.calls });
        more = done.value.more;
      }
      // The steps after the commit count too: the delivery and endFamilies. With the
      // schema check of D1 each call stays at 50 or fewer.
      expect(pages, label).toEqual(
        hook
          ? [
              { ended: 31, more: true, calls: 42 },
              { ended: 31, more: true, calls: 42 },
              { ended: 31, more: true, calls: 42 },
              { ended: 7, more: false, calls: 34 },
            ]
          : [{ ended: 100, more: false, calls: 44 }],
      );
      expect(more, label).toBe(false);
      expect(await sessionsOf(w.storage, user.id), label).toEqual([]);
      expect(await w.storage.findMany("oauthToken", []), label).toEqual([]);
      if (hook)
        expect([...w.ended].sort(), label).toEqual(all.map((x) => `${x.id}:operator`).sort());
      await sweepAll(w);
      expect(w.sent, label).toHaveLength(5);
    }
  });

  it("ends one user's 30 OAuth families over calls of 49 storage calls or fewer (review m2)", async () => {
    const w = await world();
    const clients: string[] = [];
    for (let i = 0; i < 30; i++) {
      w.clock.advance(SIGN_UP_GAP_MS);
      clients.push(await backchannelClient(w));
    }
    const user = await userWith(w, "ada@example.com", 1);
    const opened = await openSession(w.config, {
      user,
      ip: null,
      userAgent: null,
      via: "password",
    });
    // Each code exchange starts one refresh family.
    for (const clientId of clients) await linked(w, opened.token, clientId);
    const families = new Set((await w.storage.findMany("oauthToken", [])).map((t) => t.familyId));
    expect(families.size).toBe(30);
    const counts = countCalls(w.storage);
    const pages: { ended: number; more: boolean; calls: number }[] = [];
    let more = true;
    for (let call = 0; more && call < 10; call++) {
      counts.calls = 0;
      const done = await w.api.sessions.endUser({
        actor: APP,
        userId: user.id,
        reason: "Lost laptop",
        ip: null,
        userAgent: null,
      });
      if (!done.ok) throw new Error(done.code);
      pages.push({ ended: done.value.ended, more: done.value.more, calls: counts.calls });
      more = done.value.more;
    }
    // Each call takes the families that its calls left allow, and answers more while some stay.
    expect(pages).toEqual([
      { ended: 2, more: true, calls: 49 },
      { ended: 0, more: true, calls: 49 },
      { ended: 0, more: false, calls: 44 },
    ]);
    expect(await w.storage.findMany("oauthToken", [])).toEqual([]);
    expect(await resolveSession(w.config, opened.token)).toBeNull();
    await sweepAll(w);
    expect(w.sent).toHaveLength(30);
  });

  it("fits a whole user-actor call of endUser in 50 calls (review m2)", async () => {
    const limited = { calls: 0 };
    const f = await operatorFixture({
      config: {
        limiter: {
          allow: async () => {
            limited.calls++;
            return true;
          },
        },
        session: { slidingRefreshDays: 0.25 },
        hooks: { session: { afterEnd: () => {} } },
      },
    });
    f.auth.clock.advance(SIGN_UP_GAP_MS);
    await signUpAndVerify(f.auth, "ada@example.com", PASSWORD);
    const user = await f.auth.storage.findOne("user", [
      { field: "email", op: "eq", value: "ada@example.com" },
    ]);
    if (!user) throw new Error("no user");
    for (let i = 1; i < 60; i++)
      await openSession(f.auth.config, { user, ip: null, userAgent: null, via: "password" });
    const api = operatorApi(f.auth.config);
    const SCHEMA_CHECK = 1;
    f.auth.clock.advance(7 * HOUR_MS);
    const counts = countCalls(f.auth.storage);
    limited.calls = 0;
    const resolved = await resolveSession(f.auth.config, f.operator.token);
    if (!resolved) throw new Error("the session ended");
    const actor = await requireOperatorUser(f.auth.config, resolved);
    if (!actor.ok) throw new Error(actor.code);
    const before = counts.calls + limited.calls + SCHEMA_CHECK;
    const done = await api.sessions.endUser({
      actor: actor.value,
      userId: user.id,
      reason: "Lost laptop",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    const total = counts.calls + limited.calls + SCHEMA_CHECK;
    // The reserve of 9 leaves the work 40 calls; the whole call makes 42.
    expect([before, total, done.value.ended, done.value.more]).toEqual([8, 42, 21, true]);
  });

  it("ends 60 sessions with a hook in two pages, with no session lost or ended twice", async () => {
    const w = await world({ hook: true });
    for (let u = 0; u < 2; u++) await userWith(w, `user${u}@example.com`, 30);
    const all = await sessionsOf(w.storage);
    expect(all).toHaveLength(60);
    w.ended.length = 0;
    const pages: { ended: number; more: boolean }[] = [];
    for (let call = 0; call < 2; call++) {
      w.clock.advance(1);
      const done = await w.api.sessions.endAll({
        actor: APP,
        reason: "Key leak",
        ip: null,
        userAgent: null,
      });
      if (!done.ok) throw new Error(done.code);
      pages.push({ ended: done.value.ended, more: done.value.more });
    }
    // Page 1: the read, the link read, and 46 deletes fill the work of 48.
    expect(pages).toEqual([
      { ended: 46, more: true },
      { ended: 14, more: false },
    ]);
    expect(w.ended).toHaveLength(60);
    expect([...w.ended].sort()).toEqual(all.map((x) => `${x.id}:operator`).sort());
    expect(await sessionsOf(w.storage)).toEqual([]);
    expect((await auditRows(w.storage)).map((r) => r.data)).toEqual([{ ended: 46 }, { ended: 14 }]);
  });
});
