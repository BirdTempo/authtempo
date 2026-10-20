import { describe, expect, it } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { hookGuard } from "../src/engine/hooks.js";
import { sessionLive } from "../src/engine/jwt.js";
import { liveUser } from "../src/engine/oauth-token.js";
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
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth } from "./helpers.js";
import {
  authorized,
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
 * clock, limiter, and mail list: password sign-in, the OAuth provider, the
 * handoff, and the operator tools. The hooks record the session ends and
 * the user updates.
 */
async function world(extra: Partial<AuthConfig> = {}) {
  const base = makeAuth();
  const ended: string[] = [];
  const updates: string[] = [];
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
          updates.push(`before:${via}:${user.bannedAt === null ? "open" : "banned"}`);
        },
        afterUpdate: ({ user, previous, via }) => {
          updates.push(
            `after:${via}:${previous.bannedAt === null ? "open" : "banned"}>${user.bannedAt === null ? "open" : "banned"}`,
          );
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
  return { ...handle, engine, mail: base.mail, ended, updates, api: operatorApi(config) };
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
    // On Postgres a sign-in of an unverified user takes no row lock. Its
    // insert can commit after the ban's delete began, so the delete does
    // not see the row. The fixture writes that row with the write step of
    // openSession while the ban's transaction is open, after its deletes.
    let raced: { token: string; session: { id: string } } | null = null;
    const storage = w.storage as StorageAdapter;
    const transaction = storage.transaction.bind(storage);
    storage.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          create: async (model, data) => {
            if (model === "operatorAudit" && raced === null)
              raced = await createSession(w.config, {
                userId: s.user.id,
                ip: null,
                userAgent: null,
              });
            return tx.create(model, data);
          },
        }),
      );
    expect((await ban(w, s.user.id)).ok).toBe(true);
    storage.transaction = transaction;
    const row = raced as { token: string; session: { id: string } } | null;
    if (!row) throw new Error("the race row was not written");
    w.ended.length = 0;
    expect(await sessionLive(w.config, { sid: row.session.id })).toBe(false);
    // Ruling 4: a read-only resolve answers null and writes nothing.
    expect(await resolveSession(w.config, row.token, "read-only")).toBeNull();
    expect(await w.storage.findMany("session", [])).toHaveLength(1);
    expect(await resolveSession(w.config, row.token)).toBeNull();
    expect(await w.storage.findMany("session", [])).toEqual([]);
    expect(w.ended).toEqual([`${row.session.id}:banned`]);
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
    expect(await ban(w, "01JNOSUCHUSER0000000000000")).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
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

  it("answers not_found while the user tools are off", async () => {
    const auth = makeAuth();
    const user = await auth.seedUser(EMAIL);
    const input = { actor: APP, userId: user.id, reason: "Test", ip: null, userAgent: null };
    const off = { ok: false, code: "not_found", status: 404 };
    expect(await operatorApi(auth.config).users.ban(input)).toEqual(off);
    expect(await operatorApi(auth.config).users.unban(input)).toEqual(off);
  });
});
