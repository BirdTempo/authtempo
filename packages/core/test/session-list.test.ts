import { describe, expect, it } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { continueHandoff, startHandoff } from "../src/engine/handoff.js";
import { mintSessionJwt, sessionLive } from "../src/engine/jwt.js";
import { changePassword, passwordSignIn } from "../src/engine/password.js";
import { reauthenticate } from "../src/engine/reauth.js";
import {
  endOtherAccess,
  listSessions,
  REVOKE_PER_USER,
  revokeOtherSessions,
  revokeSession,
  SESSION_LIST_MAX,
} from "../src/engine/session-list.js";
import { createSession, peekSession, resolveSession } from "../src/engine/sessions.js";
import { createApiToken } from "../src/engine/tokens.js";
import { verifyTwoFactor } from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post } from "./helpers.js";
import {
  authorized,
  exchange,
  type Handle,
  pkce,
  RESOURCE,
  registered,
  SCOPES,
} from "./oauth-helpers.js";
import { FAST } from "./password-helpers.js";
import {
  type Auth,
  codeNow,
  EMAIL,
  enrolled,
  PASSWORD,
  totpAuth,
  verifiedSession,
} from "./totp-helpers.js";

const DAY = 86_400_000;
const SECRET = "0123456789abcdef0123456789abcdef";

function listening() {
  const ended: string[] = [];
  const auth = totpAuth({
    handoff: { schemes: ["example://"] },
    hooks: {
      session: {
        afterEnd: ({ session, reason }) => {
          ended.push(`${session.id}:${reason}`);
        },
      },
    },
  });
  return { auth, ended };
}

async function stale(auth: Auth, token: string) {
  auth.clock.advance(DAY);
  const s = await resolveSession(auth.config, token);
  if (!s) throw new Error("the session ended");
  return s;
}

/** A session of `userId` that a sign-in opened, one second after the last one, so the ids sort by time. */
async function open(auth: Auth, userId: string, ip: string) {
  auth.clock.advance(1000);
  const { token } = await createSession(auth.config, { userId, ip, userAgent: null });
  const s = await resolveSession(auth.config, token);
  if (!s) throw new Error("no session");
  return { ...s, token };
}

/**
 * The config of `auth` after the deployment turns `absoluteDays: 1` on (plan
 * 12b), on the same storage and clock. A row from the old config keeps its
 * 30-day expiry, past the new cap.
 */
function cappedConfig(auth: Auth) {
  return resolveConfig({
    baseURL: BASE_URL,
    secret: SECRET,
    trustedOrigins: [APP_ORIGIN],
    storage: auth.storage,
    clock: auth.clock,
    mail: { send: async () => {} },
    password: { hash: FAST, uniformSignUp: false },
    session: { absoluteDays: 1 },
    hooks: auth.config.hooks,
  });
}

const ids = async (auth: Auth, userId: string) =>
  (await auth.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }]))
    .map((s) => s.id)
    .sort();

describe("the session list (plan 12a, ASVS 5.0.0 7.5.2)", () => {
  it("lists the live sessions newest first, marks the current one, drops an expired one and another user's, and holds no token hash", async () => {
    const auth = totpAuth();
    const user = await auth.seedUser("list@example.com");
    const bob = await auth.seedUser("bob@example.com");
    // An expired row that no read has deleted yet: the clock passes its 30 days.
    const gone = await open(auth, user.id, "0.0.0.0");
    auth.clock.advance(31 * DAY);
    const first = await open(auth, user.id, "1.1.1.1");
    await open(auth, bob.id, "4.4.4.4");
    const second = await open(auth, user.id, "2.2.2.2");
    expect(await ids(auth, user.id)).toContain(gone.session.id);
    const r = await listSessions(auth.config, { session: second });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.map((s) => [s.id, s.current, s.ip])).toEqual([
      [second.session.id, true, "2.2.2.2"],
      [first.session.id, false, "1.1.1.1"],
    ]);
    expect(Object.keys(r.value[0] ?? {}).sort()).toEqual([
      "activeOrganizationId",
      "createdAt",
      "current",
      "expiresAt",
      "freshAt",
      "id",
      "ip",
      "lastSeenAt",
      "userAgent",
    ]);
    // The same list from the other session marks that one current.
    const fromFirst = await listSessions(auth.config, { session: first });
    if (!fromFirst.ok) throw new Error(fromFirst.code);
    expect(fromFirst.value.map((s) => s.current)).toEqual([false, true]);
  });

  it(`answers at most SESSION_LIST_MAX (${SESSION_LIST_MAX}) rows, the newest`, async () => {
    const auth = totpAuth();
    const user = await auth.seedUser("many@example.com");
    const opened: string[] = [];
    for (let i = 0; i <= SESSION_LIST_MAX; i++)
      opened.push((await open(auth, user.id, "1.1.1.1")).session.id);
    const me = await resolveSession(auth.config, (await open(auth, user.id, "2.2.2.2")).token);
    if (!me) throw new Error("no session");
    const r = await listSessions(auth.config, { session: me });
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toHaveLength(SESSION_LIST_MAX);
    expect(r.value[0]?.id).toBe(me.session.id);
    // The newest 99 of the 101 opened rows follow; the two oldest are not in the answer.
    expect(r.value.slice(1).map((s) => s.id)).toEqual(opened.slice(2).reverse());
  });

  it("drops a row past the absolute cap that an older config wrote, and answers the cap as its expiry", async () => {
    const auth = totpAuth();
    const user = await auth.seedUser("cap@example.com");
    const old = await open(auth, user.id, "1.1.1.1");
    auth.clock.advance(2 * DAY);
    const me = await open(auth, user.id, "2.2.2.2");
    // The deployment turns absoluteDays on (plan 12b). The old row keeps its 30-day expiry.
    const capped = cappedConfig(auth);
    expect(old.session.expiresAt.getTime()).toBeGreaterThan(auth.clock.now().getTime());
    const r = await listSessions(capped, { session: me });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.map((s) => s.id)).toEqual([me.session.id]);
    expect(r.value[0]?.expiresAt).toEqual(new Date(me.session.createdAt.getTime() + DAY));
    expect(await revokeSession(capped, { session: me, id: old.session.id })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  // The list, the revoke, peekSession, the JWT mint, and the JWT live check
  // read a row as live exactly when resolveSession does, at both edges
  // (review M4 and round 3 L7). Each path reads `sessionIsLive`.
  for (const edge of ["cap", "expiry"] as const)
    for (const offset of [-1, 0]) {
      it(`every live read agrees with resolveSession at the ${edge} edge ${offset} ms`, async () => {
        const auth = totpAuth();
        const config = edge === "cap" ? cappedConfig(auth) : auth.config;
        const user = await auth.seedUser("edge@example.com");
        // The target opens under the default config: its expiry is 30 days, past the cap of 1 day.
        const t = await createSession(auth.config, { userId: user.id, ip: null, userAgent: null });
        const target = await resolveSession(auth.config, t.token, { refresh: false });
        if (!target) throw new Error("no target");
        auth.clock.advance(DAY / 2);
        const m = await createSession(config, { userId: user.id, ip: null, userAgent: null });
        const me = await resolveSession(config, m.token);
        if (!me) throw new Error("no session");
        const end =
          edge === "cap"
            ? target.session.createdAt.getTime() + DAY
            : target.session.expiresAt.getTime();
        auth.clock.advance(end + offset - auth.clock.now().getTime());
        const live = (await resolveSession(config, t.token, { refresh: false })) !== null;
        expect(live).toBe(offset < 0);
        const listed = await listSessions(config, { session: me });
        if (!listed.ok) throw new Error(listed.code);
        expect(listed.value.some((s) => s.id === target.session.id)).toBe(live);
        expect((await peekSession(config, t.token)) !== null).toBe(live);
        expect(await sessionLive(config, { sid: target.session.id })).toBe(live);
        const minted = await mintSessionJwt(config, {
          userId: user.id,
          sessionId: target.session.id,
        });
        expect(minted.ok).toBe(live);
        const fresh = { ...me, session: { ...me.session, freshAt: auth.clock.now() } };
        expect((await revokeSession(config, { session: fresh, id: target.session.id })).ok).toBe(
          live,
        );
      });
    }

  it("a stale session lists, refuses the revoke, and passes after a re-authentication with the same token", async () => {
    const auth = totpAuth();
    const signedIn = await verifiedSession(auth);
    const other = await verifiedSession(auth, EMAIL, "2.2.2.2");
    const old = await stale(auth, signedIn.token);
    expect((await listSessions(auth.config, { session: old })).ok).toBe(true);
    expect(await revokeOtherSessions(auth.config, { session: old })).toMatchObject({
      ok: false,
      code: "session_not_fresh",
    });
    expect(await revokeSession(auth.config, { session: old, id: other.session.id })).toMatchObject({
      ok: false,
      code: "session_not_fresh",
    });
    expect(await resolveSession(auth.config, other.token)).not.toBeNull();
    const fresh = await reauthenticate(auth.config, {
      session: old,
      proof: { password: PASSWORD },
      ip: null,
    });
    expect(fresh.ok).toBe(true);
    const again = await resolveSession(auth.config, signedIn.token);
    if (!again) throw new Error("the session ended");
    const listed = await listSessions(auth.config, { session: again });
    if (!listed.ok) throw new Error(listed.code);
    expect(listed.value.length).toBeGreaterThan(1);
    expect(await revokeOtherSessions(auth.config, { session: again })).toEqual({
      ok: true,
      value: { ended: listed.value.length - 1 },
    });
  });
});

describe("the revoke of one session (plan 12a)", () => {
  it("ends another session of the user with reason revoked, and refuses another user's id", async () => {
    const { auth, ended } = listening();
    const other = await verifiedSession(auth);
    const me = await verifiedSession(auth, EMAIL, "2.2.2.2");
    const bob = await verifiedSession(auth, "bob@example.com");
    // The helpers' sign-ups and claims ended sessions too; only the revoke is under test.
    ended.length = 0;
    expect(await revokeSession(auth.config, { session: me, id: bob.session.id })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await resolveSession(auth.config, bob.token)).not.toBeNull();
    expect(await revokeSession(auth.config, { session: me, id: other.session.id })).toEqual({
      ok: true,
      value: { current: false },
    });
    expect(ended).toEqual([`${other.session.id}:revoked`]);
    expect(await resolveSession(auth.config, other.token)).toBeNull();
    expect(await revokeSession(auth.config, { session: me, id: other.session.id })).toMatchObject({
      code: "not_found",
    });
    // The caller's own id: the answer marks it current, and the session ends.
    expect(await revokeSession(auth.config, { session: me, id: me.session.id })).toEqual({
      ok: true,
      value: { current: true },
    });
    expect(ended).toEqual([`${other.session.id}:revoked`, `${me.session.id}:revoked`]);
    expect(await resolveSession(auth.config, me.token)).toBeNull();
  });

  it("two parallel revokes of one row: one wins, the other answers not_found, and one event fires", async () => {
    const { auth, ended } = listening();
    const target = await verifiedSession(auth);
    const a = await verifiedSession(auth, EMAIL, "2.2.2.2");
    const b = await verifiedSession(auth, EMAIL, "3.3.3.3");
    ended.length = 0;
    const answers = await Promise.all([
      revokeSession(auth.config, { session: a, id: target.session.id }),
      revokeSession(auth.config, { session: b, id: target.session.id }),
    ]);
    expect(answers.filter((r) => r.ok)).toHaveLength(1);
    expect(answers.filter((r) => !r.ok && r.code === "not_found")).toHaveLength(1);
    expect(ended).toEqual([`${target.session.id}:revoked`]);
  });

  it("clears the cookie when the caller revokes its own session", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const res = await handle(
      post(
        "/auth/sessions/revoke",
        { id: me.session.id },
        { cookie: `${auth.config.cookieName}=${me.token}` },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, current: true });
    expect(res.headers.getSetCookie().join("\n")).toContain(`${auth.config.cookieName}=;`);
    expect(await resolveSession(auth.config, me.token)).toBeNull();
  });

  it("ends and clears the old cookie name when the caller revokes its own session with both names", async () => {
    const auth = totpAuth();
    const a = await verifiedSession(auth);
    const b = await verifiedSession(auth, EMAIL, "2.2.2.2");
    const legacy = auth.config.legacyCookieName;
    if (legacy === null) throw new Error("no old cookie name");
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const res = await handle(
      post(
        "/auth/sessions/revoke",
        { id: a.session.id },
        { cookie: `${auth.config.cookieName}=${a.token}; ${legacy}=${b.token}` },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, current: true });
    // startsWith: a toContain of "tempo_session=;" also matches the new name.
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${legacy}=;`))).toBe(true);
    // As the sign-out does: the old token's session ends too (review M1).
    expect((await handle(get("/auth/session", { cookie: `${legacy}=${b.token}` }))).status).toBe(
      401,
    );
  });

  it("clears no cookie when the caller revokes another session", async () => {
    const auth = totpAuth();
    const other = await verifiedSession(auth);
    const me = await verifiedSession(auth, EMAIL, "2.2.2.2");
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const res = await handle(
      post(
        "/auth/sessions/revoke",
        { id: other.session.id },
        { cookie: `${auth.config.cookieName}=${me.token}` },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, current: false });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await resolveSession(auth.config, me.token)).not.toBeNull();
  });
});

describe("the revoke limit (plan 12a)", () => {
  // The literals are the numbers that the README and the limits page promise.
  // So a change of the constant fails here, and the docs move with it.
  it("counts the revoke of one and of the others on one key per user: 30 per 15 minutes", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    const other = await verifiedSession(auth, EMAIL, "2.2.2.2");
    const bob = await verifiedSession(auth, "bob@example.com");
    for (let i = 0; i < 30; i++)
      expect((await revokeOtherSessions(auth.config, { session: me })).ok).toBe(true);
    // The revoke of one shares the key of the revoke of the others.
    expect(await revokeSession(auth.config, { session: me, id: other.session.id })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(await revokeOtherSessions(auth.config, { session: me })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    // Another user has a key of its own.
    expect((await revokeOtherSessions(auth.config, { session: bob })).ok).toBe(true);
    // 1 ms before the window of the first call ends, the key still refuses.
    auth.clock.advance(15 * 60_000 - 1);
    expect(await revokeOtherSessions(auth.config, { session: me })).toMatchObject({
      code: "rate_limited",
    });
    auth.clock.advance(1);
    expect((await revokeOtherSessions(auth.config, { session: me })).ok).toBe(true);
  });

  it("counts no try of a stale session on the revoke key", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    const other = await verifiedSession(auth, EMAIL, "2.2.2.2");
    const old = await stale(auth, me.token);
    // 31 refused calls of each flow: a thief's old cookie must not fill the owner's key (review M3).
    for (let i = 0; i < 31; i++) {
      expect(
        await revokeSession(auth.config, { session: old, id: other.session.id }),
      ).toMatchObject({ code: "session_not_fresh" });
      expect(await revokeOtherSessions(auth.config, { session: old })).toMatchObject({
        code: "session_not_fresh",
      });
    }
    const proof = { password: PASSWORD };
    expect((await reauthenticate(auth.config, { session: old, proof, ip: null })).ok).toBe(true);
    const again = await resolveSession(auth.config, me.token);
    if (!again) throw new Error("the session ended");
    expect(await revokeSession(auth.config, { session: again, id: other.session.id })).toEqual({
      ok: true,
      value: { current: false },
    });
    expect((await revokeOtherSessions(auth.config, { session: again })).ok).toBe(true);
  });

  it("counts every session of one user on the one user key", async () => {
    const auth = totpAuth();
    const a = await verifiedSession(auth);
    const b = await verifiedSession(auth, EMAIL, "2.2.2.2");
    const half = REVOKE_PER_USER.max / 2;
    // Each call with an unknown id counts one try and ends nothing.
    for (let i = 0; i < half; i++) {
      expect(await revokeSession(auth.config, { session: a, id: `none-a-${i}` })).toMatchObject({
        code: "not_found",
      });
      expect(await revokeSession(auth.config, { session: b, id: `none-b-${i}` })).toMatchObject({
        code: "not_found",
      });
    }
    expect(await revokeSession(auth.config, { session: a, id: b.session.id })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(await resolveSession(auth.config, b.token)).not.toBeNull();
  });
});

const OAUTH = { resources: [RESOURCE], scopes: SCOPES, registration: { cimd: false } };

/**
 * A user with every kind of access, each made through the product's own
 * calls. The kinds are the caller's session and a second session with a
 * trusted device, from a verify on another device. Then a challenge in
 * waiting, a handoff code, and an API token. Last, a refresh token and an
 * unspent OAuth code.
 */
async function stocked() {
  const ended: string[] = [];
  const base = makeAuth();
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: SECRET,
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    clock: base.clock,
    limiter: createMemoryLimiter(base.clock),
    mail: {
      send: async (m) => {
        base.mail.push(m);
      },
    },
    password: { hash: FAST, uniformSignUp: false },
    handoff: { schemes: ["example://"] },
    oauth: OAUTH,
    hooks: {
      session: {
        afterEnd: ({ session, reason }) => {
          ended.push(`${session.id}:${reason}`);
        },
      },
    },
  };
  const auth: Auth = { ...base, config: resolveConfig(input) };
  const h: Handle = {
    auth: createAuth(input),
    config: auth.config,
    storage: base.storage,
    clock: base.clock,
  };
  const { session: me, secret } = await enrolled(auth);
  const userId = me.user.id;
  // A sign-in on another device: the factor, with the trusted-device box ticked.
  const away = await passwordSignIn(auth.config, {
    email: EMAIL,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!away.ok || "token" in away.value) throw new Error("no challenge");
  const verified = await verifyTwoFactor(auth.config, {
    challenge: away.value.twoFactor.challenge,
    code: await codeNow(auth, secret),
    trustDevice: true,
    ip: null,
  });
  if (!verified.ok || !verified.value.trustDevice) throw new Error("no trusted device");
  const other = verified.value.session;
  // A second-factor challenge in waiting, from one more password sign-in.
  const pending = await passwordSignIn(auth.config, {
    email: EMAIL,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!pending.ok || "token" in pending.value) throw new Error("no challenge");
  // A handoff code in waiting.
  const start = await startHandoff(auth.config, {
    challenge: "a".repeat(43),
    redirect: "example://auth",
    ip: null,
  });
  if (!start.ok) throw new Error(start.code);
  const code = await continueHandoff(auth.config, {
    handoffId: start.value.handoffId,
    userId,
    sessionId: me.session.id,
  });
  if (!code.ok) throw new Error(code.code);
  const apiToken = await createApiToken(auth.config, { user: me.user, name: "ci" });
  if (!apiToken.ok) throw new Error(apiToken.code);
  // An OAuth client: one exchanged code (a refresh token) and one unspent code.
  const cookie = `${auth.config.cookieName}=${me.token}`;
  const clientId = await registered(h);
  const p = await pkce();
  const first = await authorized(h, cookie, {
    clientId,
    challenge: p.challenge,
    scope: "mcp:read offline_access",
  });
  const tokens = await h.auth.handle(exchange(first.code, clientId, p.verifier));
  if (tokens.status !== 200) throw new Error(`token answered ${tokens.status}`);
  await authorized(h, cookie, { clientId, challenge: p.challenge, scope: "mcp:read" });

  const purpose = (value: string) =>
    auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value },
      { field: "identifier", op: "eq", value: userId },
    ]);
  const byUser = { field: "userId", op: "eq", value: userId } as const;
  /** The rows of each kind of access, by kind. */
  async function access() {
    return {
      sessions: await ids(auth, userId),
      challenges: (await purpose("two-factor")).length,
      handoffCodes: (await purpose("handoff-code")).length,
      oauthCodes: (await purpose("oauth-code")).length,
      refreshTokens: (await auth.storage.findMany("oauthToken", [byUser])).length,
      trustedDevices: (await auth.storage.findMany("trustedDevice", [byUser])).length,
      apiTokens: (await auth.storage.findMany("apiToken", [byUser])).length,
    };
  }
  const before = await access();
  // Each kind exists before the end, so an assertion of zero after it means a
  // delete. The verify and the exchange mark their rows spent and keep them.
  // So two challenges and two OAuth codes exist: one spent, one in waiting.
  expect(before).toEqual({
    sessions: [me.session.id, other.id].sort(),
    challenges: 2,
    handoffCodes: 1,
    oauthCodes: 2,
    refreshTokens: 1,
    trustedDevices: 1,
    apiTokens: 1,
  });
  ended.length = 0;
  return { auth, me, other, ended, access };
}

describe("the revoke of the other sessions (plan 12a)", () => {
  it("ends the other sessions, the challenges, and the handoff codes, and keeps the caller, the trusted devices, the API tokens, and the OAuth tokens", async () => {
    const { auth, me, other, ended, access } = await stocked();
    expect(await revokeOtherSessions(auth.config, { session: me })).toEqual({
      ok: true,
      value: { ended: 1 },
    });
    expect(ended).toEqual([`${other.id}:revoked`]);
    expect(await access()).toEqual({
      sessions: [me.session.id],
      challenges: 0,
      handoffCodes: 0,
      oauthCodes: 2,
      refreshTokens: 1,
      trustedDevices: 1,
      apiTokens: 1,
    });
  });

  it("answers the count with no afterEnd hook too, where one statement deletes the rows", async () => {
    const auth = totpAuth();
    const user = await auth.seedUser("count@example.com");
    await open(auth, user.id, "1.1.1.1");
    await open(auth, user.id, "2.2.2.2");
    const me = await open(auth, user.id, "3.3.3.3");
    expect(await revokeOtherSessions(auth.config, { session: me })).toEqual({
      ok: true,
      value: { ended: 2 },
    });
    expect(await ids(auth, user.id)).toEqual([me.session.id]);
  });

  // An ended row that no read deleted yet: past its expiry, or past a cap
  // that the deployment turned on later. Both go, with no count and no hook (review L3).
  for (const end of ["expiry", "cap"] as const)
    it(`deletes a row past its ${end} with no revoked event and no count`, async () => {
      const { auth, ended } = listening();
      const config = end === "cap" ? cappedConfig(auth) : auth.config;
      const user = await auth.seedUser(`dead-${end}@example.com`);
      const dead = await open(auth, user.id, "1.1.1.1");
      auth.clock.advance(end === "cap" ? 2 * DAY : 31 * DAY);
      const other = await open(auth, user.id, "2.2.2.2");
      const me = await open(auth, user.id, "3.3.3.3");
      expect(await ids(auth, user.id)).toContain(dead.session.id);
      expect(await revokeOtherSessions(config, { session: me })).toEqual({
        ok: true,
        value: { ended: 1 },
      });
      expect(ended).toEqual([`${other.session.id}:revoked`]);
      expect(await ids(auth, user.id)).toEqual([me.session.id]);
    });

  // A row exactly at its edge is ended, so it goes with no count and no hook
  // (review round 2, M5). The text is the reviewer's.
  for (const end of ["expiry", "cap"] as const)
    it(`deletes a row exactly at its ${end} with no revoked event and no count`, async () => {
      const { auth, ended } = listening();
      const config = end === "cap" ? cappedConfig(auth) : auth.config;
      const user = await auth.seedUser(`edge-${end}@example.com`);
      const dead = await open(auth, user.id, "1.1.1.1");
      const other = await open(auth, user.id, "2.2.2.2");
      const edge =
        end === "cap" ? dead.session.createdAt.getTime() + DAY : dead.session.expiresAt.getTime();
      // `open` moves the clock 1 second first, so the caller's session opens at the edge.
      auth.clock.advance(edge - 1000 - auth.clock.now().getTime());
      const me = await open(auth, user.id, "3.3.3.3");
      expect(auth.clock.now().getTime()).toBe(edge);
      expect(await revokeOtherSessions(config, { session: me })).toEqual({
        ok: true,
        value: { ended: 1 },
      });
      expect(ended).toEqual([`${other.session.id}:revoked`]);
      expect(await ids(auth, user.id)).toEqual([me.session.id]);
    });

  it("serves the three routes with a session and answers 401 to a token", async () => {
    const auth = totpAuth();
    const me = await open(auth, (await auth.seedUser("routes@example.com")).id, "3.3.3.3");
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const bearer = { authorization: `Bearer ${me.token}` };
    const list = await handle(get("/auth/sessions", bearer));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { sessions: { id: string; createdAt: string }[] };
    expect(body.sessions.map((s) => s.id)).toEqual([me.session.id]);
    expect(body.sessions[0]?.createdAt).toBe(me.session.createdAt.toISOString());
    const others = await handle(post("/auth/sessions/revoke-others", {}, bearer));
    expect(await others.json()).toEqual({ ended: 0 });
    const tk = { authorization: `Bearer tk_${"a".repeat(43)}` };
    for (const req of [
      get("/auth/sessions", tk),
      post("/auth/sessions/revoke", { id: me.session.id }, tk),
      post("/auth/sessions/revoke-others", {}, tk),
      get("/auth/sessions"),
    ]) {
      const res = await handle(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(await resolveSession(auth.config, me.token)).not.toBeNull();
  });

  it("answers each error row of the revoke routes", async () => {
    const auth = totpAuth();
    const user = await auth.seedUser("errors@example.com");
    const me = await open(auth, user.id, "1.1.1.1");
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const bearer = { authorization: `Bearer ${me.token}` };
    const answer = async (req: Request) => {
      const res = await handle(req);
      return { status: res.status, body: await res.json() };
    };
    for (const body of [{}, { id: "" }, { id: "x".repeat(65) }, { id: me.session.id, extra: 1 }])
      expect(await answer(post("/auth/sessions/revoke", body, bearer))).toEqual({
        status: 400,
        body: { error: "invalid_body" },
      });
    expect(await answer(post("/auth/sessions/revoke", { id: "unknown" }, bearer))).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    for (let i = 1; i < REVOKE_PER_USER.max; i++)
      await handle(post("/auth/sessions/revoke-others", {}, bearer));
    expect(await answer(post("/auth/sessions/revoke", { id: "unknown" }, bearer))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    expect(await answer(post("/auth/sessions/revoke-others", {}, bearer))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    // A day on, the window has passed and the session is no longer fresh.
    auth.clock.advance(DAY);
    expect(await answer(post("/auth/sessions/revoke", { id: "unknown" }, bearer))).toEqual({
      status: 403,
      body: { error: "session_not_fresh" },
    });
    expect(await answer(post("/auth/sessions/revoke-others", {}, bearer))).toEqual({
      status: 403,
      body: { error: "session_not_fresh" },
    });
  });

  it("sends the renewed cookie when the list read slides the expiry", async () => {
    const auth = totpAuth();
    const me = await open(auth, (await auth.seedUser("slide@example.com")).id, "1.1.1.1");
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    auth.clock.advance(auth.config.session.slidingRefreshDays * DAY);
    const res = await handle(
      get("/auth/sessions", { cookie: `${auth.config.cookieName}=${me.token}` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).toContain(
      `${auth.config.cookieName}=${me.token};`,
    );
  });
});

describe("the renewed cookie of the revoke routes (plan 12a)", () => {
  it("sends the renewed cookie on the two revoke routes", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    const other = await verifiedSession(auth, EMAIL, "2.2.2.2");
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const proof = { password: PASSWORD };
    const renewed = `${auth.config.cookieName}=${me.token};`;
    auth.clock.advance(auth.config.session.slidingRefreshDays * DAY);
    expect((await reauthenticate(auth.config, { session: me, proof, ip: null })).ok).toBe(true);
    const cookie = { cookie: `${auth.config.cookieName}=${me.token}` };
    const one = await handle(post("/auth/sessions/revoke", { id: other.session.id }, cookie));
    expect(one.status).toBe(200);
    expect(one.headers.getSetCookie().join("\n")).toContain(renewed);
    auth.clock.advance(auth.config.session.slidingRefreshDays * DAY);
    expect((await reauthenticate(auth.config, { session: me, proof, ip: null })).ok).toBe(true);
    const others = await handle(post("/auth/sessions/revoke-others", {}, cookie));
    expect(others.status).toBe(200);
    expect(others.headers.getSetCookie().join("\n")).toContain(renewed);
  });
});

describe("api.session (plan 12a)", () => {
  it("serves list, revoke, and revokeOthers on the engine calls", async () => {
    const base = makeAuth();
    const input: AuthConfig = {
      baseURL: BASE_URL,
      secret: SECRET,
      trustedOrigins: [APP_ORIGIN],
      storage: base.storage,
      clock: base.clock,
      mail: { send: async () => {} },
    };
    const api = createAuth(input).api;
    const config = resolveConfig(input);
    const user = await base.seedUser("api@example.com");
    const opened = async () => {
      base.clock.advance(1000);
      const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
      const s = await api.getSession(token);
      if (!s) throw new Error("no session");
      return s;
    };
    const [a, b, c] = [await opened(), await opened(), await opened()];
    const listed = await api.session.list({ session: c });
    if (!listed.ok) throw new Error(listed.code);
    expect(listed.value.map((s) => [s.id, s.current])).toEqual([
      [c.session.id, true],
      [b.session.id, false],
      [a.session.id, false],
    ]);
    expect(await api.session.revoke({ session: c, id: a.session.id })).toEqual({
      ok: true,
      value: { current: false },
    });
    expect(await api.session.revokeOthers({ session: c })).toEqual({
      ok: true,
      value: { ended: 1 },
    });
    expect(await ids({ ...base, config }, user.id)).toEqual([c.session.id]);
  });
});

describe("endOtherAccess (plan 12a)", () => {
  it("ends the other sessions, the challenges, the handoff codes, the refresh tokens, and the OAuth codes, and keeps the caller, the trusted devices, and the API tokens", async () => {
    const { auth, me, other, access } = await stocked();
    const ended: NonNullable<Parameters<typeof endOtherAccess>[3]> = [];
    expect(
      await auth.storage.transaction((tx) => endOtherAccess(tx, me.user.id, me.session.id, ended)),
    ).toBe(1);
    expect(ended.map((s) => s.id)).toEqual([other.id]);
    expect(await access()).toEqual({
      sessions: [me.session.id],
      challenges: 0,
      handoffCodes: 0,
      oauthCodes: 0,
      refreshTokens: 0,
      trustedDevices: 1,
      apiTokens: 1,
    });
  });

  it("is the end of a password change: the same rows go, with reason password_change", async () => {
    const { auth, me, other, ended, access } = await stocked();
    expect(
      await changePassword(auth.config, {
        session: me,
        currentPassword: PASSWORD,
        newPassword: "a new long password",
      }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(ended).toEqual([`${other.id}:password_change`]);
    expect(await access()).toEqual({
      sessions: [me.session.id],
      challenges: 0,
      handoffCodes: 0,
      oauthCodes: 0,
      refreshTokens: 0,
      trustedDevices: 1,
      apiTokens: 1,
    });
  });
});
