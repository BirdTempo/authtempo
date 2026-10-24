import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { markFresh } from "../src/engine/fresh.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { defaultNoticeMail, type NoticeMailInput } from "../src/engine/notices.js";
import {
  createSession,
  destroySession,
  endSessions,
  type ResolvedSession,
  resolveSession,
} from "../src/engine/sessions.js";
import { completeSocial, startLink, startSocial } from "../src/engine/social.js";
import { draftUserRow } from "../src/engine/users.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { BASE_URL, post } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import {
  APPLE,
  type FakeIdToken,
  fakeFetch,
  fakeJwt,
  googleClaims,
  googleSignIn,
  socialAuth,
  stateRow,
} from "./social-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

const DAY = 86_400_000;
// The default names (plan 12b): the session cookie, and the binding cookie of the social flow.
const COOKIE = "__Host-tempo_session";
const BIND = "__Secure-tempo_session_oauth";
const NOTICE = "Security notice for your api.example.com account";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The social world of these tests. The token endpoint answers the ID token
 * `idtok-<code>`, and `idtok-default` for the code `c` of `googleSignIn`.
 * So parallel callbacks with their own codes get their own claims.
 */
function world(extra: Partial<AuthConfig> = {}) {
  const jwtTokens: Record<string, FakeIdToken> = {};
  const { fetchFn, calls: tokenCalls } = fakeFetch((call) =>
    Response.json({
      id_token: call.form.code === "c" ? "idtok-default" : `idtok-${call.form.code}`,
      access_token: "at",
      token_type: "Bearer",
    }),
  );
  const auth = socialAuth(
    {
      password: { hash: FAST, uniformSignUp: false },
      social: {
        google: { clientId: "gid", clientSecret: "gsecret" },
        apple: APPLE,
        fetch: fetchFn,
      },
      ...extra,
    },
    fakeJwt(jwtTokens),
  );
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const notices = () => auth.mail.filter((m) => m.subject === NOTICE);
  return { auth, jwtTokens, handle, notices, tokenCalls };
}
type World = ReturnType<typeof world>;
type Session = ResolvedSession & { token: string };

/** A link start for `session`, as a settings page sends it. */
async function begin(w: World, session: ResolvedSession, provider = "google") {
  const r = await startLink(w.auth.config, { provider, session, next: "/settings", ip: "1.1.1.1" });
  if (!r.ok) throw new Error(`link start failed: ${r.code}`);
  const url = new URL(r.value.location);
  return {
    state: url.searchParams.get("state"),
    nonce: url.searchParams.get("nonce") ?? "",
    bindToken: r.value.bindToken,
  };
}
type Begun = Awaited<ReturnType<typeof begin>>;

/** The callback of a started link, with the provider's `claims` for the code `code`. */
function finish(
  w: World,
  s: Begun,
  sessionToken: string | null,
  claims: Record<string, unknown> = {},
  options: { code?: string; provider?: string; ip?: string | null } = {},
) {
  const code = options.code ?? "c";
  w.jwtTokens[code === "c" ? "idtok-default" : `idtok-${code}`] = googleClaims(s.nonce, claims);
  return completeSocial(w.auth.config, {
    provider: options.provider ?? "google",
    state: s.state,
    code,
    error: null,
    bindToken: s.bindToken,
    sessionToken,
    ip: options.ip ?? null,
    userAgent: null,
  });
}

/** A start and its callback, from the browser of `session`. */
async function link(w: World, session: Session, claims: Record<string, unknown> = {}) {
  return finish(w, await begin(w, session), session.token, claims);
}

async function googleOf(w: World, userId: string) {
  return w.auth.storage.findMany("identity", [
    { field: "userId", op: "eq", value: userId },
    { field: "provider", op: "eq", value: "google" },
  ]);
}

async function sessionIds(w: World, userId: string) {
  const rows = await w.auth.storage.findMany("session", [
    { field: "userId", op: "eq", value: userId },
  ]);
  return rows.map((s) => s.id).sort();
}

/** Records the identity hooks as `<point>:<via>:<provider>:<subject>:<user id>`. */
function linkHooks(events: string[]): NonNullable<AuthConfig["hooks"]> {
  const note =
    (point: string) =>
    (e: { user: { id: string }; identity: { provider: string; subject: string }; via: string }) =>
      void events.push(
        `${point}:${e.via}:${e.identity.provider}:${e.identity.subject}:${e.user.id}`,
      );
  return { identity: { beforeLink: note("before"), afterLink: note("after") } };
}

describe("the link of a social identity (plan 12a, spec 8.15)", () => {
  it("links a provider account with the same verified address, fires the hooks with via link, sends the notice, and opens no session", async () => {
    const events: string[] = [];
    const w = world({ hooks: linkHooks(events) });
    const me = await verifiedSession(w.auth);
    const before = await sessionIds(w, me.user.id);
    const s = await begin(w, me);
    const r = await finish(w, s, me.token, {}, { ip: "203.0.113.7" });
    expect(r).toMatchObject({
      ok: true,
      value: { linked: true, next: "/settings", user: { id: me.user.id } },
    });
    expect((await googleOf(w, me.user.id)).map((i) => i.subject)).toEqual(["g-1"]);
    expect(events).toEqual([
      `before:link:google:g-1:${me.user.id}`,
      `after:link:google:g-1:${me.user.id}`,
    ]);
    expect(w.notices().map((m) => [m.to, m.text.split("\n").slice(0, 2)])).toEqual([
      [
        "ada@example.com",
        ["A sign-in provider was linked to your account.", "The provider is google."],
      ],
    ]);
    expect(w.notices()[0]?.text).toContain("IP address: 203.0.113.7.");
    expect(await sessionIds(w, me.user.id)).toEqual(before);
    // A second link of the same provider account answers a success and writes nothing.
    expect(await link(w, me)).toMatchObject({ ok: true, value: { linked: true } });
    expect(await googleOf(w, me.user.id)).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(w.notices()).toHaveLength(1);
  });

  it("links a provider address that differs from the account's address only in case", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    expect(await link(w, me, { email: "ADA@Example.COM" })).toMatchObject({
      ok: true,
      value: { linked: true },
    });
    expect(await googleOf(w, me.user.id)).toHaveLength(1);
  });

  it.each([
    ["an address that differs", { email: "other@example.com" }, "email_mismatch"],
    ["an address that the provider did not verify", { email_verified: false }, "email_mismatch"],
    ["no address", { email: undefined }, "email_required"],
  ])("refuses %s, runs no hook, and sends no notice", async (_what, claims, code) => {
    const events: string[] = [];
    const w = world({ hooks: linkHooks(events) });
    const me = await verifiedSession(w.auth);
    expect(await link(w, me, claims)).toMatchObject({ ok: false, code });
    expect(await googleOf(w, me.user.id)).toEqual([]);
    expect(events).toEqual([]);
    expect(w.notices()).toEqual([]);
  });

  it("answers identity_taken for a provider account of another user, and moves nothing", async () => {
    const events: string[] = [];
    const w = world({ hooks: linkHooks(events) });
    const bob = await googleSignIn(w.auth, w.jwtTokens, { email: "bob@example.com" });
    events.length = 0;
    const me = await verifiedSession(w.auth);
    expect(await link(w, me)).toEqual({ ok: false, code: "identity_taken", status: 409 });
    // The held identity answers before the address checks: a mismatched address too.
    expect(await link(w, me, { email: "other@example.com" })).toEqual({
      ok: false,
      code: "identity_taken",
      status: 409,
    });
    expect((await googleOf(w, bob.user.id)).map((i) => i.subject)).toEqual(["g-1"]);
    expect(await googleOf(w, me.user.id)).toEqual([]);
    expect(events).toEqual([]);
    expect(w.notices()).toEqual([]);
  });

  it("refuses a callback that carries the session cookie of another account", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    expect(await finish(w, await begin(w, me), bob.token)).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(await googleOf(w, me.user.id)).toEqual([]);
    expect(await googleOf(w, bob.user.id)).toEqual([]);
  });

  it("refuses a GET callback that carries no session cookie", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    expect(await finish(w, await begin(w, me), null)).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(await googleOf(w, me.user.id)).toEqual([]);
  });

  /** Apple's form post: cross-site, so a browser sends no Lax session cookie with it. */
  async function appleLink(w: World, me: Session) {
    const s = await begin(w, me, "apple");
    w.jwtTokens["idtok-default"] = {
      audience: APPLE.clientId,
      issuer: "https://appleid.apple.com",
      claims: { sub: "001.a", email: me.user.email, email_verified: "true", nonce: s.nonce },
    };
    return completeSocial(w.auth.config, {
      provider: "apple",
      state: s.state,
      code: "c",
      error: null,
      bindToken: s.bindToken,
      sessionToken: null,
      ip: null,
      userAgent: null,
    });
  }

  it("links at Apple's form post with no session cookie while the session cookie is Lax", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    expect(await appleLink(w, me)).toMatchObject({ ok: true, value: { linked: true } });
    const apple = await w.auth.storage.findMany("identity", [
      { field: "userId", op: "eq", value: me.user.id },
      { field: "provider", op: "eq", value: "apple" },
    ]);
    expect(apple.map((i) => i.subject)).toEqual(["001.a"]);
  });

  it("refuses Apple's form post with no session cookie while the session cookie is SameSite=None", async () => {
    const w = world({ cookie: { sameSite: "None" } });
    const me = await verifiedSession(w.auth);
    expect(await appleLink(w, me)).toMatchObject({ ok: false, code: "invalid_token" });
  });

  it("ends the link when the session ends during the provider step", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const s = await begin(w, me);
    await w.auth.storage.transaction((tx) =>
      endSessions(
        tx,
        [
          { field: "userId", op: "eq", value: me.user.id },
          { field: "id", op: "eq", value: me.session.id },
        ],
        null,
        w.auth.clock.now(),
        null,
      ),
    );
    const calls = w.tokenCalls.length;
    expect(await finish(w, s, me.token)).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await googleOf(w, me.user.id)).toEqual([]);
    // The session check runs before the code exchange: no token call.
    expect(w.tokenCalls.length).toBe(calls);
  });

  it("ends the link when the absolute cap ends the session during the provider step", async () => {
    // The row was written before the operator set `absoluteDays`, so its
    // `expiresAt` is later than the cap (plan 12b). The cap ends it.
    const w = world();
    const me = await verifiedSession(w.auth);
    const capped = world({
      storage: w.auth.config.storage,
      clock: w.auth.clock,
      session: { absoluteDays: 1 },
    });
    w.auth.clock.advance(DAY - 5 * 60_000);
    const live = await resolveSession(capped.auth.config, me.token);
    if (!live) throw new Error("the session ended");
    const s = await begin(capped, live);
    w.auth.clock.advance(6 * 60_000);
    expect(live.session.expiresAt.getTime()).toBeGreaterThan(w.auth.clock.now().getTime());
    expect(await finish(capped, s, me.token)).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await googleOf(w, me.user.id)).toEqual([]);
  });

  it("undoes the link when the session ends inside the link's transaction", async () => {
    // The hook runs after the session read and before the last statement,
    // so a sign-out from the hook lands in the window of a parallel sign-out.
    const events: string[] = [];
    let token = "";
    const w = world({
      hooks: {
        identity: {
          beforeLink: async () => {
            events.push("before");
            await destroySession(w.auth.config, token);
          },
          afterLink: () => void events.push("after"),
        },
      },
    });
    const me = await verifiedSession(w.auth);
    token = me.token;
    expect(await link(w, me)).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await googleOf(w, me.user.id)).toEqual([]);
    expect(events).toEqual(["before"]);
    expect(w.notices()).toEqual([]);
  });

  it("spends the state once: a replayed callback answers invalid_token and links nothing more", async () => {
    const events: string[] = [];
    const w = world({ hooks: linkHooks(events) });
    const me = await verifiedSession(w.auth);
    const s = await begin(w, me);
    expect(await finish(w, s, me.token)).toMatchObject({ ok: true, value: { linked: true } });
    // A second use of a spent state would meet the linked row and answer linked.
    expect(await finish(w, s, me.token)).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await googleOf(w, me.user.id)).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(w.notices()).toHaveLength(1);
  });

  it("keeps a link state and a sign-in state apart", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const s = await begin(w, me);
    expect(await stateRow(w.auth.storage, s.state ?? "")).toMatchObject({
      purpose: "oauth-link-state",
      data: { link: { userId: me.user.id, sessionId: me.session.id } },
    });
    // A sign-in state in a browser signed in as `me`: the callback signs the
    // provider's user in and links nothing to `me`.
    const signIn = await startSocial(w.auth.config, {
      provider: "google",
      next: "/home",
      ip: null,
    });
    if (!signIn.ok) throw new Error(signIn.code);
    const url = new URL(signIn.value.location);
    const row = await stateRow(w.auth.storage, url.searchParams.get("state") ?? "");
    expect(row).toMatchObject({ purpose: "oauth-state" });
    expect(row?.data).not.toHaveProperty("link");
    const signed = await finish(
      w,
      {
        state: url.searchParams.get("state"),
        nonce: url.searchParams.get("nonce") ?? "",
        bindToken: signIn.value.bindToken,
      },
      me.token,
      { sub: "g-new", email: "new@example.com" },
    );
    expect(signed).toMatchObject({ ok: true, value: { token: expect.any(String) } });
    expect(signed.ok && signed.value.user.email).toBe("new@example.com");
    expect(await googleOf(w, me.user.id)).toEqual([]);
  });

  it("refuses the start for an unverified user, a stale session, and an unknown provider, and counts no try", async () => {
    const w = world();
    const claimant = await googleSignIn(w.auth, w.jwtTokens, {
      sub: "g-9",
      email: "claim@example.com",
      email_verified: false,
    });
    const me = await verifiedSession(w.auth);
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    expect(
      await startLink(w.auth.config, { provider: "google", session: claimant, ip: null }),
    ).toEqual({ ok: false, code: "email_unverified", status: 403 });
    expect(await startLink(w.auth.config, { provider: "acme", session: me, ip: null })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    w.auth.clock.advance(DAY);
    const old = await resolveSession(w.auth.config, me.token);
    if (!old) throw new Error("the session ended");
    expect(await startLink(w.auth.config, { provider: "google", session: old, ip: null })).toEqual({
      ok: false,
      code: "session_not_fresh",
      status: 403,
    });
    expect(allow).not.toHaveBeenCalled();
  });

  it("refuses a link for a user with no address, and writes no identity (plan 12i, ruling 18)", async () => {
    const w = world();
    // The user row of plan 12i Task 1: no address, so no verified address.
    // No route takes an address away, so the draft is the only such user.
    const lone = await w.auth.storage.create(
      "user",
      draftUserRow({ email: null, emailVerified: false, name: null }, w.auth.clock.now()),
    );
    const { token } = await createSession(w.auth.config, {
      userId: lone.id,
      ip: null,
      userAgent: null,
    });
    const session = await resolveSession(w.auth.config, token);
    if (!session) throw new Error("no session");
    const states = async () => (await w.auth.storage.findMany("verification", [])).length;
    const before = await states();
    // The start refuses first. The callback is the second guard: a provider
    // address never equals a null address, so it answers email_mismatch.
    expect(await startLink(w.auth.config, { provider: "google", session, ip: null })).toEqual({
      ok: false,
      code: "email_unverified",
      status: 403,
    });
    expect(await states()).toBe(before);
    expect(
      await w.auth.storage.findMany("identity", [{ field: "userId", op: "eq", value: lone.id }]),
    ).toEqual([]);
  });

  it("allows 10 link starts per user in 15 minutes, on a key of its own, after the IP key", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    const tryOne = (s: ResolvedSession, ip = "1.1.1.1") =>
      startLink(w.auth.config, { provider: "google", session: s, ip });
    expect(await tryOne(me)).toMatchObject({ ok: true });
    expect(allow.mock.calls).toEqual([
      ["social-start:ip:1.1.1.1", { seconds: 900, max: 30 }],
      [`social-link:user:${me.user.id}`, { seconds: 900, max: 10 }],
    ]);
    // Another IP for each try: the user key alone holds the count.
    for (let i = 2; i <= 10; i++)
      expect(await tryOne(me, `1.1.1.${i}`)).toMatchObject({ ok: true });
    expect(await tryOne(me, "2.2.2.2")).toEqual({ ok: false, code: "rate_limited", status: 429 });
    expect(allow).toHaveBeenLastCalledWith(`social-link:user:${me.user.id}`, {
      seconds: 900,
      max: 10,
    });
    // Another user has a key of its own, and a sign-in start counts on no user key.
    expect(await tryOne(bob, "2.2.2.2")).toMatchObject({ ok: true });
    expect(await startSocial(w.auth.config, { provider: "google", ip: "2.2.2.2" })).toMatchObject({
      ok: true,
    });
    // 1 ms before the window of the first try ends, the key still refuses.
    w.auth.clock.advance(15 * 60_000 - 1);
    const s1 = await resolveSession(w.auth.config, me.token);
    if (!s1) throw new Error("no session");
    expect(await tryOne(s1, "3.3.3.3")).toMatchObject({ code: "rate_limited" });
    w.auth.clock.advance(1);
    const s2 = await resolveSession(w.auth.config, me.token);
    if (!s2) throw new Error("no session");
    expect(await tryOne(s2, "3.3.3.3")).toMatchObject({ ok: true });
  });

  it("refuses the start while the IP key is full, and counts nothing on the user key", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    for (let i = 0; i < 30; i++)
      expect(await startSocial(w.auth.config, { provider: "google", ip: "4.4.4.4" })).toMatchObject(
        { ok: true },
      );
    const allow = vi.spyOn(w.auth.config.limiter, "allow");
    expect(
      await startLink(w.auth.config, { provider: "google", session: me, ip: "4.4.4.4" }),
    ).toMatchObject({ code: "rate_limited" });
    expect(allow.mock.calls.map((c) => c[0])).toEqual(["social-start:ip:4.4.4.4"]);
  });

  it("answers hook_refused for a beforeLink refusal, and links nothing", async () => {
    const w = world({
      hooks: {
        identity: {
          beforeLink: () => {
            throw hookRefusal("Links are closed.");
          },
        },
      },
    });
    const me = await verifiedSession(w.auth);
    expect(await link(w, me)).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "Links are closed.",
    });
    expect(await googleOf(w, me.user.id)).toEqual([]);
    expect(w.notices()).toEqual([]);
  });

  it("answers hook_failed for a beforeLink throw with one log line that holds no address", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({
      hooks: {
        identity: {
          beforeLink: (e) => {
            throw new TypeError(`no ${e.user.email}`);
          },
        },
      },
    });
    const me = await verifiedSession(w.auth);
    expect(await link(w, me)).toMatchObject({ ok: false, code: "hook_failed", status: 500 });
    expect(log.mock.calls).toEqual([
      ["authtempo: before hook failed", "identity.beforeLink", "TypeError"],
    ]);
    expect(await googleOf(w, me.user.id)).toEqual([]);
  });

  it("keeps the link when afterLink throws, and logs the user id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({
      hooks: {
        identity: {
          afterLink: () => {
            throw new Error("down");
          },
        },
      },
    });
    const me = await verifiedSession(w.auth);
    expect(await link(w, me)).toMatchObject({ ok: true, value: { linked: true } });
    expect(log.mock.calls).toEqual([
      ["authtempo: after hook failed", "identity.afterLink", me.user.id, "Error"],
    ]);
    expect(await googleOf(w, me.user.id)).toHaveLength(1);
    expect(w.notices()).toHaveLength(1);
  });
});

/**
 * Holds the first two identity reads of the engine's store until both wait
 * (the wrap of `tracked` in notices.test.ts). So both checks pass before
 * either write, the order that Postgres gives two parallel callbacks.
 */
function meetAtIdentityRead(w: World) {
  const store = w.auth.config.storage as StorageAdapter;
  const findOne = store.findOne.bind(store);
  const held: (() => void)[] = [];
  let seen = 0;
  (store as { findOne: StorageAdapter["findOne"] }).findOne = (async (model, where) => {
    if (model === "identity" && seen < 2) {
      seen++;
      await new Promise<void>((go) => {
        held.push(go);
        if (held.length === 2) for (const release of held) release();
      });
    }
    return findOne(model, where);
  }) as StorageAdapter["findOne"];
}

describe("parallel links on memory (plan 12a)", () => {
  it("two callbacks of two link states of one user at once: both answer linked, and one identity, afterLink, and notice", async () => {
    const events: string[] = [];
    const w = world({ hooks: linkHooks(events) });
    const me = await verifiedSession(w.auth);
    const one = await begin(w, me);
    const two = await begin(w, me);
    meetAtIdentityRead(w);
    const answers = await Promise.all([
      finish(w, one, me.token, {}, { code: "one" }),
      finish(w, two, me.token, {}, { code: "two" }),
    ]);
    expect(answers.map((a) => (a.ok ? "linked" in a.value : a.code))).toEqual([true, true]);
    expect(await googleOf(w, me.user.id)).toHaveLength(1);
    // Both checks passed before either write, so both before hooks ran (the second write failed).
    expect(events.filter((e) => e.startsWith("before:"))).toHaveLength(2);
    expect(events.filter((e) => e.startsWith("after:"))).toHaveLength(1);
    expect(w.notices()).toHaveLength(1);
  });

  it("two users link one provider account at once: one links, and the other answers identity_taken", async () => {
    // The provider moved the account's address between the two
    // authorizations, so each callback carries its own user's address.
    // Both checks pass, so the identity's unique key decides.
    const events: string[] = [];
    const w = world({ hooks: linkHooks(events) });
    const ada = await verifiedSession(w.auth);
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const a = await begin(w, ada);
    const b = await begin(w, bob);
    meetAtIdentityRead(w);
    const answers = await Promise.all([
      finish(w, a, ada.token, {}, { code: "a" }),
      finish(w, b, bob.token, { email: "bob@example.com" }, { code: "b" }),
    ]);
    expect(answers.map((x) => (x.ok ? "linked" : x.code)).sort()).toEqual([
      "identity_taken",
      "linked",
    ]);
    const held = [...(await googleOf(w, ada.user.id)), ...(await googleOf(w, bob.user.id))];
    expect(held).toHaveLength(1);
    const winner = answers[0]?.ok ? ada : bob;
    expect(held[0]?.userId).toBe(winner.user.id);
    expect(events.filter((e) => e.startsWith("after:"))).toEqual([
      `after:link:google:g-1:${winner.user.id}`,
    ]);
    expect(w.notices().map((m) => m.to)).toEqual([winner.user.email]);
  });
});

describe("the link routes (plan 12a)", () => {
  const cookie = (token: string, bind?: string) => ({
    cookie: bind ? `${COOKIE}=${token}; ${BIND}=${bind}` : `${COOKIE}=${token}`,
  });
  const bindOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => new RegExp(`^${BIND}=([^;]+)`).exec(c)?.[1])
      .find((v) => v !== undefined);

  async function callback(w: World, url: string, headers: Record<string, string>, claims = {}) {
    const authorize = new URL(url);
    w.jwtTokens["idtok-default"] = googleClaims(authorize.searchParams.get("nonce") ?? "", claims);
    const state = authorize.searchParams.get("state") ?? "";
    return w.handle(
      new Request(`${BASE_URL}/auth/social/google/callback?state=${state}&code=c`, { headers }),
    );
  }

  it("serves the start as JSON and the callback as a redirect with no session cookie", async () => {
    const captured: NoticeMailInput[] = [];
    const w = world({
      account: {
        notices: {
          mail: (i) => {
            captured.push(i);
            return defaultNoticeMail(i);
          },
        },
      },
    });
    const me = await verifiedSession(w.auth);
    const start = await w.handle(
      post("/auth/social/google/link", { next: "/settings" }, cookie(me.token)),
    );
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    expect(new URL(url).origin).toBe("https://accounts.google.com");
    const binding = start.headers.getSetCookie().find((c) => c.startsWith(`${BIND}=`));
    expect(binding).toMatch(/; Path=\/auth\/social; Max-Age=600; HttpOnly; Secure; SameSite=None$/);
    const done = await callback(w, url, {
      ...cookie(me.token, bindOf(start)),
      "cf-connecting-ip": "198.51.100.4",
      "user-agent": "Browser/1",
    });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${BASE_URL}/settings`);
    const cookies = done.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${COOKIE}=`))).toBe(false);
    expect(cookies).toContain(
      `${BIND}=; Path=/auth/social; Max-Age=0; HttpOnly; Secure; SameSite=None`,
    );
    expect((await googleOf(w, me.user.id)).map((i) => i.subject)).toEqual(["g-1"]);
    expect(captured).toMatchObject([
      {
        event: "identity_linked",
        provider: "google",
        ip: "198.51.100.4",
        userAgent: "Browser/1",
      },
    ]);
  });

  it("serves a form start as a 303 to the provider, and a refused form start as a redirect", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const form = (body: string, token: string) =>
      w.handle(
        new Request(`${BASE_URL}/auth/social/google/link`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://app.example.com",
            ...cookie(token),
          },
          body,
        }),
      );
    const started = await form("next=%2Fsettings&submit=Link", me.token);
    expect(started.status).toBe(303);
    expect(new URL(started.headers.get("location") ?? "").origin).toBe(
      "https://accounts.google.com",
    );
    expect(bindOf(started)).toEqual(expect.any(String));
    // A repeated field is a client bug: the form lands on the error page.
    const bad = await form("next=%2Fa&next=%2Fb", me.token);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_body`);
    w.auth.clock.advance(DAY);
    const stale = await form("next=%2Fsettings", me.token);
    expect(stale.headers.get("location")).toBe(`${BASE_URL}/?auth_error=session_not_fresh`);
    expect(bindOf(stale)).toBeUndefined();
  });

  it("answers 401 with no session, and the JSON errors of the start", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const send = (body: unknown, headers: Record<string, string> = cookie(me.token)) =>
      w.handle(post("/auth/social/google/link", body, headers));
    const none = await send({ next: "/settings" }, {});
    expect([none.status, await none.json()]).toEqual([401, { error: "unauthorized" }]);
    const bearer = await send({}, { authorization: `Bearer ${me.token}` });
    expect(bearer.status).toBe(200);
    for (const body of [{ next: 1 }, { next: "x".repeat(2049) }]) {
      const res = await send(body);
      expect([res.status, await res.json()]).toEqual([400, { error: "invalid_body" }]);
    }
    w.auth.clock.advance(DAY);
    const stale = await send({});
    expect([stale.status, await stale.json()]).toEqual([403, { error: "session_not_fresh" }]);
  });

  it("sends the renewed session cookie on the start", async () => {
    const w = world({ session: { slidingRefreshDays: 1 } });
    const me = await verifiedSession(w.auth);
    // A day on, a re-authentication makes the session fresh. The next read
    // moves the expiry and renews the cookie.
    w.auth.clock.advance(DAY);
    expect((await markFresh(w.auth.config, me.session.id)).ok).toBe(true);
    const res = await w.handle(post("/auth/social/google/link", {}, cookie(me.token)));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=${me.token};`))).toBe(
      true,
    );
  });

  it("refuses a GET callback that carries a bearer header and no session cookie", async () => {
    // A bearer must not stand in for the cookie: a provider's redirect carries none.
    const w = world();
    const me = await verifiedSession(w.auth);
    const start = await w.handle(post("/auth/social/google/link", {}, cookie(me.token)));
    const { url } = (await start.json()) as { url: string };
    const done = await callback(w, url, {
      cookie: `${BIND}=${bindOf(start)}`,
      authorization: `Bearer ${me.token}`,
    });
    expect(done.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    expect(await googleOf(w, me.user.id)).toEqual([]);
  });

  it("redirects a refused link callback to auth_error, and clears the binding cookie as a sign-in does", async () => {
    const w = world();
    await googleSignIn(w.auth, w.jwtTokens, { email: "bob@example.com" });
    const me = await verifiedSession(w.auth);
    const start = await w.handle(post("/auth/social/google/link", {}, cookie(me.token)));
    const { url } = (await start.json()) as { url: string };
    const taken = await callback(w, url, cookie(me.token, bindOf(start)));
    expect(taken.headers.get("location")).toBe(`${BASE_URL}/?auth_error=identity_taken`);
    expect(taken.headers.getSetCookie()).toEqual([
      `${BIND}=; Path=/auth/social; Max-Age=0; HttpOnly; Secure; SameSite=None`,
    ]);
    // With no session cookie the state is spent, and the browser's binding cookie stays.
    const again = await w.handle(post("/auth/social/google/link", {}, cookie(me.token)));
    const next = (await again.json()) as { url: string };
    const noSession = await callback(w, next.url, { cookie: `${BIND}=${bindOf(again)}` });
    expect(noSession.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    expect(noSession.headers.getSetCookie()).toEqual([]);
    expect(await googleOf(w, me.user.id)).toEqual([]);
  });
});

describe("api.startLink (plan 12a)", () => {
  it("serves the link start on the engine call", async () => {
    const { createAuth } = await import("../src/create-auth.js");
    const w = world();
    const me = await verifiedSession(w.auth);
    const api = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: w.auth.storage,
      clock: w.auth.clock,
      mail: { send: async () => {} },
      social: { google: { clientId: "gid", clientSecret: "gsecret" } },
    }).api;
    const r = await api.startLink({ provider: "google", session: me, ip: null });
    if (!r.ok) throw new Error(r.code);
    const state = new URL(r.value.location).searchParams.get("state") ?? "";
    expect(await stateRow(w.auth.storage, state)).toMatchObject({
      purpose: "oauth-link-state",
      data: { link: { userId: me.user.id, sessionId: me.session.id } },
    });
  });
});
