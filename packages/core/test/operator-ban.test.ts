import { describe, expect, it, vi } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { hookGuard } from "../src/engine/hooks.js";
import { mintSessionJwt, sessionLive, signToken } from "../src/engine/jwt.js";
import { DEVICE_GRANT } from "../src/engine/oauth-device.js";
import { liveUser } from "../src/engine/oauth-token.js";
import { activeBan } from "../src/engine/operator/ban-rule.js";
import { requireOperatorUser } from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { addMember } from "../src/engine/organizations.js";
import { passwordSignIn } from "../src/engine/password.js";
import {
  createSession,
  prepareSession,
  resolveSession,
  writeSession,
} from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { ACCESS_TOKEN_TYPE } from "../src/primitives/credentials.js";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import { decodeJws } from "../src/primitives/jwk.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post } from "./helpers.js";
import {
  approvedDevice,
  authorized,
  basicHeader,
  exchange,
  type Handle,
  pkce,
  REDIRECT,
  RESOURCE,
  registered,
  SCOPES,
  tokenPost,
} from "./oauth-helpers.js";
import { OPERATOR_SECRETS, operatorFixture } from "./operator-helpers.js";
import { FAST, sessionOnly, signUpAndVerify } from "./password-helpers.js";
import { enrolled, PASSWORD } from "./totp-helpers.js";

const EMAIL = "ada@example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const MINUTE_MS = 60_000;

/**
 * The HTTP view and the engine view of one config input on one storage,
 * clock, limiter, and mail list. The config has password sign-in, the
 * OAuth provider, the handoff, and the operator tools. The hooks record
 * the session ends and the user updates.
 */
async function world(extra: Partial<AuthConfig> = {}) {
  const base = makeAuth();
  const ended: string[] = [];
  const updates: string[] = [];
  /** Steps that run once in the ban's user.afterUpdate: after its commit, before endFamilies. */
  const afterBan: (() => Promise<void>)[] = [];
  // The unban keeps bannedAt (ruling 28), so the hooks read the one active-ban rule.
  const banState = (user: Parameters<typeof activeBan>[0]) =>
    activeBan(user, base.clock.now()) ? "banned" : "open";
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
    handoff: { schemes: ["consumera://"] },
    oauth: {
      resources: [RESOURCE],
      scopes: SCOPES,
      registration: { cimd: false, dynamic: true },
      device: {},
    },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: {
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(OPERATOR_SECRETS.support),
          scopes: ["users", "sessions", "audit"],
        },
      ],
      users: true,
    },
    hooks: {
      session: {
        afterEnd: ({ session, reason }) => {
          ended.push(`${session.id}:${reason}`);
        },
      },
      user: {
        beforeUpdate: ({ user, via }) => {
          updates.push(`before:${via}:${banState(user)}`);
        },
        afterUpdate: async ({ user, previous, via }) => {
          updates.push(`after:${via}:${banState(previous)}>${banState(user)}`);
          if (via === "ban") for (const step of afterBan.splice(0)) await step();
        },
      },
    },
    ...extra,
  };
  const config = resolveConfig(input);
  const engine = { ...base, config };
  const handle: Handle = {
    auth: createAuth(input),
    config,
    storage: base.storage,
    clock: base.clock,
  };
  return {
    ...handle,
    engine,
    mail: base.mail,
    ended,
    updates,
    afterBan,
    api: operatorApi(config),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** A verified user with a password, and one password sign-in. */
async function signedIn(w: World, email = EMAIL) {
  if (!(await w.storage.findOne("user", [{ field: "email", op: "eq", value: email }])))
    await signUpAndVerify(w.engine, email, PASSWORD);
  const s = await sessionOnly(
    passwordSignIn(w.config, { email, password: PASSWORD, ip: null, userAgent: null }),
  );
  if (!s.ok) throw new Error(s.code);
  return { ...s.value, cookie: `__Host-tempo_session=${s.value.token}` };
}

const ban = (w: World, userId: string, until?: string) =>
  w.api.users.ban({
    actor: APP,
    userId,
    reason: "Abuse report 7",
    ...(until === undefined ? {} : { until }),
    ip: "203.0.113.9",
    userAgent: "Support/1",
  });

const unban = (w: World, userId: string) =>
  w.api.users.unban({ actor: APP, userId, reason: "Appeal granted", ip: null, userAgent: null });

/** One OAuth grant of the user: an access token and a refresh token. */
async function grant(w: World, cookie: string, clientId: string) {
  const p = await pkce();
  const { code } = await authorized(w, cookie, {
    clientId,
    challenge: p.challenge,
    scope: "mcp:read offline_access",
  });
  const res = await w.auth.handle(exchange(code, clientId, p.verifier));
  if (res.status !== 200) throw new Error(`token answered ${res.status}`);
  return (await res.json()) as { access_token: string; refresh_token: string };
}

const refresh = async (w: World, refreshToken: string, clientId: string) => {
  const res = await w.auth.handle(
    tokenPost({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  );
  return { status: res.status, body: await res.json() };
};

/** A handoff code of the browser session, not yet redeemed. */
async function handoffCode(w: World, session: { id: string; userId: string }) {
  const verifier = randomBase64Url(32);
  const h = await startHandoff(w.config, {
    challenge: await sha256Base64Url(verifier),
    redirect: "consumera://auth",
    ip: null,
  });
  if (!h.ok) throw new Error(h.code);
  const c = await continueHandoff(w.config, {
    handoffId: h.value.handoffId,
    userId: session.userId,
    sessionId: session.id,
  });
  if (!c.ok) throw new Error(c.code);
  return { code: new URL(c.value.location).searchParams.get("code") ?? "", verifier };
}

const status = async (w: World, request: Request) => (await w.auth.handle(request)).status;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const GRANT = { status: 400, body: { error: "invalid_grant" } };
const UNAUTHORIZED = { ok: false, code: "unauthorized", status: 401 };

/** A resource server's client that may introspect (`introspect: true` of `api.oauth.clients`). */
async function introspector(w: World) {
  const clients = w.auth.api.oauth?.clients;
  if (!clients) throw new Error("oauth is off");
  const made = await clients.create({
    name: "Resource server",
    authMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    credentialsScopes: ["mcp:read"],
    introspect: true,
  });
  if (!made.ok) throw new Error(made.error);
  const secret = made.value.clientSecret;
  if (!secret) throw new Error("create answered no secret");
  return { clientId: made.value.client.id, secret };
}

/** The introspection answer of `token` for the client `rs`. */
async function introspect(w: World, rs: { clientId: string; secret: string }, token: string) {
  const res = await w.auth.handle(
    new Request(`${BASE_URL}/auth/oauth/introspect`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicHeader(rs.clientId, rs.secret),
      },
      body: new URLSearchParams({ token }).toString(),
    }),
  );
  return (await res.json()) as { active: boolean };
}

/** The user row of `userId`, read from storage. */
const userRow = (w: World, userId: string) =>
  w.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);

/**
 * The ban, with a race row: a session that a sign-in writes beside the ban.
 * On Postgres a sign-in of an unverified user takes no row lock. Its insert
 * can commit after the ban's delete began, so the delete does not see the
 * row (break P2 of Task 6). The fixture writes that row with the write step
 * of openSession while the ban's transaction is open, after its deletes.
 */
async function raceRow(w: World, userId: string, until?: string) {
  let raced: { token: string; session: { id: string } } | null = null;
  const storage = w.storage as StorageAdapter;
  const transaction = storage.transaction.bind(storage);
  storage.transaction = (fn) =>
    transaction((tx) =>
      fn({
        ...tx,
        create: async (model, data) => {
          if (model === "operatorAudit" && raced === null)
            raced = await createSession(w.config, { userId, ip: null, userAgent: null });
          return tx.create(model, data);
        },
      }),
    );
  expect((await ban(w, userId, until)).ok).toBe(true);
  storage.transaction = transaction;
  const row = raced as { token: string; session: { id: string } } | null;
  if (!row) throw new Error("the race row was not written");
  return row;
}

describe("the ban (plan 12f Task 6)", () => {
  it("ends the access of a banned user", async () => {
    const w = await world();
    const s = await signedIn(w);
    const clientId = await registered(w, [REDIRECT]);
    const before = await grant(w, s.cookie, clientId);
    const after = await grant(w, s.cookie, clientId);
    const code = await handoffCode(w, s.session);
    const made = await w.auth.api.tokens.create({ user: s.user, name: "ci" });
    if (!made.ok) throw new Error(made.code);
    const apiToken = made.value.token;
    const atResource = new Request(RESOURCE, { headers: bearer(before.access_token) });
    expect(await status(w, get("/auth/session", { cookie: s.cookie }))).toBe(200);
    expect(await status(w, get("/auth/tokens/current", bearer(apiToken)))).toBe(200);
    expect(await w.auth.caller(atResource)).toMatchObject({ kind: "oauth" });
    expect(await sessionLive(w.config, { sid: s.session.id })).toBe(true);
    expect(await liveUser(w.config, s.user.id)).not.toBeNull();

    expect(await ban(w, s.user.id)).toEqual({ ok: true, value: { auditId: expect.any(String) } });

    expect(await status(w, get("/auth/session", { cookie: s.cookie }))).toBe(401);
    expect(await sessionLive(w.config, { sid: s.session.id })).toBe(false);
    expect(await refresh(w, before.refresh_token, clientId)).toEqual(GRANT);
    // The user of the refresh grant, the code exchange, the device poll, and introspection.
    expect(await liveUser(w.config, s.user.id)).toBeNull();
    expect(await status(w, get("/auth/tokens/current", bearer(apiToken)))).toBe(401);
    // Ruling 5: the access token answers as no token while the ban holds.
    expect(
      await w.auth.caller(new Request(RESOURCE, { headers: bearer(before.access_token) })),
    ).toBeNull();
    // The API token row stays: it has its own revoke.
    expect(await w.storage.findMany("apiToken", [])).toHaveLength(1);

    expect(await unban(w, s.user.id)).toEqual({ ok: true, value: { auditId: expect.any(String) } });

    // The API token works again. The unban restores nothing that the ban ended.
    expect(await status(w, get("/auth/tokens/current", bearer(apiToken)))).toBe(200);
    expect(await status(w, get("/auth/session", { cookie: s.cookie }))).toBe(401);
    expect(await refresh(w, after.refresh_token, clientId)).toEqual(GRANT);
    expect(await redeemHandoff(w.config, { ...code, ip: null, userAgent: null })).toEqual({
      ok: false,
      code: "invalid_token",
      status: 400,
    });
    expect(await w.storage.findMany("session", [])).toEqual([]);
  });

  it("stops a sign-in whose user read came before the ban, at the read after its insert", async () => {
    const w = await world();
    const s = await signedIn(w);
    // Two parallel requests reach this order: the sign-in read the user and
    // ran its hook step, then the ban committed, then the sign-in writes.
    const prepared = await prepareSession(w.config, {
      user: s.user,
      ip: null,
      userAgent: null,
      via: "password",
    });
    expect((await ban(w, s.user.id)).ok).toBe(true);
    const written = await hookGuard(() =>
      w.storage.transaction(async (tx) => {
        await writeSession(w.config, prepared, tx);
        return { ok: true as const, value: null };
      }),
    );
    expect(written).toEqual({ ok: false, code: "account_banned", status: 403 });
    expect(await w.storage.findMany("session", [])).toEqual([]);
  });

  it("ends a session that a race opened before the ban", async () => {
    const w = await world();
    const s = await signedIn(w);
    const row = await raceRow(w, s.user.id);
    w.ended.length = 0;
    expect(await sessionLive(w.config, { sid: row.session.id })).toBe(false);
    // Ruling 4: a read-only resolve answers null and writes nothing.
    expect(await resolveSession(w.config, row.token, "read-only")).toBeNull();
    expect(await w.storage.findMany("session", [])).toHaveLength(1);
    expect(await resolveSession(w.config, row.token)).toBeNull();
    expect(await w.storage.findMany("session", [])).toEqual([]);
    expect(w.ended).toEqual([`${row.session.id}:banned`]);
  });

  it("keeps a race row ended after the unban", async () => {
    const w = await world();
    const s = await signedIn(w);
    const row = await raceRow(w, s.user.id);
    // Nobody presents the row while the ban holds. The operator unbans later.
    w.clock.advance(MINUTE_MS);
    expect((await unban(w, s.user.id)).ok).toBe(true);
    w.ended.length = 0;
    expect(await sessionLive(w.config, { sid: row.session.id })).toBe(false);
    expect(await resolveSession(w.config, row.token, "read-only")).toBeNull();
    expect(await resolveSession(w.config, row.token)).toBeNull();
    expect(await w.storage.findMany("session", [])).toEqual([]);
    expect(w.ended).toEqual([`${row.session.id}:banned`]);
  });

  it("keeps a race row ended after a timed ban ends", async () => {
    const w = await world();
    const s = await signedIn(w);
    const until = new Date(w.clock.now().getTime() + MINUTE_MS).toISOString();
    const row = await raceRow(w, s.user.id, until);
    w.clock.advance(MINUTE_MS);
    expect(await sessionLive(w.config, { sid: row.session.id })).toBe(false);
    expect(await resolveSession(w.config, row.token)).toBeNull();
    expect(await w.storage.findMany("session", [])).toEqual([]);
  });

  it("mints no session JWT for a race row, during the ban and after the unban", async () => {
    const w = await world({ jwtMint: { audience: ["https://rs.example.com"] } });
    const s = await signedIn(w);
    const row = await raceRow(w, s.user.id);
    const mint = () => mintSessionJwt(w.config, { userId: s.user.id, sessionId: row.session.id });
    expect(await mint()).toEqual(UNAUTHORIZED);
    w.clock.advance(MINUTE_MS);
    expect((await unban(w, s.user.id)).ok).toBe(true);
    expect(await mint()).toEqual(UNAUTHORIZED);
  });

  it("ends the ban window at the unban and keeps the time and the reason of the ban", async () => {
    const w = await world({ jwtMint: { audience: ["https://rs.example.com"] } });
    const s = await signedIn(w);
    const bannedAt = w.clock.now();
    expect((await ban(w, s.user.id)).ok).toBe(true);
    w.clock.advance(MINUTE_MS);
    const unbannedAt = w.clock.now();
    expect((await unban(w, s.user.id)).ok).toBe(true);
    expect(await userRow(w, s.user.id)).toMatchObject({
      bannedAt,
      banReason: "Abuse report 7",
      banUntil: unbannedAt,
    });
    // A session that opens after the unban passes each door.
    const again = await signedIn(w);
    expect(await resolveSession(w.config, again.token)).toMatchObject({
      session: { id: again.session.id },
    });
    expect(await sessionLive(w.config, { sid: again.session.id })).toBe(true);
    expect(
      (await mintSessionJwt(w.config, { userId: s.user.id, sessionId: again.session.id })).ok,
    ).toBe(true);
  });

  it("writes no ban field at the unban of a user with no active ban", async () => {
    const w = await world();
    const s = await signedIn(w);
    expect((await unban(w, s.user.id)).ok).toBe(true);
    expect(await userRow(w, s.user.id)).toMatchObject({
      bannedAt: null,
      banReason: null,
      banUntil: null,
    });
    // An ended timed ban keeps its own end.
    const bannedAt = w.clock.now();
    const until = new Date(bannedAt.getTime() + MINUTE_MS);
    expect((await ban(w, s.user.id, until.toISOString())).ok).toBe(true);
    w.clock.advance(2 * MINUTE_MS);
    expect((await unban(w, s.user.id)).ok).toBe(true);
    expect(await userRow(w, s.user.id)).toMatchObject({
      bannedAt,
      banReason: "Abuse report 7",
      banUntil: until,
    });
  });

  it("fires afterEnd with the reason banned once per session, and the user hooks with via ban", async () => {
    const w = await world();
    // The verify link of the sign-up opens the first session; two sign-ins open two more.
    const first = await signedIn(w);
    await signedIn(w);
    const userId = first.user.id;
    const sessions = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: userId },
    ]);
    expect(sessions).toHaveLength(3);
    w.ended.length = 0;
    w.updates.length = 0;
    expect((await ban(w, userId)).ok).toBe(true);
    expect([...w.ended].sort()).toEqual(sessions.map((x) => `${x.id}:banned`).sort());
    expect(w.updates).toEqual(["before:ban:open", "after:ban:open>banned"]);
    w.updates.length = 0;
    // The id is time-ordered only across milliseconds: the clock moves between acts.
    w.clock.advance(1);
    expect((await unban(w, userId)).ok).toBe(true);
    expect(w.updates).toEqual(["before:unban:banned", "after:unban:banned>open"]);
    // An unban of a user with no ban answers ok and writes its row.
    w.clock.advance(1);
    expect((await unban(w, userId)).ok).toBe(true);
    const rows = await w.storage.findMany("operatorAudit", [], {
      sort: { field: "id", dir: "asc" },
    });
    expect(rows.map((r) => r.action)).toEqual(["ban", "unban", "unban"]);
  });

  it("refuses the actor's own user and a platform operator for a user actor", async () => {
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
      await api.users.ban({ ...input, actor: actor.value, userId: f.operator.user.id }),
    ).toEqual({
      ok: false,
      code: "operator_self",
      status: 409,
    });
    expect(
      await api.users.unban({ ...input, actor: actor.value, userId: f.operator.user.id }),
    ).toEqual({
      ok: false,
      code: "operator_self",
      status: 409,
    });
    expect(await api.users.ban({ ...input, actor: actor.value, userId: other.user.id })).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    expect(await api.users.unban({ ...input, actor: actor.value, userId: other.user.id })).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    expect(await f.auth.storage.findMany("operatorAudit", [])).toEqual([]);
    const secret = { kind: "secret", name: "support", scopes: ["users"] } as const;
    expect((await api.users.ban({ ...input, actor: secret, userId: other.user.id })).ok).toBe(true);
    // A secret with no users scope is refused.
    const keys = { kind: "secret", name: "keys", scopes: ["keys", "secrets"] } as const;
    expect(await api.users.ban({ ...input, actor: keys, userId: other.user.id })).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    expect(await api.users.unban({ ...input, actor: keys, userId: other.user.id })).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    // The refusals write no row: the one row is the ban by the secret.
    expect(
      (await f.auth.storage.findMany("operatorAudit", [])).map((r) => [r.action, r.actorId]),
    ).toEqual([["ban", "support"]]);
  });

  it("ends at banUntil", async () => {
    const w = await world();
    const s = await signedIn(w);
    const made = await w.auth.api.tokens.create({ user: s.user, name: "ci" });
    if (!made.ok) throw new Error(made.code);
    const until = new Date(w.clock.now().getTime() + 60 * MINUTE_MS);
    expect((await ban(w, s.user.id, until.toISOString())).ok).toBe(true);
    const signIn = () =>
      sessionOnly(
        passwordSignIn(w.config, { email: EMAIL, password: PASSWORD, ip: null, userAgent: null }),
      );
    expect(await signIn()).toEqual({ ok: false, code: "account_banned", status: 403 });
    // At banUntil exactly the ban has ended (activeBan: banUntil > now).
    w.clock.advance(60 * MINUTE_MS);
    expect((await signIn()).ok).toBe(true);
    w.clock.advance(MINUTE_MS);
    const again = await signIn();
    if (!again.ok) throw new Error(again.code);
    // Ruling 24: an ended ban reads as no ban at each door, and its fields stay.
    expect(await resolveSession(w.config, again.value.token)).toMatchObject({
      session: { id: again.value.session.id },
    });
    expect(await sessionLive(w.config, { sid: again.value.session.id })).toBe(true);
    expect(await liveUser(w.config, s.user.id)).not.toBeNull();
    expect(await status(w, get("/auth/tokens/current", bearer(made.value.token)))).toBe(200);
    expect(
      await w.storage.findOne("user", [{ field: "id", op: "eq", value: s.user.id }]),
    ).toMatchObject({ banReason: "Abuse report 7", banUntil: until });
  });

  it("refuses an end outside 1 minute to 3650 days, and a reason that is not valid", async () => {
    const w = await world();
    const s = await signedIn(w);
    const now = w.clock.now().getTime();
    const at = (ms: number) => new Date(now + ms).toISOString();
    for (const until of [
      at(MINUTE_MS - 1),
      at(3650 * 1440 * MINUTE_MS + 1),
      "tomorrow",
      "2026-02-01",
    ])
      expect(await ban(w, s.user.id, until)).toEqual({
        ok: false,
        code: "invalid_body",
        status: 400,
      });
    expect(
      await w.api.users.ban({
        actor: APP,
        userId: s.user.id,
        reason: "a\nb",
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "invalid_body", status: 400 });
    // The ban reason is a text column: Postgres would store U+FFFD for a lone surrogate.
    expect(
      await w.api.users.ban({
        actor: APP,
        userId: s.user.id,
        reason: "Spam \ud800",
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "invalid_body", status: 400 });
    expect(await ban(w, "01JNOSUCHUSER0000000000000")).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    // A day or an hour that does not exist: Date rolls 02-30 to 03-02.
    const year = w.clock.now().getUTCFullYear() + 1;
    for (const until of [
      `${year}-02-30T00:00:00Z`,
      `${year}-04-31T12:00:00+02:00`,
      `${year}-06-15T23:59:60Z`,
    ])
      expect(await ban(w, s.user.id, until)).toEqual({
        ok: false,
        code: "invalid_body",
        status: 400,
      });
    expect(await userRow(w, s.user.id)).toMatchObject({ bannedAt: null });
    // A real day passes in each zone form.
    expect((await ban(w, s.user.id, `${year}-03-01T00:30:00+02:00`)).ok).toBe(true);
    expect((await userRow(w, s.user.id))?.banUntil?.toISOString()).toBe(
      `${year}-02-28T22:30:00.000Z`,
    );
    expect((await ban(w, s.user.id, `${year}-02-28T23:30:00-02:00`)).ok).toBe(true);
    expect((await userRow(w, s.user.id))?.banUntil?.toISOString()).toBe(
      `${year}-03-01T01:30:00.000Z`,
    );
    expect((await ban(w, s.user.id, at(MINUTE_MS))).ok).toBe(true);
    expect((await ban(w, s.user.id, at(3650 * 1440 * MINUTE_MS))).ok).toBe(true);
    const user = await w.storage.findOne("user", [{ field: "id", op: "eq", value: s.user.id }]);
    // A second ban replaces the reason and the end.
    expect(user?.banUntil?.toISOString()).toBe(at(3650 * 1440 * MINUTE_MS));
  });

  it("writes the row with until", async () => {
    const w = await world();
    const s = await signedIn(w);
    const until = new Date(w.clock.now().getTime() + 60 * MINUTE_MS).toISOString();
    const r = await ban(w, s.user.id, until);
    if (!r.ok) throw new Error(r.code);
    expect(await w.storage.findMany("operatorAudit", [])).toEqual([
      expect.objectContaining({
        id: r.value.auditId,
        actorKind: "app",
        actorId: "support-tool",
        action: "ban",
        targetUserId: s.user.id,
        reason: "Abuse report 7",
        data: { until },
        ip: "203.0.113.9",
        userAgent: "Support/1",
      }),
    ]);
    const user = await w.storage.findOne("user", [{ field: "id", op: "eq", value: s.user.id }]);
    expect(user).toMatchObject({ banReason: "Abuse report 7", banUntil: new Date(until) });
    expect(user?.bannedAt).toEqual(w.clock.now());
  });

  it("keeps an access token from before the ban refused after the unban", async () => {
    const w = await world();
    const s = await signedIn(w);
    const clientId = await registered(w, [REDIRECT]);
    const rs = await introspector(w);
    const before = await grant(w, s.cookie, clientId);
    const caller = (token: string) =>
      w.auth.caller(new Request(RESOURCE, { headers: bearer(token) }));
    expect(await introspect(w, rs, before.access_token)).toMatchObject({ active: true });
    expect((await ban(w, s.user.id)).ok).toBe(true);
    expect(await caller(before.access_token)).toBeNull();
    w.clock.advance(MINUTE_MS);
    expect((await unban(w, s.user.id)).ok).toBe(true);
    // Ruling 25: the unban restores nothing, also before the token's exp.
    expect(await caller(before.access_token)).toBeNull();
    expect(await introspect(w, rs, before.access_token)).toEqual({ active: false });
    // iat is in seconds: a token of the same second as the unban stays refused.
    w.clock.advance(1000);
    const again = await signedIn(w);
    const after = await grant(w, again.cookie, clientId);
    expect(await caller(after.access_token)).toMatchObject({ kind: "oauth" });
    expect(await introspect(w, rs, after.access_token)).toMatchObject({ active: true });
  });

  it("keeps an access token from before a timed ban refused after its end", async () => {
    const w = await world();
    const s = await signedIn(w);
    const clientId = await registered(w, [REDIRECT]);
    const rs = await introspector(w);
    const before = await grant(w, s.cookie, clientId);
    const caller = (token: string) =>
      w.auth.caller(new Request(RESOURCE, { headers: bearer(token) }));
    const until = new Date(w.clock.now().getTime() + 2 * MINUTE_MS).toISOString();
    expect((await ban(w, s.user.id, until)).ok).toBe(true);
    w.clock.advance(2 * MINUTE_MS);
    expect(await caller(before.access_token)).toBeNull();
    expect(await introspect(w, rs, before.access_token)).toEqual({ active: false });
    w.clock.advance(1000);
    const again = await signedIn(w);
    const after = await grant(w, again.cookie, clientId);
    expect(await caller(after.access_token)).toMatchObject({ kind: "oauth" });
  });

  it("refuses an access token with no number iat", async () => {
    const w = await world();
    const s = await signedIn(w);
    const clientId = await registered(w, [REDIRECT]);
    const g = await grant(w, s.cookie, clientId);
    const claims = decodeJws(g.access_token)?.payload;
    if (!claims) throw new Error("the access token does not decode");
    const caller = (token: string) =>
      w.auth.caller(new Request(RESOURCE, { headers: bearer(token) }));
    // The same claims under the same key pass, so only the iat changes the answer.
    const same = await signToken(w.config, ACCESS_TOKEN_TYPE, claims);
    expect(await caller(same)).toMatchObject({ kind: "oauth" });
    const { iat: _iat, ...noIat } = claims;
    for (const iat of [undefined, String(claims.iat)]) {
      const token = await signToken(w.config, ACCESS_TOKEN_TYPE, { ...noIat, iat });
      expect(await caller(token)).toBeNull();
    }
  });

  // Each moment of a race row: while the ban holds, after the unban, and
  // after the end of a timed ban (rulings 28 and 29). Nothing comes back.
  const MOMENTS = [
    { moment: "while the ban holds", until: undefined, elapse: async () => {} },
    {
      moment: "after the unban",
      until: undefined,
      elapse: async (w: World, userId: string) => {
        w.clock.advance(MINUTE_MS);
        expect((await unban(w, userId)).ok).toBe(true);
      },
    },
    {
      moment: "after a timed ban ends",
      until: MINUTE_MS,
      elapse: async (w: World) => {
        w.clock.advance(MINUTE_MS);
      },
    },
  ];

  it.each(MOMENTS)(
    "refuses at the code exchange a code that an authorize wrote beside the ban, $moment",
    async ({ until, elapse }) => {
      const w = await world();
      const s = await signedIn(w);
      const clientId = await registered(w, [REDIRECT]);
      const end = until === undefined ? undefined : new Date(w.clock.now().getTime() + until);
      // The authorize resolved its session before the ban. Its code write
      // comes after the ban's commit, so the ban did not delete the code.
      const storage = w.storage as StorageAdapter;
      const create = storage.create.bind(storage);
      let banned = false;
      storage.create = async (model, data) => {
        if (
          model === "verification" &&
          !banned &&
          "purpose" in data &&
          data.purpose === "oauth-code"
        ) {
          banned = true;
          expect((await ban(w, s.user.id, end?.toISOString())).ok).toBe(true);
        }
        return create(model, data);
      };
      const p = await pkce();
      const { code } = await authorized(w, s.cookie, {
        clientId,
        challenge: p.challenge,
        scope: "mcp:read offline_access",
      });
      storage.create = create;
      expect(banned).toBe(true);
      await elapse(w, s.user.id);
      const res = await w.auth.handle(exchange(code, clientId, p.verifier));
      expect({ status: res.status, body: await res.json() }).toEqual(GRANT);
    },
  );

  it.each(MOMENTS)(
    "refuses at the device poll an approval that landed beside the ban, $moment",
    async ({ until, elapse }) => {
      const w = await world();
      const s = await signedIn(w);
      const registeredDevice = await w.auth.handle(
        post("/auth/oauth/register", {
          redirect_uris: [REDIRECT],
          client_name: "Living room TV",
          grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
        }),
      );
      const { client_id: clientId } = (await registeredDevice.json()) as { client_id: string };
      const end = until === undefined ? undefined : new Date(w.clock.now().getTime() + until);
      // The device page resolved its session before the ban. Its approval
      // comes after the ban's commit: the ban keeps a pending row.
      const storage = w.storage as StorageAdapter;
      const update = storage.update.bind(storage);
      let banned = false;
      storage.update = async (model, where, patch) => {
        if (
          model === "oauthDevice" &&
          !banned &&
          "status" in patch &&
          patch.status === "approved"
        ) {
          banned = true;
          expect((await ban(w, s.user.id, end?.toISOString())).ok).toBe(true);
        }
        return update(model, where, patch);
      };
      const deviceCode = await approvedDevice(w, clientId, s.cookie);
      storage.update = update;
      expect(banned).toBe(true);
      await elapse(w, s.user.id);
      const res = await w.auth.handle(
        tokenPost({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId }),
      );
      expect({ status: res.status, body: await res.json() }).toEqual(GRANT);
    },
  );

  it("gives tokens for a code and a device approval made after the unban", async () => {
    const w = await world();
    const s = await signedIn(w);
    expect((await ban(w, s.user.id)).ok).toBe(true);
    w.clock.advance(MINUTE_MS);
    expect((await unban(w, s.user.id)).ok).toBe(true);
    w.clock.advance(1000);
    const again = await signedIn(w);
    const clientId = await registered(w, [REDIRECT]);
    expect((await grant(w, again.cookie, clientId)).access_token).toEqual(expect.any(String));
    const registeredDevice = await w.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        client_name: "Living room TV",
        grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
      }),
    );
    const { client_id: deviceClient } = (await registeredDevice.json()) as { client_id: string };
    const deviceCode = await approvedDevice(w, deviceClient, again.cookie);
    const res = await w.auth.handle(
      tokenPost({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: deviceClient }),
    );
    expect(res.status).toBe(200);
  });

  it("answers inactive for a refresh token that an exchange wrote beside the ban", async () => {
    const w = await world();
    const s = await signedIn(w);
    // A confidential client that introspects its own refresh tokens.
    const made = await w.auth.api.oauth?.clients.create({
      name: "Notes server",
      authMethod: "client_secret_basic",
      redirectUris: [REDIRECT],
      introspect: true,
    });
    if (!made?.ok || !made.value.clientSecret) throw new Error("the create failed");
    const rs = { clientId: made.value.client.id, secret: made.value.clientSecret };
    const p = await pkce();
    const { code } = await authorized(w, s.cookie, {
      clientId: rs.clientId,
      challenge: p.challenge,
      scope: "mcp:read offline_access",
    });
    // The orders of two Postgres connections: the exchange reads the user
    // before the ban. It writes its refresh row after the ban read the
    // refresh rows, and reads its code row before the ban deletes it.
    const storage = w.storage as StorageAdapter;
    const create = storage.create.bind(storage);
    let reached = () => {};
    let release = () => {};
    const atWrite = new Promise<void>((r) => {
      reached = r;
    });
    const go = new Promise<void>((r) => {
      release = r;
    });
    storage.create = async (model, data) => {
      if (model === "oauthToken") {
        storage.create = create;
        reached();
        await go;
      }
      return create(model, data);
    };
    const exchanged = w.auth.handle(
      tokenPost(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: p.verifier,
          redirect_uri: REDIRECT,
          resource: RESOURCE,
        },
        { authorization: basicHeader(rs.clientId, rs.secret) },
      ),
    );
    await atWrite;
    let answer: Response | null = null;
    const transaction = storage.transaction.bind(storage);
    storage.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          delete: async (model, where) => {
            if (
              model === "verification" &&
              answer === null &&
              JSON.stringify(where).includes("oauth-code")
            ) {
              release();
              answer = await exchanged;
            }
            return tx.delete(model, where);
          },
        }),
      );
    // A request that comes after the ban's commit, before endFamilies ends the family.
    let introspected: { active: boolean } | null = null;
    w.afterBan.push(async () => {
      if (!answer) return;
      const body = (await answer.json()) as { refresh_token?: string };
      introspected = await introspect(w, rs, body.refresh_token ?? "");
    });
    expect((await ban(w, s.user.id)).ok).toBe(true);
    storage.transaction = transaction;
    expect((answer as Response | null)?.status).toBe(200);
    expect(introspected).toEqual({ active: false });
  });

  it("answers conflict after 5 lost rounds, writes no ban field and no audit row, keeps the sessions, and logs the user id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = await world();
    const s = await signedIn(w);
    const sessionIds = async () =>
      (await w.storage.findMany("session", [{ field: "userId", op: "eq", value: s.user.id }])).map(
        (r) => r.id,
      );
    const before = await sessionIds();
    expect(before).toContain(s.session.id);
    const endedBefore = w.ended.length;
    const updatesBefore = w.updates.length;
    // Another request writes the user row before each compare of the act. So each
    // compare on updatedAt matches 0 rows, in the form of the profile test.
    let rounds = 0;
    const storage = w.storage as StorageAdapter;
    const transaction = storage.transaction.bind(storage);
    storage.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          update: async (model, where, patch) => {
            if (model === "user" && where.some((c) => c.field === "updatedAt")) {
              rounds++;
              const row = await storage.findOne("user", [
                { field: "id", op: "eq", value: s.user.id },
              ]);
              if (!row) throw new Error("no user");
              await storage.update("user", [{ field: "id", op: "eq", value: s.user.id }], {
                name: `Other ${rounds}`,
                updatedAt: new Date(row.updatedAt.getTime() + 1),
              });
            }
            return tx.update(model, where, patch);
          },
        }),
      );
    const answer = await ban(w, s.user.id);
    storage.transaction = transaction;
    const logged = [...log.mock.calls];
    log.mockRestore();
    expect(answer).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(rounds).toBe(5);
    expect(logged).toEqual([["authtempo: operator ban write gave up", s.user.id]]);
    expect(
      await w.storage.findOne("user", [{ field: "id", op: "eq", value: s.user.id }]),
    ).toMatchObject({ name: "Other 5", bannedAt: null, banReason: null, banUntil: null });
    expect(await w.storage.findMany("operatorAudit", [])).toEqual([]);
    expect(await sessionIds()).toEqual(before);
    expect(w.ended.slice(endedBefore)).toEqual([]);
    expect(w.updates.slice(updatesBefore)).toEqual(Array(5).fill("before:ban:open"));
    expect(await resolveSession(w.config, s.token)).not.toBeNull();
  });

  it("answers not_found while the user tools are off", async () => {
    const auth = makeAuth();
    const user = await auth.seedUser(EMAIL);
    const input = { actor: APP, userId: user.id, reason: "Test", ip: null, userAgent: null };
    const off = { ok: false, code: "not_found", status: 404 };
    expect(await operatorApi(auth.config).users.ban(input)).toEqual(off);
    expect(await operatorApi(auth.config).users.unban(input)).toEqual(off);
  });
});

describe("the pending-end row of a ban and a clock that runs ahead (ruling 55 of plan 12d)", () => {
  it("ends in the sweep a session that an instance 2 s ahead wrote before the ban", async () => {
    const w = await world();
    const s = await signedIn(w);
    for (let i = 0; i < 60; i++)
      await createSession(w.config, { userId: s.user.id, ip: null, userAgent: null });
    // An instance whose clock runs 2 s ahead writes one more session.
    w.clock.advance(2000);
    const ahead = await createSession(w.config, { userId: s.user.id, ip: null, userAgent: null });
    w.clock.advance(-2000);
    expect((await ban(w, s.user.id)).ok).toBe(true);
    // The act ends a page; the session from ahead sorts last and waits for the sweep.
    expect(
      await w.storage.findOne("session", [{ field: "id", op: "eq", value: ahead.session.id }]),
    ).not.toBeNull();
    const pending = () =>
      w.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "session-end" }]);
    for (let i = 0; i < 5 && (await pending()).length > 0; i++) await sweepExpired(w.config);
    expect(await pending()).toEqual([]);
    expect(
      await w.storage.findMany("session", [{ field: "userId", op: "eq", value: s.user.id }]),
    ).toEqual([]);
  });
});
