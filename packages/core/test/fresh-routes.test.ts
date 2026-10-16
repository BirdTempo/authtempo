import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/create-auth.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { changePassword } from "../src/engine/password.js";
import { enableEmailMethod } from "../src/engine/second-factor-methods.js";
import { type ResolvedSession, resolveSession } from "../src/engine/sessions.js";
import { enableTotp, setupTotp } from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { base32Decode } from "../src/primitives/totp.js";
import { type ModelName, schema, type UserRow } from "../src/schema.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { post } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { type FakeIdToken, fakeJwt, googleSignIn, socialAuth } from "./social-helpers.js";
import { codeNow, EMAIL, PASSWORD, verifiedSession } from "./totp-helpers.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
const PASSKEY = {
  rpID: "api.example.com",
  rpName: "Example",
  origins: ["https://api.example.com"],
};
const NEW_PASSWORD = "a new horse battery";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Password, passkey, TOTP (on by default with a password), and Google. The
 * fresh window is 10 minutes, so a TOTP setup (15 minutes) outlives it.
 * `{ passkey: false }` leaves the passkey config out.
 */
function world(opts: { passkey?: boolean } = {}) {
  const jwtTokens: Record<string, FakeIdToken> = {};
  const auth = socialAuth(
    {
      password: { hash: FAST, uniformSignUp: false },
      ...(opts.passkey === false ? {} : { passkey: PASSKEY }),
      session: { freshMinutes: 10 },
    },
    fakeJwt(jwtTokens),
  );
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const cookie = (token: string) => ({ cookie: `${auth.config.cookieName}=${token}` });
  return { auth, jwtTokens, handle, cookie };
}
type World = ReturnType<typeof world>;
type Me = ResolvedSession & { token: string };

/** The age at which a sign-in of `world()` is stale: the window of 10 minutes, as a literal. */
const STALE = 10 * MINUTE;

async function soft() {
  return SoftAuthenticator.create({ rpID: PASSKEY.rpID, origin: PASSKEY.origins[0] ?? "" });
}

/** A passkey of the user by the register ceremony. Its id, and the authenticator for later assertions. */
async function addPasskey(w: World, user: UserRow) {
  const authenticator = await soft();
  const options = await passkeyRegistrationOptions(w.auth.config, { user });
  if (!options.ok) throw new Error(options.code);
  const added = await verifyPasskeyRegistration(w.auth.config, {
    user,
    response: await authenticator.register(
      options.value.challenge,
      new TextEncoder().encode(user.id),
    ),
  });
  if (!added.ok) throw new Error(added.code);
  return { id: added.value.id, authenticator };
}

/** The TOTP method on, through the engine. The backup codes, for a later re-authentication. */
async function totpOn(w: World, me: Me) {
  const setup = await setupTotp(w.auth.config, { userId: me.user.id, password: PASSWORD });
  if (!setup.ok) throw new Error(setup.code);
  const secret = base32Decode(setup.value.secret);
  const on = await enableTotp(w.auth.config, {
    session: me,
    code: await codeNow(w.auth, secret),
  });
  if (!on.ok) throw new Error(on.code);
  // The next code is of a new step.
  w.auth.clock.advance(30_000);
  return { secret, backupCodes: setup.value.backupCodes };
}

/** The email method on, through the engine. */
async function emailOn(w: World, me: Me) {
  const on = await enableEmailMethod(w.auth.config, { session: me, password: PASSWORD });
  if (!on.ok) throw new Error(on.code);
  return { backupCodes: on.value.backupCodes };
}

/** Every row of every model but the sessions (a read may renew a session). */
async function rows(w: World) {
  const all: Record<string, unknown> = {};
  for (const m of Object.keys(schema) as ModelName[])
    if (m !== "session") all[m] = await w.auth.storage.findMany(m, []);
  return all;
}

interface Case {
  path: string;
  /** The state the change needs, made while the sign-in is fresh. */
  setup(w: World, me: Me): Promise<{ backupCode?: string; body: () => Promise<unknown> }>;
  /** The status of the same change after a re-authentication. */
  after: number;
}

const firstOf = (codes: string[]) => {
  const c = codes[0];
  if (!c) throw new Error("no backup code");
  return c;
};

const CASES: Case[] = [
  {
    path: "/passkey/register/options",
    setup: async () => ({ body: async () => ({}) }),
    after: 200,
  },
  {
    path: "/passkeys/delete",
    setup: async (w, me) => {
      const pk = await addPasskey(w, me.user);
      return { body: async () => ({ id: pk.id }) };
    },
    after: 200,
  },
  {
    path: "/tokens",
    setup: async () => ({ body: async () => ({ name: "stolen" }) }),
    after: 200,
  },
  {
    path: "/totp/enable",
    setup: async (w, me) => {
      const setup = await setupTotp(w.auth.config, { userId: me.user.id, password: PASSWORD });
      if (!setup.ok) throw new Error(setup.code);
      const secret = base32Decode(setup.value.secret);
      return { body: async () => ({ code: await codeNow(w.auth, secret) }) };
    },
    after: 200,
  },
  {
    path: "/totp/disable",
    setup: async (w, me) => {
      const on = await totpOn(w, me);
      return {
        backupCode: firstOf(on.backupCodes),
        body: async () => ({ code: await codeNow(w.auth, on.secret) }),
      };
    },
    after: 200,
  },
  {
    path: "/second-factor/passkey/enable",
    setup: async (w, me) => {
      const pk = await addPasskey(w, me.user);
      return {
        body: async () => {
          const options = await passkeyAuthenticationOptions(w.auth.config, { ip: null });
          if (!options.ok) throw new Error(options.code);
          return {
            password: PASSWORD,
            response: await pk.authenticator.authenticate(options.value.challenge),
          };
        },
      };
    },
    after: 200,
  },
  {
    path: "/second-factor/email/enable",
    setup: async () => ({ body: async () => ({ password: PASSWORD }) }),
    after: 200,
  },
  {
    path: "/second-factor/disable",
    setup: async (w, me) => {
      const on = await emailOn(w, me);
      return {
        backupCode: firstOf(on.backupCodes),
        body: async () => ({ method: "email", password: PASSWORD }),
      };
    },
    after: 200,
  },
  {
    // A user with the factor on: the password proves one factor only.
    path: "/password/change",
    setup: async (w, me) => {
      const on = await emailOn(w, me);
      return {
        backupCode: firstOf(on.backupCodes),
        body: async () => ({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      };
    },
    after: 200,
  },
];

describe("the fresh rule on the routes of other sections (plan 12a, ASVS 5.0.0 7.5.1)", () => {
  it.each(CASES)(
    "POST $path: a stale session answers session_not_fresh, counts no try, opens no transaction, and changes no row",
    async (c) => {
      const w = world();
      const me = await verifiedSession(w.auth);
      const made = await c.setup(w, me);
      w.auth.clock.advance(STALE);
      const body = await made.body();
      const before = await rows(w);
      const allow = vi.spyOn(w.auth.config.limiter, "allow");
      const transaction = vi.spyOn(w.auth.config.storage, "transaction");
      const res = await w.handle(post(`/auth${c.path}`, body, w.cookie(me.token)));
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 403,
        body: { error: "session_not_fresh" },
      });
      expect(allow).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(await rows(w)).toEqual(before);
      vi.restoreAllMocks();

      // The owner proves it again, and the same token passes the rule.
      const proof =
        made.backupCode === undefined
          ? { password: PASSWORD }
          : { password: PASSWORD, code: made.backupCode };
      const reauth = await w.handle(post("/auth/reauth", proof, w.cookie(me.token)));
      expect(reauth.status).toBe(200);
      const again = await w.handle(post(`/auth${c.path}`, await made.body(), w.cookie(me.token)));
      expect(again.status, JSON.stringify(await again.clone().json())).toBe(c.after);
    },
  );

  it.each(CASES)("POST $path: the refusal carries the renewed session cookie", async (c) => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const made = await c.setup(w, me);
    // Past the sliding refresh (7 days by default): the read renews the cookie.
    w.auth.clock.advance(7 * DAY);
    const res = await w.handle(post(`/auth${c.path}`, await made.body(), w.cookie(me.token)));
    expect(res.status).toBe(403);
    expect(
      res.headers
        .getSetCookie()
        .some((v) => v.startsWith(`${w.auth.config.cookieName}=${me.token};`)),
    ).toBe(true);
  });

  it("refuses every lockout change from a stale session, and a re-authentication lets them pass the rule", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    w.auth.clock.advance(STALE);
    const other = await verifiedSession(w.auth);
    w.auth.clock.advance(STALE);
    const lockout: readonly [string, Record<string, unknown>][] = [
      ["/user/change-email", { newEmail: "thief@example.com" }],
      ["/social/google/link", {}],
      ["/tokens", { name: "stolen" }],
      ["/passkey/register/options", {}],
      ["/passkeys/delete", { id: "pk-1" }],
      ["/totp/enable", { code: "123456" }],
      ["/totp/disable", { code: "123456" }],
      ["/second-factor/passkey/enable", { password: PASSWORD, response: {} }],
      ["/second-factor/email/enable", { password: PASSWORD }],
      ["/second-factor/disable", { method: "email", password: PASSWORD }],
      ["/sessions/revoke", { id: other.session.id }],
      ["/sessions/revoke-others", {}],
      ["/identities/unlink", { id: "i-1" }],
      ["/user/delete", {}],
    ];
    for (const [path, body] of lockout) {
      const res = await w.handle(post(`/auth${path}`, body, w.cookie(me.token)));
      expect({ path, status: res.status, body: await res.json() }).toEqual({
        path,
        status: 403,
        body: { error: "session_not_fresh" },
      });
    }
    const reauth = await w.handle(post("/auth/reauth", { password: PASSWORD }, w.cookie(me.token)));
    expect(reauth.status).toBe(200);
    const options = await w.handle(post("/auth/passkey/register/options", {}, w.cookie(me.token)));
    expect(options.status).toBe(200);
  });

  it("checks the passkey config before the rule: the passkey enable answers not_found to a stale session", async () => {
    const w = world({ passkey: false });
    const me = await verifiedSession(w.auth);
    w.auth.clock.advance(STALE);
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    const res = await w.handle(
      post(
        "/auth/second-factor/passkey/enable",
        { password: PASSWORD, response: {} },
        w.cookie(me.token),
      ),
    );
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect(allow).not.toHaveBeenCalled();
  });
});

describe("the fresh rule in the password change (plan 12a)", () => {
  it("lets a stale session change a password with the current password while no factor is on", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    w.auth.clock.advance(STALE);
    const old = await resolveSession(w.auth.config, me.token);
    if (!old) throw new Error("the session ended");
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    expect(
      await changePassword(w.auth.config, {
        session: old,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(allow).toHaveBeenCalledWith(`password-change:user:${me.user.id}`, expect.anything());
  });

  it("refuses a stale session while the second factor is on, counts no try, and keeps the hash", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    await totpOn(w, me);
    w.auth.clock.advance(STALE);
    const old = await resolveSession(w.auth.config, me.token);
    if (!old) throw new Error("the session ended");
    const before = await w.auth.storage.findMany("password", []);
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    expect(
      await changePassword(w.auth.config, {
        session: old,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    ).toEqual({ ok: false, code: "session_not_fresh", status: 403 });
    expect(allow).not.toHaveBeenCalled();
    expect(await w.auth.storage.findMany("password", [])).toEqual(before);
  });

  it("refuses a first password from a stale session, counts no try, and takes it from a fresh one", async () => {
    const w = world();
    const s = await googleSignIn(w.auth, w.jwtTokens);
    expect(s.user.email).toBe(EMAIL);
    w.auth.clock.advance(STALE);
    const old = await resolveSession(w.auth.config, s.token);
    if (!old) throw new Error("the session ended");
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    expect(
      await changePassword(w.auth.config, { session: old, newPassword: NEW_PASSWORD }),
    ).toEqual({ ok: false, code: "session_not_fresh", status: 403 });
    expect(allow).not.toHaveBeenCalled();
    expect(await w.auth.storage.findMany("password", [])).toEqual([]);
    vi.restoreAllMocks();
    const fresh = await googleSignIn(w.auth, w.jwtTokens);
    expect(
      await changePassword(w.auth.config, { session: fresh, newPassword: NEW_PASSWORD }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(await w.auth.storage.findMany("password", [])).toHaveLength(1);
  });
});

describe("the in-process calls (plan 12a deviation 4)", () => {
  /** The `api` over the world's store and clock. */
  function apiOf(w: World) {
    return createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: w.auth.storage,
      clock: w.auth.clock,
      mail: { send: async () => {} },
      password: { hash: FAST, uniformSignUp: false },
      passkey: PASSKEY,
      session: { freshMinutes: 10 },
    }).api;
  }

  it("the calls that take a user apply no fresh rule: the app calls api.session.requireFresh first", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const pk = await addPasskey(w, me.user);
    const on = await totpOn(w, me);
    w.auth.clock.advance(STALE);
    const api = apiOf(w);
    const old = await api.getSession(me.token);
    if (!old) throw new Error("the session ended");
    expect(api.session.requireFresh(old)).toEqual({
      ok: false,
      code: "session_not_fresh",
      status: 403,
    });
    expect((await api.passkeyRegistrationOptions({ user: old.user })).ok).toBe(true);
    expect(await api.deletePasskey({ user: old.user, id: pk.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect((await api.tokens.create({ user: old.user, name: "script" })).ok).toBe(true);
    const totp = api.totp;
    if (!totp) throw new Error("no totp api");
    expect(
      await totp.disableWithCode({ user: old.user, code: await codeNow(w.auth, on.secret) }),
    ).toEqual({ ok: true, value: { ok: true } });
  });

  it("the calls that take a session apply the rule: api.totp.enable and api.password.change", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const setup = await setupTotp(w.auth.config, { userId: me.user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    w.auth.clock.advance(STALE);
    const api = apiOf(w);
    const old = await api.getSession(me.token);
    if (!old) throw new Error("the session ended");
    const totp = api.totp;
    const password = api.password;
    if (!totp || !password) throw new Error("no totp or password api");
    const secret = base32Decode(setup.value.secret);
    expect(await totp.enable({ session: old, code: await codeNow(w.auth, secret) })).toEqual({
      ok: false,
      code: "session_not_fresh",
      status: 403,
    });
    // A first password needs a fresh session too.
    const s = await googleSignIn(w.auth, w.jwtTokens, { email: "bob@example.com" });
    w.auth.clock.advance(STALE);
    const bob = await api.getSession(s.token);
    if (!bob) throw new Error("the session ended");
    expect(await password.change({ session: bob, newPassword: NEW_PASSWORD })).toEqual({
      ok: false,
      code: "session_not_fresh",
      status: 403,
    });
  });
});
