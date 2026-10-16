import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "../src/config.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { listIdentities, unlinkIdentity } from "../src/engine/identities.js";
import type { NoticeMailInput } from "../src/engine/notices.js";
import {
  deletePasskey,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { reauthenticate } from "../src/engine/reauth.js";
import { type ResolvedSession, resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { get, post } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { type FakeIdToken, fakeJwt, googleSignIn, socialAuth } from "./social-helpers.js";
import { PASSWORD, verifiedSession } from "./totp-helpers.js";

const DAY = 86_400_000;
const PASSKEY = {
  rpID: "api.example.com",
  rpName: "Example",
  origins: ["https://api.example.com"],
};
const SUBJECT = "Security notice for your api.example.com account";

afterEach(() => {
  vi.restoreAllMocks();
});

function world(extra: NonNullable<Parameters<typeof socialAuth>[0]> = {}) {
  const jwtTokens: Record<string, FakeIdToken> = {};
  const auth = socialAuth(
    { passkey: PASSKEY, password: { hash: FAST, uniformSignUp: false }, ...extra },
    fakeJwt(jwtTokens),
  );
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const cookie = (token: string) => ({ cookie: `${auth.config.cookieName}=${token}` });
  return { auth, jwtTokens, handle, cookie };
}
type World = ReturnType<typeof world>;

/** A passkey by the register ceremony, as a settings page adds one. */
async function addPasskey(auth: World["auth"], user: UserRow) {
  const soft = await SoftAuthenticator.create({
    rpID: PASSKEY.rpID,
    origin: PASSKEY.origins[0] ?? "",
  });
  const options = await passkeyRegistrationOptions(auth.config, { user });
  if (!options.ok) throw new Error(options.code);
  const added = await verifyPasskeyRegistration(auth.config, {
    user,
    response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
  });
  if (!added.ok) throw new Error(added.code);
  return added.value.id;
}

async function identityOf(auth: World["auth"], userId: string, provider: string) {
  const row = (
    await auth.storage.findMany("identity", [
      { field: "userId", op: "eq", value: userId },
      { field: "provider", op: "eq", value: provider },
    ])
  )[0];
  if (!row) throw new Error(`no ${provider} identity`);
  return row;
}

async function userRow(auth: World["auth"], id: string): Promise<UserRow> {
  const row = await auth.storage.findOne("user", [{ field: "id", op: "eq", value: id }]);
  if (!row) throw new Error("no user");
  return row;
}

const notices = (mail: MailMessage[]) => mail.filter((m) => m.subject === SUBJECT);

/** An unverified user of a Google sign-in: the provider did not prove the address, so the identity is the one way in (spec 8.3). */
const claimant = (w: World, claims: Record<string, unknown> = {}) =>
  googleSignIn(w.auth, w.jwtTokens, { email_verified: false, ...claims });

/**
 * Runs `write` before the next `times` user-row writes inside a
 * transaction, outside it, as a parallel request on D1 lands there.
 */
function beforeUserWrite(w: World, write: () => Promise<unknown>, times = 1) {
  const store = w.auth.config.storage as StorageAdapter;
  const original = store.transaction.bind(store);
  let left = times;
  (store as { transaction: StorageAdapter["transaction"] }).transaction = ((fn) =>
    original((tx) =>
      fn(
        new Proxy(tx, {
          get(target, key, receiver) {
            if (key !== "update") return Reflect.get(target, key, receiver);
            const update: StorageAdapter["update"] = async (model, where, data) => {
              if (model === "user" && left > 0) {
                left--;
                await write();
              }
              return target.update(model, where, data);
            };
            return update;
          },
        }),
      ),
    )) as StorageAdapter["transaction"];
}

describe("the identity list (plan 12a)", () => {
  it("lists the provider and the email identities with no subject, and the email identity cannot be unlinked", async () => {
    const w = world();
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const r = await listIdentities(w.auth.config, { session: me });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.password).toBe(false);
    expect(r.value.passkeys).toBe(0);
    const google = await identityOf(w.auth, me.user.id, "google");
    const email = await identityOf(w.auth, me.user.id, "email");
    expect(r.value.identities).toEqual(
      [
        { id: google.id, provider: "google", linkedAt: google.linkedAt, canUnlink: true },
        {
          id: email.id,
          provider: "email",
          email: "ada@example.com",
          linkedAt: email.linkedAt,
          canUnlink: false,
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(JSON.stringify(r.value)).not.toContain("g-1");
    const res = await w.handle(get("/auth/identities", w.cookie(me.token)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identities: { id: string; linkedAt: string }[] };
    expect(body).toEqual({
      identities: r.value.identities.map((i) => ({ ...i, linkedAt: i.linkedAt.toISOString() })),
      password: false,
      passkeys: 0,
    });
    expect(JSON.stringify(body)).not.toContain("g-1");
  });

  it("orders the identities by linkedAt, and counts the caller's password and passkeys only", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    w.auth.clock.advance(1000);
    const linked = await googleSignIn(w.auth, w.jwtTokens);
    expect(linked.user.id).toBe(me.user.id);
    await addPasskey(w.auth, me.user);
    await addPasskey(w.auth, me.user);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    await addPasskey(w.auth, bob.user);
    const r = await listIdentities(w.auth.config, { session: me });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.identities.map((i) => [i.provider, i.canUnlink])).toEqual([
      ["email", false],
      ["google", true],
    ]);
    expect(r.value.password).toBe(true);
    expect(r.value.passkeys).toBe(2);
    const forBob = await listIdentities(w.auth.config, { session: bob });
    expect(forBob.ok && [forBob.value.identities.length, forBob.value.passkeys]).toEqual([1, 1]);
  });

  it("marks the only identity of an unverified user as one it cannot unlink", async () => {
    const w = world();
    const me = await claimant(w);
    expect(me.user.emailVerified).toBe(false);
    expect(await listIdentities(w.auth.config, { session: me })).toEqual({
      ok: true,
      value: {
        identities: [
          {
            id: (await identityOf(w.auth, me.user.id, "google")).id,
            provider: "google",
            linkedAt: me.user.createdAt,
            canUnlink: false,
          },
        ],
        password: false,
        passkeys: 0,
      },
    });
  });

  it("answers 401 with no session, has no fresh rule, and sends the renewed cookie", async () => {
    const w = world();
    const me = await googleSignIn(w.auth, w.jwtTokens);
    expect((await w.handle(get("/auth/identities"))).status).toBe(401);
    w.auth.clock.advance(w.auth.config.session.slidingRefreshDays * DAY);
    const res = await w.handle(get("/auth/identities", w.cookie(me.token)));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).toContain(
      `${w.auth.config.cookieName}=${me.token};`,
    );
  });
});

describe("the unlink (plan 12a)", () => {
  it("unlinks a provider of a verified user, fires the identity hooks, and sends the notice", async () => {
    const events: { name: string; e: unknown }[] = [];
    const w = world({
      hooks: {
        identity: {
          beforeUnlink: (e) => void events.push({ name: "before", e }),
          afterUnlink: (e) => void events.push({ name: "after", e }),
        },
      },
    });
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    const email = await identityOf(w.auth, me.user.id, "email");
    w.auth.clock.advance(1000);
    const r = await unlinkIdentity(w.auth.config, {
      session: me,
      id: google.id,
      ip: "5.6.7.8",
      userAgent: "Agent/1",
    });
    expect(r).toEqual({ ok: true, value: { ok: true } });
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: google.id }]),
    ).toBeNull();
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: email.id }]),
    ).not.toBeNull();
    // The guard's lock moved updatedAt; both hooks get the row as stored.
    const stored = await userRow(w.auth, me.user.id);
    expect(stored.updatedAt.getTime()).toBe(w.auth.clock.now().getTime());
    const identity = { provider: "google", subject: "g-1" };
    expect(events).toEqual([
      { name: "before", e: { user: stored, identity } },
      { name: "after", e: { user: stored, identity } },
    ]);
    const sent = notices(w.auth.mail);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ada@example.com");
    expect(sent[0]?.text).toContain("A sign-in provider was removed from your account.");
    expect(sent[0]?.text).toContain("The provider is google.");
    expect(sent[0]?.text).toContain("5.6.7.8");
    // No session ends: the client offers the revoke of the others (ASVS 5.0.0 7.4.3).
    expect(await resolveSession(w.auth.config, me.token)).not.toBeNull();
  });

  it("gives the notice builder the event, the provider, the address, the IP, and the user agent", async () => {
    const built: NoticeMailInput[] = [];
    const w = world({
      account: {
        notices: {
          mail: (i) => {
            built.push(i);
            return { to: i.email, subject: "n", text: "n" };
          },
        },
      },
    });
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    const res = await w.handle(
      post(
        "/auth/identities/unlink",
        { id: google.id },
        { ...w.cookie(me.token), "cf-connecting-ip": "5.6.7.8", "user-agent": "Agent/2" },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(built).toEqual([
      {
        event: "identity_unlinked",
        email: "ada@example.com",
        provider: "google",
        ip: "5.6.7.8",
        userAgent: "Agent/2",
        appName: "api.example.com",
        at: w.auth.clock.now(),
      },
    ]);
  });

  it("keeps the only identity of an unverified user with last_credential, runs no hook, and sends no notice", async () => {
    const calls: string[] = [];
    const w = world({
      hooks: {
        identity: {
          beforeUnlink: () => void calls.push("before"),
          afterUnlink: () => void calls.push("after"),
        },
      },
    });
    const me = await claimant(w);
    const google = await identityOf(w.auth, me.user.id, "google");
    const before = await userRow(w.auth, me.user.id);
    w.auth.clock.advance(1000);
    expect(
      await unlinkIdentity(w.auth.config, {
        session: me,
        id: google.id,
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "last_credential", status: 409 });
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: google.id }]),
    ).not.toBeNull();
    // The refusal undoes the guard's lock too.
    expect(await userRow(w.auth, me.user.id)).toEqual(before);
    expect(calls).toEqual([]);
    expect(notices(w.auth.mail)).toEqual([]);
    const res = await w.handle(
      post("/auth/identities/unlink", { id: google.id }, w.cookie(me.token)),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "last_credential" });
  });

  it("counts a verified address as a way in: the user unlinks the last provider and signs in by mail", async () => {
    const w = world();
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    expect(
      (
        await unlinkIdentity(w.auth.config, {
          session: me,
          id: google.id,
          ip: null,
          userAgent: null,
        })
      ).ok,
    ).toBe(true);
    const left = await listIdentities(w.auth.config, { session: me });
    expect(left.ok && left.value.identities.map((i) => i.provider)).toEqual(["email"]);
  });

  it("refuses the email identity with invalid_body and runs no hook", async () => {
    const calls: string[] = [];
    const w = world({ hooks: { identity: { beforeUnlink: () => void calls.push("before") } } });
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const email = await identityOf(w.auth, me.user.id, "email");
    expect(
      await unlinkIdentity(w.auth.config, { session: me, id: email.id, ip: null, userAgent: null }),
    ).toEqual({ ok: false, code: "invalid_body", status: 400 });
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: email.id }]),
    ).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it("answers session_not_fresh to a stale session and counts no try, then passes after a re-authentication", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    w.auth.clock.advance(DAY);
    const stale = await resolveSession(w.auth.config, me.token);
    if (!stale) throw new Error("the session ended");
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    for (let i = 0; i < 11; i++)
      expect(
        await unlinkIdentity(w.auth.config, {
          session: stale,
          id: google.id,
          ip: null,
          userAgent: null,
        }),
      ).toEqual({ ok: false, code: "session_not_fresh", status: 403 });
    expect(allow).not.toHaveBeenCalled();
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: google.id }]),
    ).not.toBeNull();
    const proved = await reauthenticate(w.auth.config, {
      session: stale,
      proof: { password: PASSWORD },
      ip: null,
    });
    expect(proved.ok).toBe(true);
    const fresh = await resolveSession(w.auth.config, me.token);
    if (!fresh) throw new Error("the session ended");
    expect(
      (
        await unlinkIdentity(w.auth.config, {
          session: fresh,
          id: google.id,
          ip: null,
          userAgent: null,
        })
      ).ok,
    ).toBe(true);
  });

  it("keeps the row on a refusal or a throw of identity.beforeUnlink, and logs a throw in one line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let mode: "refuse" | "throw" = "refuse";
    const w = world({
      hooks: {
        identity: {
          beforeUnlink: () => {
            if (mode === "refuse") throw hookRefusal("Ask support.");
            throw new TypeError("ada@example.com g-1");
          },
        },
      },
    });
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    const before = await userRow(w.auth, me.user.id);
    w.auth.clock.advance(1000);
    const input = { session: me, id: google.id, ip: null, userAgent: null };
    expect(await unlinkIdentity(w.auth.config, input)).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "Ask support.",
    });
    expect(log).not.toHaveBeenCalled();
    mode = "throw";
    expect(await unlinkIdentity(w.auth.config, input)).toEqual({
      ok: false,
      code: "hook_failed",
      status: 500,
    });
    expect(log.mock.calls).toEqual([
      ["authtempo: before hook failed", "identity.beforeUnlink", "TypeError"],
    ]);
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: google.id }]),
    ).not.toBeNull();
    expect(await userRow(w.auth, me.user.id)).toEqual(before);
    expect(notices(w.auth.mail)).toEqual([]);
  });

  it("keeps the unlink and logs one line with the row id when identity.afterUnlink throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({
      hooks: {
        identity: {
          afterUnlink: () => {
            throw new RangeError("ada@example.com");
          },
        },
      },
    });
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    expect(
      await unlinkIdentity(w.auth.config, {
        session: me,
        id: google.id,
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(log.mock.calls).toEqual([
      ["authtempo: after hook failed", "identity.afterUnlink", google.id, "RangeError"],
    ]);
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: google.id }]),
    ).toBeNull();
    expect(notices(w.auth.mail)).toHaveLength(1);
  });

  it("answers an identity of another user as an unknown id: the same answer, the same reads, and no change", async () => {
    const w = world();
    const ada = await googleSignIn(w.auth, w.jwtTokens);
    const bob = await googleSignIn(w.auth, w.jwtTokens, { sub: "g-2", email: "bob@example.com" });
    const adas = await identityOf(w.auth, ada.user.id, "google");
    const store = w.auth.config.storage as StorageAdapter;
    const trace: string[] = [];
    for (const op of [
      "findOne",
      "findMany",
      "update",
      "delete",
      "create",
      "transaction",
    ] as const) {
      const original = store[op].bind(store) as (...a: unknown[]) => unknown;
      (store as unknown as Record<string, unknown>)[op] = (...a: unknown[]) => {
        trace.push(typeof a[0] === "string" ? `${op}:${a[0]}` : op);
        return original(...a);
      };
    }
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    const run = async (id: string) => {
      trace.length = 0;
      allow.mockClear();
      const answer = await unlinkIdentity(w.auth.config, {
        session: bob,
        id,
        ip: null,
        userAgent: null,
      });
      return { answer, trace: [...trace], keys: allow.mock.calls.map((c) => c[0]) };
    };
    const other = await run(adas.id);
    const unknown = await run("id-that-no-row-has");
    expect(other.answer).toEqual({ ok: false, code: "not_found", status: 404 });
    expect(other).toEqual(unknown);
    const viaRoute = async (id: string) => {
      const res = await w.handle(post("/auth/identities/unlink", { id }, w.cookie(bob.token)));
      return { status: res.status, body: await res.text() };
    };
    expect(await viaRoute(adas.id)).toEqual(await viaRoute("id-that-no-row-has"));
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: adas.id }]),
    ).not.toBeNull();
    expect(notices(w.auth.mail)).toEqual([]);
  });

  it("allows 10 unlinks per user in 15 minutes, on a key of its own per user", async () => {
    const w = world();
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const bob = await googleSignIn(w.auth, w.jwtTokens, { sub: "g-2", email: "bob@example.com" });
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    const tryOne = (s: ResolvedSession) =>
      unlinkIdentity(w.auth.config, { session: s, id: "missing", ip: null, userAgent: null });
    for (let i = 0; i < 10; i++) expect(await tryOne(me)).toMatchObject({ code: "not_found" });
    expect(await tryOne(me)).toEqual({ ok: false, code: "rate_limited", status: 429 });
    expect(allow).toHaveBeenLastCalledWith(`unlink:user:${me.user.id}`, { seconds: 900, max: 10 });
    // Another user has a key of its own.
    expect(await tryOne(bob)).toMatchObject({ code: "not_found" });
    // The limit refuses before the read: a real unlink is refused too.
    const google = await identityOf(w.auth, me.user.id, "google");
    expect(
      await unlinkIdentity(w.auth.config, {
        session: me,
        id: google.id,
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ code: "rate_limited" });
    // 1 ms before the window of the first call ends, the key still refuses.
    w.auth.clock.advance(15 * 60_000 - 1);
    const s1 = await resolveSession(w.auth.config, me.token);
    if (!s1) throw new Error("no session");
    expect(await tryOne(s1)).toMatchObject({ code: "rate_limited" });
    w.auth.clock.advance(1);
    const s2 = await resolveSession(w.auth.config, me.token);
    if (!s2) throw new Error("no session");
    expect(await tryOne(s2)).toMatchObject({ code: "not_found" });
  });

  it("serves every error row of the unlink route", async () => {
    const w = world();
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    const email = await identityOf(w.auth, me.user.id, "email");
    const send = (body: unknown, headers: Record<string, string> = w.cookie(me.token)) =>
      w.handle(post("/auth/identities/unlink", body, headers));
    expect((await send({ id: google.id }, {})).status).toBe(401);
    for (const body of [
      {},
      { id: "" },
      { id: "x".repeat(65) },
      { id: 1 },
      { id: google.id, extra: 1 },
    ]) {
      const res = await send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    }
    const emailRes = await send({ id: email.id });
    expect([emailRes.status, await emailRes.json()]).toEqual([400, { error: "invalid_body" }]);
    const missing = await send({ id: "missing" });
    expect([missing.status, await missing.json()]).toEqual([404, { error: "not_found" }]);
    w.auth.clock.advance(DAY);
    const stale = await send({ id: google.id });
    expect([stale.status, await stale.json()]).toEqual([403, { error: "session_not_fresh" }]);
  });

  it("sends the renewed cookie on the unlink, and on a refused body", async () => {
    const w = world();
    const me = await googleSignIn(w.auth, w.jwtTokens);
    w.auth.clock.advance(w.auth.config.session.slidingRefreshDays * DAY);
    const bad = await w.handle(post("/auth/identities/unlink", { nope: 1 }, w.cookie(me.token)));
    expect(bad.status).toBe(400);
    expect(bad.headers.getSetCookie().join("\n")).toContain(
      `${w.auth.config.cookieName}=${me.token};`,
    );
    w.auth.clock.advance(w.auth.config.session.slidingRefreshDays * DAY);
    const res = await w.handle(
      post("/auth/identities/unlink", { id: "missing" }, w.cookie(me.token)),
    );
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie().join("\n")).toContain(
      `${w.auth.config.cookieName}=${me.token};`,
    );
  });
});

describe("the guard's lock on memory (plan 12a)", () => {
  it("reads the row again when a write lands between its read and its lock, and gives the hooks the new row", async () => {
    const seen: UserRow[] = [];
    const w = world({
      hooks: {
        identity: {
          beforeUnlink: (e) => void seen.push(e.user),
          afterUnlink: (e) => void seen.push(e.user),
        },
      },
    });
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    // The social fill writes the name with updatedAt now: the same millisecond.
    beforeUserWrite(w, () =>
      w.auth.storage.update("user", [{ field: "id", op: "eq", value: me.user.id }], {
        name: "Parallel",
        updatedAt: w.auth.clock.now(),
      }),
    );
    expect(
      await unlinkIdentity(w.auth.config, {
        session: me,
        id: google.id,
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: true, value: { ok: true } });
    const stored = await userRow(w.auth, me.user.id);
    expect(stored.name).toBe("Parallel");
    expect(seen).toEqual([stored, stored]);
  });

  it("answers conflict after 5 lost rounds, removes nothing, runs no hook, and logs the user id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const w = world({ hooks: { identity: { beforeUnlink: () => void calls.push("before") } } });
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    let n = 0;
    beforeUserWrite(
      w,
      () =>
        w.auth.storage.update("user", [{ field: "id", op: "eq", value: me.user.id }], {
          name: `Parallel ${n++}`,
          updatedAt: w.auth.clock.now(),
        }),
      5,
    );
    expect(
      await unlinkIdentity(w.auth.config, {
        session: me,
        id: google.id,
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "conflict", status: 409 });
    expect(n).toBe(5);
    expect(log.mock.calls).toEqual([["authtempo: credential removal gave up", me.user.id]]);
    expect(calls).toEqual([]);
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: google.id }]),
    ).not.toBeNull();
  });

  it("answers not_found when the user row goes between the read and the lock", async () => {
    const w = world();
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    beforeUserWrite(w, () =>
      w.auth.storage.delete("user", [{ field: "id", op: "eq", value: me.user.id }]),
    );
    expect(
      await unlinkIdentity(w.auth.config, {
        session: me,
        id: google.id,
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "not_found", status: 404 });
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: google.id }]),
    ).not.toBeNull();
  });

  it("two unlinks of one identity at once: one wins, the other answers not_found, and the hooks and the notice run once", async () => {
    const calls: string[] = [];
    const w = world({
      hooks: {
        identity: {
          beforeUnlink: () => void calls.push("before"),
          afterUnlink: () => void calls.push("after"),
        },
      },
    });
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const google = await identityOf(w.auth, me.user.id, "google");
    const input = { session: me, id: google.id, ip: null, userAgent: null };
    const answers = await Promise.all([
      unlinkIdentity(w.auth.config, input),
      unlinkIdentity(w.auth.config, input),
    ]);
    expect(answers.map((a) => (a.ok ? "ok" : a.code)).sort()).toEqual(["not_found", "ok"]);
    expect(calls).toEqual(["before", "after"]);
    expect(notices(w.auth.mail)).toHaveLength(1);
  });
});

describe("the passkey delete through the guard (plan 12a)", () => {
  it("moves the user row's updatedAt and sends the notice to the address of the row it held", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const id = await addPasskey(w.auth, me.user);
    w.auth.clock.advance(1000);
    expect(await deletePasskey(w.auth.config, { user: me.user, id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect((await userRow(w.auth, me.user.id)).updatedAt).toEqual(w.auth.clock.now());
    const sent = notices(w.auth.mail);
    expect(sent.map((m) => [m.to, m.text.split("\n")[0]])).toEqual([
      ["ada@example.com", "A passkey was added to your account."],
      ["ada@example.com", "A passkey was removed from your account."],
    ]);
    // A delete that finds no passkey changes no row and sends no notice.
    const before = await userRow(w.auth, me.user.id);
    w.auth.clock.advance(1000);
    expect(await deletePasskey(w.auth.config, { user: me.user, id })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    expect(await userRow(w.auth, me.user.id)).toEqual(before);
    expect(notices(w.auth.mail)).toHaveLength(2);
  });
});

describe("api.identities (plan 12a)", () => {
  it("serves list and unlink on the engine calls", async () => {
    const { createAuth } = await import("../src/create-auth.js");
    const w = world();
    const me = await googleSignIn(w.auth, w.jwtTokens);
    const api = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: w.auth.storage,
      clock: w.auth.clock,
      mail: { send: async () => {} },
      social: { google: { clientId: "gid", clientSecret: "gsecret" } },
    }).api;
    const listed = await api.identities.list({ session: me });
    expect(listed).toEqual(await listIdentities(w.auth.config, { session: me }));
    const google = await identityOf(w.auth, me.user.id, "google");
    expect(
      await api.identities.unlink({ session: me, id: google.id, ip: null, userAgent: null }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(
      await w.auth.storage.findOne("identity", [{ field: "id", op: "eq", value: google.id }]),
    ).toBeNull();
  });
});
