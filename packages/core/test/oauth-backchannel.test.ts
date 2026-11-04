import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { deleteAccount } from "../src/engine/account-delete.js";
import { confirmEmailChange, requestEmailChange } from "../src/engine/email-change.js";
import { publicKeySet } from "../src/engine/jwt.js";
import { createClient } from "../src/engine/oauth-client-store.js";
import { DEVICE_GRANT, fetchCimd } from "../src/engine/oauth-clients.js";
import { deliverLogouts, linkIdToken } from "../src/engine/oauth-logout.js";
import { banUser } from "../src/engine/operator/ban.js";
import { changePassword, requestPasswordReset, resetPassword } from "../src/engine/password.js";
import { enableEmailMethod } from "../src/engine/second-factor-methods.js";
import { revokeOtherSessions, revokeSession } from "../src/engine/session-list.js";
import { createSession, endSessions, type ResolvedSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { enableTotp, setupTotp } from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { base32Decode } from "../src/primitives/totp.js";
import type { OAuthLogoutRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, LONG_TEST_MS, post, tokenFromMail } from "./helpers.js";
import {
  authorizeGet,
  consentPost,
  exchange,
  ISSUER,
  pkce,
  REDIRECT,
  RESOURCE,
  requestIdOf,
  SCOPES,
  tokenPost,
} from "./oauth-helpers.js";
import { FAST } from "./password-helpers.js";
import { codeNow, EMAIL, PASSWORD, totpAuth, verifiedSession } from "./totp-helpers.js";

/**
 * OIDC Back-Channel Logout 1.0 (final, errata set 1, 15 December 2023;
 * read 2026-10-20), plan 12e Task 16. Each flow that ends a session writes
 * one outbox row per linked client. After its commit it delivers the user's
 * due rows. The sweep retries the rest.
 */

const BC = "https://client.example.com/backchannel";
const BC2 = "https://other.example.com/backchannel";
const BYE = "https://client.example.com/bye";
const EVENT = "http://schemas.openid.net/event/backchannel-logout";
const MINUTE = 60_000;

/**
 * One turn of the event loop, with no timer: the fake timers of a test do
 * not move it. Core's typecheck has no Node types, because core runs on
 * Workers; vitest runs in Node.
 */
const nextTurn = (globalThis as unknown as { setImmediate: (fn: (v?: unknown) => void) => void })
  .setImmediate;

afterEach(() => {
  vi.restoreAllMocks();
});

/** One request that the fake `oauth.fetch` got. */
interface Call {
  url: string;
  method: string | undefined;
  type: string | null;
  body: string;
  redirect: RequestRedirect | undefined;
  signal: boolean;
  /** The session ids that the storage held when the request left: the commit came first. */
  sessionsAtSend: string[];
}

/**
 * The engine view and the routes, with a fake `oauth.fetch` that records
 * each request and answers the status of `status` for its URL (default 200).
 * No test reaches a network.
 */
function world(opts: { noFetch?: boolean; cimd?: boolean; extra?: Partial<AuthConfig> } = {}) {
  const calls: Call[] = [];
  const status = new Map<string, number>();
  /** A whole answer for one URL, in place of the status. */
  const answer = new Map<string, (init: RequestInit | undefined) => Promise<Response>>();
  let storage: StorageAdapter | null = null;
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const sessions = storage ? await storage.findMany("session", []) : [];
    calls.push({
      url: String(url),
      method: init?.method,
      type: new Headers(init?.headers).get("content-type"),
      body: typeof init?.body === "string" ? init.body : "",
      redirect: init?.redirect,
      signal: init?.signal instanceof AbortSignal,
      sessionsAtSend: sessions.map((s) => s.id),
    });
    const custom = answer.get(String(url));
    if (custom) return custom(init);
    return new Response(null, { status: status.get(String(url)) ?? 200 });
  };
  const oauth = {
    resources: [RESOURCE],
    scopes: SCOPES,
    registration: { cimd: opts.cimd === true, dynamic: true },
    device: {},
    ...(opts.noFetch ? {} : { fetch: fetchFn as typeof fetch }),
  };
  const auth = totpAuth({ oauth, ...opts.extra });
  storage = auth.storage;
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  // A second instance of the same app, on the same storage and clock.
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: auth.storage,
    clock: auth.clock,
    mail: {
      send: async (m) => {
        auth.mail.push(m);
      },
    },
    password: { hash: FAST, uniformSignUp: false },
    oauth,
  };
  const { api } = createAuth(input);
  return { auth, handle, api, input, second: resolveConfig(input), calls, status, answer };
}
type World = ReturnType<typeof world>;

const cookieOf = (w: World, token: string) => `${w.auth.config.cookieName}=${token}`;

/** A client of the register route with a back-channel logout URI. */
async function bcClient(w: World, uri: string | null, extra: Record<string, unknown> = {}) {
  const res = await w.handle(
    post("/auth/oauth/register", {
      redirect_uris: [REDIRECT],
      post_logout_redirect_uris: [BYE],
      ...(uri !== null ? { backchannel_logout_uri: uri } : {}),
      ...extra,
    }),
  );
  if (res.status !== 201) throw new Error(`register answered ${res.status}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The token answer of the authorize step and the code exchange for the session of `token`. */
async function tokensOf(
  w: World,
  token: string,
  clientId: string,
  scope = "openid mcp:read",
  redirectUri = REDIRECT,
) {
  const p = await pkce();
  const cookie = cookieOf(w, token);
  const page = await w.handle(
    authorizeGet({ clientId, challenge: p.challenge, scope, nonce: "n-1", redirectUri }, cookie),
  );
  // A consent that covers the scopes already answers the redirect at once.
  const done =
    page.status === 200
      ? await w.handle(
          consentPost(
            { request_id: requestIdOf(await page.text()), decision: "allow" },
            { cookie },
          ),
        )
      : page;
  const code = new URL(done.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error(`authorize answered ${page.status} with no code`);
  const res = await w.handle(exchange(code, clientId, p.verifier, { redirect_uri: redirectUri }));
  if (res.status !== 200) throw new Error(`the exchange answered ${res.status}`);
  return (await res.json()) as { id_token?: string; refresh_token?: string };
}

const linksOf = (w: World, sessionId: string) =>
  w.auth.storage.findMany("oauthSessionClient", [
    { field: "sessionId", op: "eq", value: sessionId },
  ]);
const outbox = (w: World): Promise<OAuthLogoutRow[]> => w.auth.storage.findMany("oauthLogout", []);
const live = async (w: World, sessionId: string) =>
  (await w.auth.storage.findOne("session", [{ field: "id", op: "eq", value: sessionId }])) !== null;
const tokenOfCall = (c: Call | undefined) => new URLSearchParams(c?.body).get("logout_token") ?? "";

/**
 * From now on every create of an outbox row throws, inside a transaction
 * and outside it. A flow that writes the row in its transaction then
 * changes nothing: the session and its links stay.
 */
function outboxThrows(w: World): void {
  const store = w.auth.storage;
  const create = store.create.bind(store);
  const transaction = store.transaction.bind(store);
  const refuse = () => Promise.reject(new Error("the outbox write failed"));
  store.create = ((model, data) =>
    model === "oauthLogout" ? refuse() : create(model, data)) as StorageAdapter["create"];
  store.transaction = ((fn) =>
    transaction((tx) =>
      fn({
        ...tx,
        create: ((model, data) =>
          model === "oauthLogout" ? refuse() : tx.create(model, data)) as StorageAdapter["create"],
      }),
    )) as StorageAdapter["transaction"];
}

/** Two sessions of one user, and the second one linked to two clients. */
async function twoSessions(w: World) {
  const actor = await verifiedSession(w.auth, EMAIL, "1.1.1.1");
  const other = await verifiedSession(w.auth, EMAIL, "2.2.2.2");
  return { actor, other };
}

type Signed = ResolvedSession & { token: string };

interface Flow {
  name: string;
  /** Which session the flow ends: the actor's own, or the other one. */
  target: "actor" | "other";
  run: (w: World, actor: Signed, other: Signed) => Promise<unknown>;
}

const FLOWS: Flow[] = [
  {
    name: "a sign-out",
    target: "actor",
    run: (w, actor) => w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) })),
  },
  {
    name: "the api sign-out",
    target: "actor",
    run: (w, actor) => w.api.signOut(actor.token),
  },
  {
    // The cookie move of plan 12b: a sign-out also ends the session of the old cookie name.
    name: "a sign-out of the old cookie name",
    target: "other",
    run: (w, actor, other) =>
      w.handle(
        post(
          "/auth/sign-out",
          {},
          {
            cookie: `${cookieOf(w, actor.token)}; ${w.auth.config.legacyCookieName}=${other.token}`,
          },
        ),
      ),
  },
  {
    name: "the first email second-factor enable",
    target: "other",
    async run(w, actor) {
      const r = await enableEmailMethod(w.auth.config, { session: actor, password: PASSWORD });
      if (!r.ok) throw new Error(r.code);
    },
  },
  {
    name: "a reset",
    target: "other",
    async run(w) {
      await requestPasswordReset(w.auth.config, { email: EMAIL, ip: null });
      const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
      const r = await resetPassword(w.auth.config, {
        token,
        password: "a new long password",
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
    },
  },
  {
    name: "a password change",
    target: "other",
    async run(w, actor) {
      const r = await changePassword(w.auth.config, {
        session: actor,
        currentPassword: PASSWORD,
        newPassword: "a new long password",
      });
      if (!r.ok) throw new Error(r.code);
    },
  },
  {
    name: "the second-factor enable",
    target: "other",
    async run(w, actor) {
      const setup = await setupTotp(w.auth.config, { session: actor, password: PASSWORD });
      if (!setup.ok) throw new Error(setup.code);
      const code = await codeNow(w.auth, base32Decode(setup.value.secret));
      const r = await enableTotp(w.auth.config, { session: actor, code });
      if (!r.ok) throw new Error(r.code);
    },
  },
  {
    name: "an end-session",
    target: "actor",
    async run(w, actor) {
      // A valid hint of this session ends it at once (RP-Initiated Logout 1.0, Task 15).
      const plain = await bcClient(w, null);
      const { id_token } = await tokensOf(w, actor.token, plain);
      const hint = new URLSearchParams({ id_token_hint: id_token ?? "", client_id: plain });
      return w.handle(
        new Request(`${BASE_URL}/auth/oauth/end-session?${hint}`, {
          headers: { cookie: cookieOf(w, actor.token) },
        }),
      );
    },
  },
  {
    name: "a session revoke",
    target: "other",
    async run(w, actor, other) {
      const r = await revokeSession(w.auth.config, { session: actor, id: other.session.id });
      if (!r.ok) throw new Error(r.code);
    },
  },
  {
    name: "a revoke of the other sessions",
    target: "other",
    async run(w, actor) {
      const r = await revokeOtherSessions(w.auth.config, { session: actor });
      if (!r.ok) throw new Error(r.code);
    },
  },
  {
    name: "an email change",
    target: "other",
    async run(w, actor) {
      const to = "ada.new@example.com";
      const asked = await requestEmailChange(w.auth.config, { session: actor, newEmail: to });
      if (!asked.ok) throw new Error(asked.code);
      const text = [...w.auth.mail].reverse().find((m) => m.to === to)?.text ?? "";
      const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
      const r = await confirmEmailChange(w.auth.config, { token, ip: null, userAgent: null });
      if (!r.ok) throw new Error(r.code);
    },
  },
  {
    name: "an account delete",
    target: "actor",
    async run(w, actor) {
      const r = await deleteAccount(w.auth.config, {
        session: actor,
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
    },
  },
];

describe("back-channel logout (plan 12e Task 16)", () => {
  it("links a session to a client with backchannelLogoutUri at the code exchange that gives an ID token, and at a device grant", async () => {
    const w = world();
    const { actor, other } = await twoSessions(w);
    const bc = await bcClient(w, BC, {
      grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
    });
    const plain = await bcClient(w, null);
    // No ID token, no link: the client cannot name the session.
    await tokensOf(w, actor.token, bc, "mcp:read");
    expect(await linksOf(w, actor.session.id)).toEqual([]);
    // A client with no back-channel URI gets no link.
    await tokensOf(w, actor.token, plain);
    expect(await linksOf(w, actor.session.id)).toEqual([]);
    await tokensOf(w, actor.token, bc);
    expect(await linksOf(w, actor.session.id)).toMatchObject([
      { sessionId: actor.session.id, clientId: bc, userId: actor.user.id },
    ]);
    // A second ID token of the same pair keeps one link.
    await tokensOf(w, actor.token, bc);
    expect(await linksOf(w, actor.session.id)).toHaveLength(1);
    // The device grant: the session that approved the code is the session of the ID token.
    const formPost = (path: string, body: Record<string, string>, headers = {}) =>
      new Request(`${BASE_URL}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(body).toString(),
      });
    const started = await w.handle(
      formPost("/oauth/device_authorization", {
        client_id: bc,
        scope: "openid mcp:read",
        resource: RESOURCE,
      }),
    );
    const { device_code, user_code } = (await started.json()) as {
      device_code: string;
      user_code: string;
    };
    const approved = await w.handle(
      formPost(
        "/oauth/device",
        { user_code, decision: "allow" },
        { cookie: cookieOf(w, other.token), origin: BASE_URL },
      ),
    );
    expect(await approved.text()).toContain("The device is connected.");
    expect(await linksOf(w, other.session.id)).toEqual([]);
    const polled = await w.handle(
      tokenPost({ grant_type: DEVICE_GRANT, device_code, client_id: bc }),
    );
    expect(polled.status).toBe(200);
    expect(((await polled.json()) as { id_token?: string }).id_token).toBeDefined();
    expect(await linksOf(w, other.session.id)).toMatchObject([
      { sessionId: other.session.id, clientId: bc, userId: other.user.id },
    ]);
    expect(w.calls).toEqual([]);
  });

  it("queues and sends a logout at the exchange when the session of the code ended before it", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    const p = await pkce();
    const cookie = cookieOf(w, actor.token);
    const page = await w.handle(
      authorizeGet({ clientId: bc, challenge: p.challenge, scope: "openid mcp:read" }, cookie),
    );
    const done = await w.handle(
      consentPost({ request_id: requestIdOf(await page.text()), decision: "allow" }, { cookie }),
    );
    const code = new URL(done.headers.get("location") ?? "").searchParams.get("code") ?? "";
    // The person signs out between the redirect and the exchange.
    await w.handle(post("/auth/sign-out", {}, { cookie }));
    expect(w.calls).toEqual([]);
    const res = await w.handle(exchange(code, bc, p.verifier));
    expect(res.status).toBe(200);
    const sid = decodeJwt(((await res.json()) as { id_token: string }).id_token).sid;
    expect(sid).toBe(actor.session.id);
    expect(w.calls.map((c) => c.url)).toEqual([BC]);
    expect(decodeJwt(tokenOfCall(w.calls[0])).sid).toBe(actor.session.id);
    expect(await linksOf(w, actor.session.id)).toEqual([]);
    expect(await outbox(w)).toEqual([]);
  });

  describe("writes one outbox row per linked client in the transaction of each flow that ends a session", () => {
    for (const flow of FLOWS) {
      it(`${flow.name}: one row per client, sent after the commit; a throw inside the transaction leaves no row`, async () => {
        for (const throws of [false, true]) {
          const w = world();
          const { actor, other } = await twoSessions(w);
          const target = flow.target === "actor" ? actor : other;
          const c1 = await bcClient(w, BC);
          const c2 = await bcClient(w, BC2);
          await tokensOf(w, target.token, c1);
          await tokensOf(w, target.token, c2);
          expect(await linksOf(w, target.session.id)).toHaveLength(2);
          w.status.set(BC, 500);
          w.status.set(BC2, 500);
          if (throws) {
            outboxThrows(w);
            await Promise.resolve(flow.run(w, actor, other)).catch(() => null);
            expect(await outbox(w)).toEqual([]);
            expect(await live(w, target.session.id)).toBe(true);
            expect(await linksOf(w, target.session.id)).toHaveLength(2);
            expect(w.calls).toEqual([]);
            continue;
          }
          await flow.run(w, actor, other);
          expect(await live(w, target.session.id)).toBe(false);
          expect(await linksOf(w, target.session.id)).toEqual([]);
          const rows = await outbox(w);
          expect(rows.map((r) => [r.clientId, r.sessionId, r.attempts]).sort()).toEqual(
            [
              [c1, target.session.id, 1],
              [c2, target.session.id, 1],
            ].sort(),
          );
          expect(w.calls.map((c) => c.url).sort()).toEqual([BC, BC2].sort());
          for (const c of w.calls) expect(c.sessionsAtSend).not.toContain(target.session.id);
        }
      });
    }
  });

  it("drops a waiting row whose client lost its back-channel URI, and posts nothing", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const created = await w.api.oauth?.clients.create({
      redirectUris: [REDIRECT],
      backchannelLogoutUri: BC,
    });
    if (!created?.ok) throw new Error("no client");
    const id = created.value.client.id;
    await tokensOf(w, actor.token, id);
    w.status.set(BC, 500);
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    expect(await outbox(w)).toMatchObject([{ clientId: id, attempts: 1 }]);
    const updated = await w.api.oauth?.clients.update({ clientId: id, backchannelLogoutUri: null });
    expect(updated?.ok).toBe(true);
    w.auth.clock.advance(MINUTE);
    expect((await sweepExpired(w.auth.config)).oauthLogouts).toBe(1);
    expect(await outbox(w)).toEqual([]);
    expect(w.calls).toHaveLength(1);
  });

  it("delivers a form POST of logout_token after the commit and deletes the row on 200 or 204", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const c1 = await bcClient(w, BC);
    const c2 = await bcClient(w, BC2);
    await tokensOf(w, actor.token, c1);
    await tokensOf(w, actor.token, c2);
    w.status.set(BC2, 204);
    const res = await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    expect(res.status).toBe(200);
    expect(w.calls.map((c) => c.url).sort()).toEqual([BC, BC2].sort());
    for (const c of w.calls) {
      expect(c.method).toBe("POST");
      expect(c.type).toBe("application/x-www-form-urlencoded");
      expect([...new URLSearchParams(c.body).keys()]).toEqual(["logout_token"]);
      // No redirect is followed, and each request has its own time limit.
      expect(c.redirect).toBe("manual");
      expect(c.signal).toBe(true);
      expect(c.sessionsAtSend).not.toContain(actor.session.id);
    }
    expect(await outbox(w)).toEqual([]);
  });

  it("delivers at most 10 rows after a session end, and the sweep delivers the rest (spec 8.16 item 14)", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const clients: string[] = [];
    // api.oauth.clients makes them: the register route allows 10 per hour.
    for (let i = 0; i < 12; i++) {
      const made = await createClient(w.auth.config, {
        name: `Client ${i}`,
        redirectUris: [REDIRECT],
        backchannelLogoutUri: BC,
      });
      if (!made.ok) throw new Error(made.error);
      clients.push(made.value.client.id);
    }
    for (const c of clients) await tokensOf(w, actor.token, c);
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    expect(w.calls).toHaveLength(10);
    expect(await outbox(w)).toHaveLength(2);
    await sweepExpired(w.auth.config);
    expect(w.calls).toHaveLength(12);
    expect(new Set(w.calls.map((c) => decodeJwt(tokenOfCall(c)).aud))).toEqual(new Set(clients));
    expect(await outbox(w)).toEqual([]);
  });

  it("keeps the row on a 500 with attempts 1 and nextAttemptAt one minute out, and the sweep delivers it", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    w.status.set(BC, 500);
    const at = w.auth.clock.now();
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    expect(await live(w, actor.session.id)).toBe(false);
    expect(await outbox(w)).toMatchObject([
      { clientId: bc, sessionId: actor.session.id, attempts: 1 },
    ]);
    expect((await outbox(w))[0]?.nextAttemptAt.getTime()).toBe(at.getTime() + MINUTE);
    // Not due yet: the sweep sends nothing.
    expect((await sweepExpired(w.auth.config)).oauthLogouts).toBe(0);
    expect(w.calls).toHaveLength(1);
    w.auth.clock.advance(MINUTE);
    w.status.set(BC, 200);
    expect((await sweepExpired(w.auth.config)).oauthLogouts).toBe(1);
    expect(w.calls).toHaveLength(2);
    expect(decodeJwt(tokenOfCall(w.calls[1])).sid).toBe(actor.session.id);
    expect(await outbox(w)).toEqual([]);
  });

  it("takes the due rows of each client in turns, so a failing client cannot hold back the rows of another client (ruling 37 of plan 12f)", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    // A second person: a sign-out delivers the due rows of its own user, so
    // the rows of the good client are this person's.
    const second = await verifiedSession(w.auth, "second@example.com", "3.3.3.3");
    const failing = await bcClient(w, BC);
    const good = await bcClient(w, BC2);
    w.status.set(BC, 500);
    w.status.set(BC2, 500);
    /** One linked session of `clientId` that a sign-out ends while the client fails: one due row. */
    const endLinked = async (clientId: string, userId: string) => {
      const s = await createSession(w.auth.config, {
        userId,
        ip: null,
        userAgent: null,
        proved: true,
      });
      await linkIdToken(w.auth.config, {
        sessionId: s.session.id,
        clientId,
        userId,
        sid: s.session.id,
      });
      await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, s.token) }));
    };
    // 60 rows of the failing client fall due first, more than one read of 50.
    for (let i = 0; i < 60; i++) await endLinked(failing, actor.user.id);
    w.auth.clock.advance(MINUTE);
    for (let i = 0; i < 3; i++) await endLinked(good, second.user.id);
    w.auth.clock.advance(MINUTE);
    w.status.set(BC2, 200);
    const before = w.calls.length;
    expect((await sweepExpired(w.auth.config)).oauthLogouts).toBe(3);
    const posts = w.calls.slice(before).map((c) => c.url);
    // The call budget of the sweep fits 6 rows: a row of each client in turn.
    expect(posts.filter((u) => u === BC)).toHaveLength(3);
    expect(posts.filter((u) => u === BC2)).toHaveLength(3);
    const rows = await outbox(w);
    expect(rows.filter((r) => r.clientId === good)).toEqual([]);
    expect(rows.filter((r) => r.clientId === failing && r.attempts === 2)).toHaveLength(3);
    expect(rows.filter((r) => r.clientId === failing && r.attempts === 1)).toHaveLength(57);
  });

  it("deletes a row after 6 attempts with one log line", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    w.status.set(BC, 500);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    // The waits after attempts 1 to 5: 1 minute, 5 minutes, 30 minutes, 2 hours, then 2 hours again.
    for (const [i, wait] of [
      MINUTE,
      5 * MINUTE,
      30 * MINUTE,
      120 * MINUTE,
      120 * MINUTE,
    ].entries()) {
      const row = (await outbox(w))[0];
      expect(row?.attempts).toBe(i + 1);
      expect(row?.nextAttemptAt.getTime()).toBe(w.auth.clock.now().getTime() + wait);
      w.auth.clock.advance(wait);
      await sweepExpired(w.auth.config);
    }
    expect(w.calls).toHaveLength(6);
    expect((await outbox(w))[0]?.attempts).toBe(6);
    expect(logged.mock.calls.filter((c) => String(c[0]).includes("back-channel"))).toEqual([]);
    w.auth.clock.advance(120 * MINUTE);
    expect((await sweepExpired(w.auth.config)).oauthLogouts).toBe(1);
    // A seventh attempt never goes out.
    expect(w.calls).toHaveLength(6);
    expect(await outbox(w)).toEqual([]);
    const lines = logged.mock.calls.filter((c) => String(c[0]).includes("back-channel"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(bc);
  });

  it("signs a logout token with events, sid, the client's sub, typ logout+jwt, a life of 120 seconds, and no nonce", async () => {
    for (const subjectType of ["public", "pairwise"] as const) {
      const w = world();
      const { actor } = await twoSessions(w);
      const bc = await bcClient(w, BC, { subject_type: subjectType });
      const { id_token } = await tokensOf(w, actor.token, bc);
      const idClaims = decodeJwt(id_token ?? "");
      // The ID token carries a nonce; the logout token never does (Back-Channel Logout 2.4).
      expect(idClaims.nonce).toBe("n-1");
      await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
      const now = Math.floor(w.auth.clock.now().getTime() / 1000);
      const { payload, protectedHeader } = await jwtVerify(
        tokenOfCall(w.calls[0]),
        createLocalJWKSet(await publicKeySet(w.auth.config)),
        { issuer: ISSUER, audience: bc, currentDate: w.auth.clock.now(), typ: "logout+jwt" },
      );
      expect(protectedHeader.typ).toBe("logout+jwt");
      expect(payload).toEqual({
        iss: ISSUER,
        aud: bc,
        iat: now,
        exp: now + 120,
        jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        events: { [EVENT]: {} },
        sub: idClaims.sub,
        sid: idClaims.sid,
      });
      expect(payload).not.toHaveProperty("nonce");
      // A pairwise client gets its own sid, not the session id (review M2 of plan 12e).
      if (subjectType === "pairwise") {
        expect(payload.sub).not.toBe(actor.user.id);
        expect(idClaims.sid).toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(payload.sub).toBe(actor.user.id);
        expect(idClaims.sid).toBe(actor.session.id);
      }
    }
  });

  it("names the primary issuer in the logout token of a link with no issuer (final fix wave item 8)", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    // A core before schema 15 wrote its links with no issuer.
    const links = await w.auth.storage.findMany("oauthSessionClient", []);
    expect(links).toHaveLength(1);
    await w.auth.storage.update(
      "oauthSessionClient",
      [{ field: "id", op: "eq", value: links[0]?.id }],
      {
        issuer: null,
      },
    );
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    expect(decodeJwt(tokenOfCall(w.calls[0])).iss).toBe(ISSUER);
  });

  it("counts a logout token as no id_token_hint at the end-session route", async () => {
    const w = world();
    const { actor, other } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    const logoutToken = tokenOfCall(w.calls[0]);
    const params = new URLSearchParams({
      id_token_hint: logoutToken,
      post_logout_redirect_uri: BYE,
      state: "s-1",
    });
    // With no session, a valid hint would redirect. A logout token is no hint: the signed-out page.
    const bare = await w.handle(new Request(`${BASE_URL}/auth/oauth/end-session?${params}`));
    expect(bare.status).toBe(200);
    expect(bare.headers.get("location")).toBeNull();
    // With a session, no hint means the confirmation page, and the session lives.
    const asked = await w.handle(
      new Request(`${BASE_URL}/auth/oauth/end-session?${params}`, {
        headers: { cookie: cookieOf(w, other.token) },
      }),
    );
    expect(asked.status).toBe(200);
    expect(asked.headers.get("location")).toBeNull();
    expect(await asked.text()).toContain('name="confirm" value="yes"');
    expect(await live(w, other.session.id)).toBe(true);
  });

  it("sends a logout at the sweep's delete of expired sessions, and deletes their links (ruling 49)", async () => {
    const w = world();
    const { actor, other } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    await tokensOf(w, other.token, bc);
    // The verify link's session, and the two sign-ins. Then past the life of each.
    const sessions = await w.auth.storage.findMany("session", []);
    expect(sessions).toHaveLength(3);
    w.auth.clock.advance(400 * 24 * 60 * MINUTE);
    const swept = await sweepExpired(w.auth.config);
    expect(swept.sessions).toBe(3);
    expect(swept.oauthSessionLinks).toBe(2);
    expect(swept.oauthLogouts).toBe(2);
    expect(await w.auth.storage.findMany("oauthSessionClient", [])).toEqual([]);
    expect(await outbox(w)).toEqual([]);
    expect(w.calls.map((c) => decodeJwt(tokenOfCall(c)).sid).sort()).toEqual(
      [actor.session.id, other.session.id].sort(),
    );
  });

  /**
   * The race of review M1: the exchange writes its link and reads the
   * session after the sign-out read the links, and before it deletes the
   * session. The real `linkIdToken` runs inside the sign-out's link read.
   * The link then stays with no session.
   */
  async function raceLink(w: World, target: Signed, clientId: string) {
    const store = w.auth.storage;
    const findMany = store.findMany.bind(store);
    let armed = true;
    store.findMany = (async (model, where, opts) => {
      const rows = await findMany(model, where, opts);
      if (armed && model === "oauthSessionClient") {
        armed = false;
        await linkIdToken(w.auth.config, {
          sessionId: target.session.id,
          clientId,
          userId: target.user.id,
          sid: target.session.id,
        });
      }
      return rows;
    }) as StorageAdapter["findMany"];
    return () => {
      store.findMany = findMany;
    };
  }

  it("sends the logout of a link that a sign-out raced, at the next sweep (review P1)", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    const restore = await raceLink(w, actor, bc);
    const out = await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    restore();
    expect(out.status).toBe(200);
    expect(await live(w, actor.session.id)).toBe(false);
    expect(await linksOf(w, actor.session.id)).toHaveLength(1);
    expect(w.calls).toEqual([]);
    // The sweep runs later than the link write.
    w.auth.clock.advance(1_000);
    const swept = await sweepExpired(w.auth.config);
    expect(swept.oauthSessionLinks).toBe(1);
    expect(swept.oauthLogouts).toBe(1);
    expect(w.calls.map((c) => decodeJwt(tokenOfCall(c)).sid)).toEqual([actor.session.id]);
    expect(await linksOf(w, actor.session.id)).toEqual([]);
  });

  /** `count` live links of new sign-ins of `userId`, each one second older than the next. */
  async function liveLinks(w: World, userId: string, clientId: string, count: number) {
    for (let i = 0; i < count; i++) {
      const s = await createSession(w.auth.config, {
        userId,
        ip: null,
        userAgent: null,
        proved: true,
      });
      await linkIdToken(w.auth.config, {
        sessionId: s.session.id,
        clientId,
        userId,
        sid: s.session.id,
      });
      w.auth.clock.advance(1_000);
    }
  }

  it("reads the links that it saw longest ago, so a live link never hides a link with no session", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    // 250 live links: the 5 pages of one sweep. Then the raced link of a
    // sign-out: the newest link, with no session.
    await liveLinks(w, actor.user.id, bc, 250);
    const restore = await raceLink(w, actor, bc);
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    restore();
    w.auth.clock.advance(1_000);
    // The first sweep reads the 250 live links and moves each to now.
    expect((await sweepExpired(w.auth.config)).oauthSessionLinks).toBe(0);
    expect(w.calls).toEqual([]);
    w.auth.clock.advance(1_000);
    // The second sweep reads the link with no session first: ceil(251 / 250) = 2 sweeps.
    expect((await sweepExpired(w.auth.config)).oauthSessionLinks).toBe(1);
    expect(w.calls.map((c) => decodeJwt(tokenOfCall(c)).sid)).toEqual([actor.session.id]);
    expect(await w.auth.storage.findMany("oauthSessionClient", [])).toHaveLength(250);
  });

  it("reads more than one page of links in one sweep", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    // 60 live links fill the first page and part of the second; the orphan is in the second.
    await liveLinks(w, actor.user.id, bc, 60);
    const restore = await raceLink(w, actor, bc);
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    restore();
    w.auth.clock.advance(1_000);
    expect((await sweepExpired(w.auth.config)).oauthSessionLinks).toBe(1);
    expect(w.calls.map((c) => decodeJwt(tokenOfCall(c)).sid)).toEqual([actor.session.id]);
  });

  it("sends the logout of a link with no session at the user's next session end", async () => {
    const w = world();
    const { actor, other } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    const restore = await raceLink(w, other, bc);
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, other.token) }));
    restore();
    expect(await linksOf(w, other.session.id)).toHaveLength(1);
    expect(w.calls).toEqual([]);
    // A password change ends the user's other sessions: endSessions reads the link with no session.
    const r = await changePassword(w.auth.config, {
      session: actor,
      currentPassword: PASSWORD,
      newPassword: "a new long password",
    });
    expect(r.ok).toBe(true);
    expect(await linksOf(w, other.session.id)).toEqual([]);
    expect(w.calls.map((c) => decodeJwt(tokenOfCall(c)).sid)).toEqual([other.session.id]);
  });

  it("ends no refresh token at a logout (Back-Channel Logout 2.7)", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    const { refresh_token } = await tokensOf(w, actor.token, bc, "openid mcp:read offline_access");
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    expect(w.calls).toHaveLength(1);
    const res = await w.handle(
      tokenPost({ grant_type: "refresh_token", refresh_token: refresh_token ?? "", client_id: bc }),
    );
    expect(res.status).toBe(200);
  });

  it("queues a logout when a request presents an expired linked session, and the sweep sends it", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    w.auth.clock.advance(400 * 24 * 60 * MINUTE);
    const res = await w.handle(
      new Request(`${BASE_URL}/auth/session`, { headers: { cookie: cookieOf(w, actor.token) } }),
    );
    expect(res.status).toBe(401);
    expect(await live(w, actor.session.id)).toBe(false);
    expect(await outbox(w)).toMatchObject([{ clientId: bc, attempts: 0 }]);
    expect(w.calls).toEqual([]);
    expect((await sweepExpired(w.auth.config)).oauthLogouts).toBe(1);
    expect(decodeJwt(tokenOfCall(w.calls[0])).sid).toBe(actor.session.id);
  });

  it("keeps the row for a retry on a throw, no answer in 2 seconds, 408, 429, and 503, and the session end stands", async () => {
    const status = (code: number) => async () => new Response(null, { status: code });
    const answers: [string, (init: RequestInit | undefined) => Promise<Response>][] = [
      ["a throw", () => Promise.reject(new TypeError("network down"))],
      // A fetch that never answers and ignores the signal: the wait still ends at 2 seconds.
      ["no answer", () => new Promise<Response>(() => {})],
      ["408", status(408)],
      ["429", status(429)],
      ["503", status(503)],
    ];
    for (const [name, fn] of answers) {
      const w = world();
      const { actor } = await twoSessions(w);
      const bc = await bcClient(w, BC);
      await tokensOf(w, actor.token, bc);
      w.answer.set(BC, fn);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const out = w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
        while (w.calls.length === 0) await new Promise((r) => nextTurn(r));
        await vi.advanceTimersByTimeAsync(2_000);
        expect((await out).status, name).toBe(200);
      } finally {
        vi.useRealTimers();
      }
      expect(await live(w, actor.session.id), name).toBe(false);
      expect(await outbox(w), name).toMatchObject([{ clientId: bc, attempts: 1 }]);
    }
  });

  it("drops the row with one log line when the client refuses the token: 400 and a redirect (section 2.5)", async () => {
    const answers: [string, () => Promise<Response>][] = [
      // Section 2.8: the client refused the token.
      ["400", async () => new Response(null, { status: 400 })],
      // A redirect is not followed: a 302 is the answer, and no retry can change it.
      [
        "302",
        async () =>
          new Response(null, { status: 302, headers: { location: "https://x.example/" } }),
      ],
    ];
    for (const [name, fn] of answers) {
      const w = world();
      const { actor } = await twoSessions(w);
      const bc = await bcClient(w, BC);
      await tokensOf(w, actor.token, bc);
      w.answer.set(BC, fn);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
      expect(await outbox(w), name).toEqual([]);
      const lines = logged.mock.calls.filter((c) => String(c[0]).includes("back-channel"));
      expect(lines, name).toEqual([
        ["authtempo: a back-channel logout is dropped: the client refused it", bc, Number(name)],
      ]);
      logged.mockRestore();
      // No later sweep sends it again.
      w.auth.clock.advance(MINUTE);
      await sweepExpired(w.auth.config);
      expect(w.calls, name).toHaveLength(1);
    }
  });

  it("posts a due row once when two instances on one storage deliver it at the same time", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    // An expired row that a request presents: its logout waits in the outbox, due now.
    w.auth.clock.advance(400 * 24 * 60 * MINUTE);
    await w.handle(
      new Request(`${BASE_URL}/auth/session`, { headers: { cookie: cookieOf(w, actor.token) } }),
    );
    expect(await outbox(w)).toMatchObject([{ attempts: 0 }]);
    await Promise.all([
      deliverLogouts(w.auth.config, actor.user.id),
      deliverLogouts(w.second, actor.user.id),
    ]);
    expect(w.calls).toHaveLength(1);
    expect(await outbox(w)).toEqual([]);
  });

  it("aborts every open request of a delivery at 5 seconds, whatever the time of each request", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    // The client read takes 4 seconds, then the request never answers.
    let armed = false;
    const store = w.auth.storage;
    const findOne = store.findOne.bind(store);
    store.findOne = (async (model, where) => {
      if (model === "oauthClient" && w.calls.length === 0 && armed)
        await new Promise((r) => setTimeout(r, 4_000));
      return findOne(model, where);
    }) as StorageAdapter["findOne"];
    w.answer.set(BC, () => new Promise<Response>(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      armed = true;
      let done = false;
      const out = w
        .handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }))
        .then((r) => {
          done = true;
          return r;
        });
      // The delivery starts its 5 seconds before the client read.
      while (vi.getTimerCount() < 2) await new Promise((r) => nextTurn(r));
      await vi.advanceTimersByTimeAsync(4_000);
      while (w.calls.length === 0) await new Promise((r) => nextTurn(r));
      // 1 second later the delivery ends: the request's own 2 seconds have not passed.
      await vi.advanceTimersByTimeAsync(1_000);
      for (let i = 0; i < 20 && !done; i++) await new Promise((r) => nextTurn(r));
      expect(done).toBe(true);
      expect((await out).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect(await outbox(w)).toMatchObject([{ clientId: bc, attempts: 1 }]);
  });

  it("reads no byte of the answer", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    let pulls = 0;
    let cancelled = false;
    w.answer.set(BC, async () => {
      const body = new ReadableStream(
        {
          // 8 MB in all, so a read of the body ends and a test of it can fail.
          pull(c) {
            pulls++;
            if (pulls > 8) c.close();
            else c.enqueue(new Uint8Array(1 << 20));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 200 });
    });
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
    expect(await outbox(w)).toEqual([]);
  });

  it("serves a document client's backchannel_logout_uri on the document's host, and drops one on another host (ruling 24)", async () => {
    const DOC = "https://client.example.com/oauth/client.json";
    const w = world({ cimd: true });
    const doc = (uri: string) => async () =>
      new Response(
        JSON.stringify({
          client_id: DOC,
          client_name: "Doc client",
          redirect_uris: [REDIRECT],
          backchannel_logout_uri: uri,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    w.answer.set(DOC, doc(BC2));
    expect(await fetchCimd(w.auth.config, DOC)).toMatchObject({ backchannelLogoutUri: null });
    expect(warned).toHaveBeenCalledWith(
      "authtempo: client metadata member dropped",
      "backchannel_logout_uri",
    );
    w.answer.set(DOC, doc("https://localhost/backchannel"));
    expect(await fetchCimd(w.auth.config, DOC)).toMatchObject({ backchannelLogoutUri: null });
    // On its own host, the document client gets the logout like any client.
    w.answer.set(DOC, doc(BC));
    expect(await fetchCimd(w.auth.config, DOC)).toMatchObject({ backchannelLogoutUri: BC });
    const { actor } = await twoSessions(w);
    await tokensOf(w, actor.token, DOC);
    expect(await linksOf(w, actor.session.id)).toMatchObject([{ clientId: DOC }]);
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    const posts = w.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([BC]);
    expect(decodeJwt(tokenOfCall(posts[0])).aud).toBe(DOC);
  });

  /**
   * Counts each storage call of one `sweepExpired`, inside a transaction
   * too. On D1 each call is one query of the invocation.
   */
  function countCalls(store: StorageAdapter): { n: number } {
    const count = { n: 0 };
    const tick = () => {
      count.n++;
    };
    const wrap = (s: StorageAdapter): StorageAdapter => ({
      createMany: (m, r) => {
        tick();
        return s.createMany(m, r);
      },
      rowsPerInsert: (m) => s.rowsPerInsert(m),
      create: (m, d) => {
        tick();
        return s.create(m, d);
      },
      findOne: (m, w) => {
        tick();
        return s.findOne(m, w);
      },
      findMany: (m, w, o) => {
        tick();
        return s.findMany(m, w, o);
      },
      update: (m, w, d) => {
        tick();
        return s.update(m, w, d);
      },
      delete: (m, w) => {
        tick();
        return s.delete(m, w);
      },
      deleteRows: (m, w) => {
        tick();
        return s.deleteRows(m, w);
      },
      isolated: s.isolated,
      keep: () => s.keep(),
      transaction: (fn) => s.transaction((tx) => fn(wrap(tx))),
    });
    const inner = { ...store };
    Object.assign(store, wrap(inner));
    return count;
  }

  // It writes 260 sessions first. It took 104 ms alone at load 4.2 (2026-10-25). It timed
  // out at the default 5 s in the plan 12d evidence runs at load 38 to 48 (plan 12i fix wave).
  it("ends a page of a pending-end row beside an outbox over the budget, inside 50 calls (ruling 50 of plan 12f)", {
    timeout: LONG_TEST_MS,
  }, async () => {
    const ended: string[] = [];
    const w = world({
      extra: {
        organizations: {
          platformRole: "operator",
          platformOrganization: "platform-co",
          ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
        },
        operator: { users: true },
        hooks: { session: { afterEnd: ({ session }) => void ended.push(session.id) } },
      },
    });
    const { actor } = await twoSessions(w);
    const uris = [1, 2, 3, 4, 5].map((k) => `${BC}/${k}`);
    const clients: string[] = [];
    for (const uri of uris) {
      clients.push(await bcClient(w, uri));
      w.status.set(uri, 500);
    }
    // 200 outbox rows that fail and are due again: more than the outbox can send in one sweep.
    for (let i = 0; i < 200; i++) {
      const s = await createSession(w.auth.config, {
        userId: actor.user.id,
        ip: null,
        userAgent: null,
        proved: true,
      });
      await linkIdToken(w.auth.config, {
        sessionId: s.session.id,
        clientId: clients[i % 5] ?? "",
        userId: actor.user.id,
        sid: s.session.id,
      });
      await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, s.token) }));
    }
    expect(await outbox(w)).toHaveLength(200);
    // A ban of a user with 60 sessions and a hook leaves sessions with a pending-end row.
    const bob = await verifiedSession(w.auth, "bob@example.com");
    for (let i = 0; i < 59; i++)
      await createSession(w.auth.config, {
        userId: bob.user.id,
        ip: null,
        userAgent: null,
        proved: true,
      });
    const banned = await banUser(w.auth.config, {
      actor: { kind: "app", name: "support-tool" },
      userId: bob.user.id,
      reason: "Abuse case 4711",
      ip: null,
      userAgent: null,
    });
    if (!banned.ok) throw new Error(banned.code);
    const left = (
      await w.auth.storage.findMany("session", [{ field: "userId", op: "eq", value: bob.user.id }])
    ).length;
    expect(left).toBeGreaterThan(0);
    ended.length = 0;
    // One day on: each failed row is due again.
    w.auth.clock.advance(24 * 60 * MINUTE);
    const count = countCalls(w.auth.storage);
    const before = w.calls.length;
    const swept = await sweepExpired(w.auth.config);
    const posts = w.calls.length - before;
    // The outbox spends its share and more, and the page of the pending row still runs.
    expect(posts).toBeGreaterThan(0);
    expect(swept.pendingSessions).toBeGreaterThan(0);
    expect(ended).toHaveLength(swept.pendingSessions);
    expect(count.n + posts).toBeLessThanOrEqual(50);
  });

  // It writes 1000 sessions and 1000 links first. It took 502 ms alone at load 4.2
  // (2026-10-25). It timed out at the default 5 s in the plan 12d evidence runs at load 38
  // to 48. LONG_TEST_MS gives it 40 times its time alone.
  it("keeps one sweep with full caps inside 50 calls with its posts, the limits of Workers Free (ruling 37 of plan 12f)", {
    timeout: LONG_TEST_MS,
  }, async () => {
    for (const subjectType of ["public", "pairwise"] as const) {
      const w = world();
      const { actor } = await twoSessions(w);
      // Five clients, so the cap of 10 rows per client leaves the sweep cap full.
      const uris = [1, 2, 3, 4, 5].map((k) => `${BC}/${k}`);
      const clients: string[] = [];
      for (const uri of uris) {
        clients.push(await bcClient(w, uri, { subject_type: subjectType }));
        w.status.set(uri, 500);
      }
      // 300 links whose session expires, and 200 outbox rows that fail and
      // are due again: more than each cap, so the caps bound the calls.
      for (let i = 0; i < 500; i++) {
        const s = await createSession(w.auth.config, {
          userId: actor.user.id,
          ip: null,
          userAgent: null,
          proved: true,
        });
        await linkIdToken(w.auth.config, {
          sessionId: s.session.id,
          clientId: clients[i % 5] ?? "",
          userId: actor.user.id,
          sid: s.session.id,
        });
        if (i >= 300) await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, s.token) }));
      }
      expect(await outbox(w)).toHaveLength(200);
      // Past the session life, and inside the 90 days of the idle client sweep.
      w.auth.clock.advance(60 * 24 * 60 * MINUTE);
      const count = countCalls(w.auth.storage);
      const before = w.calls.length;
      const swept = await sweepExpired(w.auth.config);
      const posts = w.calls.length - before;
      const total = count.n + posts;
      // The view of the store has no statementsSent, so each step counts its worst case. The
      // pairwise subject costs 1 more call per row. The posts count as calls too. The read of the
      // pending-end rows (ruling 50 of plan 12f) takes 1 call from the links: 17 before it.
      // The delete of the organization tokens (plan 12k) takes 1 more: 16 became 15.
      expect([swept.oauthSessionLinks, swept.oauthLogouts, posts], subjectType).toEqual([15, 0, 2]);
      expect((await outbox(w)).filter((r) => r.attempts === 2)).toHaveLength(2);
      expect(total, subjectType).toBe(subjectType === "public" ? 46 : 48);
    }
  });

  it("keeps the counts above when a back-channel step meets a storage error", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    w.auth.clock.advance(60 * 24 * 60 * MINUTE);
    const store = w.auth.storage;
    const findMany = store.findMany.bind(store);
    // As D1 does past the query limit of one run.
    store.findMany = ((model, where, opts) =>
      model === "oauthLogout"
        ? Promise.reject(new Error("too many queries"))
        : findMany(model, where, opts)) as StorageAdapter["findMany"];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const swept = await sweepExpired(w.auth.config);
    expect(swept.sessions).toBe(3);
    expect(swept.oauthSessionLinks).toBe(1);
    expect(swept.oauthLogouts).toBe(0);
    expect(logged.mock.calls).toEqual([["authtempo: the sweep outbox step stopped", "Error"]]);
    store.findMany = findMany;
    // The next sweep sends the row.
    expect((await sweepExpired(w.auth.config)).oauthLogouts).toBe(1);
  });

  it("burns no attempt on a throw between the claim and the post, and sends the token later", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    // The signing read fails after the claim, as at a storage limit.
    const store = w.auth.storage;
    const findOne = store.findOne.bind(store);
    let failing = true;
    store.findOne = ((model, where) =>
      failing && model === "jwk"
        ? Promise.reject(new Error("too many queries"))
        : findOne(model, where)) as StorageAdapter["findOne"];
    const findMany = store.findMany.bind(store);
    store.findMany = ((model, where, opts) =>
      failing && model === "jwk"
        ? Promise.reject(new Error("too many queries"))
        : findMany(model, where, opts)) as StorageAdapter["findMany"];
    vi.spyOn(console, "error").mockImplementation(() => {});
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    for (let i = 0; i < 8; i++) {
      w.auth.clock.advance(MINUTE);
      await sweepExpired(w.auth.config);
    }
    expect(w.calls).toEqual([]);
    expect(await outbox(w)).toMatchObject([{ clientId: bc, attempts: 0 }]);
    failing = false;
    w.auth.clock.advance(MINUTE);
    expect((await sweepExpired(w.auth.config)).oauthLogouts).toBe(1);
    expect(w.calls.map((c) => decodeJwt(tokenOfCall(c)).sid)).toEqual([actor.session.id]);
    expect(await outbox(w)).toEqual([]);
  });

  it("loses no logout when each sweep stops at 50 storage calls, as on D1 Free (review Q1)", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    // 30 linked sessions that expire: 30 links, then 30 due rows.
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const s = await createSession(w.auth.config, {
        userId: actor.user.id,
        ip: null,
        userAgent: null,
        proved: true,
      });
      await linkIdToken(w.auth.config, {
        sessionId: s.session.id,
        clientId: bc,
        userId: actor.user.id,
        sid: s.session.id,
      });
      ids.push(s.session.id);
    }
    w.auth.clock.advance(31 * 24 * 60 * MINUTE);
    // Each storage call past 50 in one sweep throws, as D1 Free does.
    const store = w.auth.storage;
    const inner = { ...store };
    let calls = 0;
    const capped = <T>(f: () => Promise<T>): Promise<T> =>
      ++calls > 50 ? Promise.reject(new Error("too many queries")) : f();
    const wrap = (s: StorageAdapter): StorageAdapter => ({
      createMany: (m, r) => capped(() => s.createMany(m, r)),
      rowsPerInsert: (m) => s.rowsPerInsert(m),
      create: (m, d) => capped(() => s.create(m, d)),
      findOne: (m, wh) => capped(() => s.findOne(m, wh)),
      findMany: (m, wh, o) => capped(() => s.findMany(m, wh, o)),
      update: (m, wh, d) => capped(() => s.update(m, wh, d)),
      delete: (m, wh) => capped(() => s.delete(m, wh)),
      deleteRows: (m, wh) => capped(() => s.deleteRows(m, wh)),
      isolated: s.isolated,
      keep: () => s.keep(),
      transaction: (fn) => s.transaction((tx) => fn(wrap(tx))),
    });
    Object.assign(store, wrap(inner));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let sweep = 0; sweep < 20; sweep++) {
      calls = 0;
      await sweepExpired(w.auth.config);
      w.auth.clock.advance(3 * 60 * MINUTE);
    }
    Object.assign(store, inner);
    const sent = new Set(w.calls.map((c) => String(decodeJwt(tokenOfCall(c)).sid)));
    expect(ids.filter((id) => !sent.has(id))).toEqual([]);
    expect(logged.mock.calls.filter((c) => String(c[0]).includes("dropped"))).toEqual([]);
    expect(await outbox(w)).toEqual([]);
    expect(await w.auth.storage.findMany("oauthSessionClient", [])).toEqual([]);
  });

  it("keeps the counts above when the link step meets a storage error", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const bc = await bcClient(w, BC);
    await tokensOf(w, actor.token, bc);
    w.auth.clock.advance(60 * 24 * 60 * MINUTE);
    const store = w.auth.storage;
    const findMany = store.findMany.bind(store);
    // As D1 does past the query limit of one run.
    store.findMany = ((model, where, opts) =>
      model === "oauthSessionClient"
        ? Promise.reject(new Error("too many queries"))
        : findMany(model, where, opts)) as StorageAdapter["findMany"];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const swept = await sweepExpired(w.auth.config);
    expect(swept.sessions).toBe(3);
    expect(swept.oauthSessionLinks).toBe(0);
    expect(logged.mock.calls).toEqual([["authtempo: the sweep link step stopped", "Error"]]);
    store.findMany = findMany;
    // The next sweep makes the link a logout and sends it.
    expect(await sweepExpired(w.auth.config)).toMatchObject({
      oauthSessionLinks: 1,
      oauthLogouts: 1,
    });
  });

  it("refuses an endSessions call with no userId term: the outbox reads the user's links", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    await expect(
      w.auth.storage.transaction((tx) =>
        endSessions(
          tx,
          [{ field: "id", op: "eq", value: actor.session.id }],
          null,
          w.auth.clock.now(),
          null,
        ),
      ),
    ).rejects.toThrow("authtempo: endSessions needs a userId term");
    expect(await live(w, actor.session.id)).toBe(true);
  });

  it("refuses backchannel_logout_uri without oauth.fetch, on http, or on a private host", async () => {
    const w = world();
    const create = (extra: Record<string, unknown>) =>
      // A value of any type, as an app in plain JS could pass it.
      createClient(w.auth.config, { redirectUris: [REDIRECT], ...extra } as never);
    const refused = { ok: false, error: "invalid_client_metadata" };
    for (const uri of [
      "http://client.example.com/backchannel",
      "https://localhost/backchannel",
      "https://10.0.0.1/backchannel",
      "https://[::1]/backchannel",
      "https://intranet/backchannel",
      "https://client.example.com/backchannel#frag",
      "https://user:pw@client.example.com/backchannel",
      "https://api.example.com/backchannel",
      "https://CLIENT.example.com/backchannel",
      "client.example.com/backchannel",
      42,
    ])
      expect(await create({ backchannelLogoutUri: uri }), String(uri)).toMatchObject(refused);
    expect(
      await create({ backchannelLogoutUri: BC, backchannelLogoutSessionRequired: "yes" }),
    ).toMatchObject(refused);
    // Back-Channel Logout 2.2: a query stays, and the session flag is stored.
    const kept = await create({
      backchannelLogoutUri: `${BC}?tenant=a`,
      backchannelLogoutSessionRequired: true,
    });
    expect(kept).toMatchObject({
      ok: true,
      value: {
        client: { backchannelLogoutUri: `${BC}?tenant=a`, backchannelLogoutSessionRequired: true },
      },
    });
    // The register route holds the same rules, and answers both members.
    const register = (body: Record<string, unknown>) =>
      w.handle(post("/auth/oauth/register", { redirect_uris: [REDIRECT], ...body }));
    const bad = await register({ backchannel_logout_uri: "https://localhost/backchannel" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_client_metadata" });
    const good = await register({
      backchannel_logout_uri: BC,
      backchannel_logout_session_required: true,
    });
    expect(good.status).toBe(201);
    expect(await good.json()).toMatchObject({
      backchannel_logout_uri: BC,
      backchannel_logout_session_required: true,
    });
    // With no fetch, core could never deliver a token.
    const blind = world({ noFetch: true });
    expect(
      await createClient(blind.auth.config, { redirectUris: [REDIRECT], backchannelLogoutUri: BC }),
    ).toMatchObject(refused);
  });
});

describe("the sid of a pairwise client (review M2 of plan 12e)", () => {
  const OTHER_REDIRECT = "https://app.example.org/callback";
  const OTHER_BC = "https://app.example.org/backchannel";

  /** One pairwise client on client.example.com, one on app.example.org, and one public client. */
  async function threeClients(w: World) {
    const a = await bcClient(w, BC, { subject_type: "pairwise" });
    const b = await bcClient(w, OTHER_BC, {
      subject_type: "pairwise",
      redirect_uris: [OTHER_REDIRECT],
      post_logout_redirect_uris: ["https://app.example.org/bye"],
    });
    const pub = await bcClient(w, BC2, { redirect_uris: [REDIRECT] });
    return { a, b, pub };
  }

  it("gives two pairwise clients of one session two sid values, and a public client the session id", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const { a, b, pub } = await threeClients(w);
    const sidOf = async (clientId: string, redirectUri = REDIRECT) =>
      decodeJwt(
        (await tokensOf(w, actor.token, clientId, "openid mcp:read", redirectUri)).id_token ?? "",
      ).sid;
    const sidA = await sidOf(a);
    const sidB = await sidOf(b, OTHER_REDIRECT);
    expect(typeof sidA).toBe("string");
    expect(sidA).not.toBe(sidB);
    expect(sidA).not.toBe(actor.session.id);
    expect(sidB).not.toBe(actor.session.id);
    // One client keeps one sid in one session.
    expect(await sidOf(a)).toBe(sidA);
    expect(await sidOf(pub)).toBe(actor.session.id);
  });

  it("writes the sid of each client in its logout token", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const { a, b, pub } = await threeClients(w);
    const sids = new Map<string, unknown>();
    for (const [clientId, uri] of [
      [a, REDIRECT],
      [b, OTHER_REDIRECT],
      [pub, REDIRECT],
    ] as const)
      sids.set(
        clientId,
        decodeJwt((await tokensOf(w, actor.token, clientId, "openid mcp:read", uri)).id_token ?? "")
          .sid,
      );
    await w.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    expect(w.calls).toHaveLength(3);
    const got = new Map<unknown, unknown>();
    for (const c of w.calls) {
      const claims = decodeJwt(tokenOfCall(c));
      got.set(claims.aud, claims.sid);
    }
    expect(got).toEqual(sids);
    expect(new Set(got.values()).size).toBe(3);
  });

  it("ends the session of a pairwise hint at once, and asks first for a hint of another session", async () => {
    const w = world();
    const { actor, other } = await twoSessions(w);
    const { a, b } = await threeClients(w);
    const hintOf = async (token: string, clientId: string, uri: string) =>
      (await tokensOf(w, token, clientId, "openid mcp:read", uri)).id_token ?? "";
    const endWith = (cookieToken: string, hint: string) =>
      w.handle(
        new Request(
          `${BASE_URL}/auth/oauth/end-session?${new URLSearchParams({ id_token_hint: hint })}`,
          { headers: { cookie: cookieOf(w, cookieToken) } },
        ),
      );
    // A hint of the other session asks first, and both sessions live.
    const otherHint = await hintOf(other.token, b, OTHER_REDIRECT);
    const asked = await endWith(actor.token, otherHint);
    expect(await asked.text()).toContain('name="confirm" value="yes"');
    expect(await live(w, actor.session.id)).toBe(true);
    expect(await live(w, other.session.id)).toBe(true);
    // A hint of each client of this session ends it at once.
    const ended = await endWith(actor.token, await hintOf(actor.token, a, REDIRECT));
    expect(await ended.text()).not.toContain('name="confirm"');
    expect(await live(w, actor.session.id)).toBe(false);
    expect(await live(w, other.session.id)).toBe(true);
    const done = await endWith(other.token, otherHint);
    expect(await done.text()).not.toContain('name="confirm"');
    expect(await live(w, other.session.id)).toBe(false);
  });

  it("maps a pairwise hint from before a new secret version to its session", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const { a } = await threeClients(w);
    const hint = (await tokensOf(w, actor.token, a)).id_token ?? "";
    // A second version becomes current on another instance over the same storage.
    const { secret, ...rest } = w.input;
    const input: AuthConfig = {
      ...rest,
      secrets: [
        { version: 2, value: "Zq8vR2kL9mN4pX7wT1yB6cD3hF5jG0sQ" },
        { version: 1, value: secret ?? "" },
      ],
    };
    const config = resolveConfig(input);
    const rotated = createRouter(config, coreRoutes(config));
    const res = await rotated(
      new Request(
        `${BASE_URL}/auth/oauth/end-session?${new URLSearchParams({ id_token_hint: hint })}`,
        { headers: { cookie: cookieOf(w, actor.token) } },
      ),
    );
    expect(await res.text()).not.toContain('name="confirm"');
    expect(await live(w, actor.session.id)).toBe(false);
  });

  /** The routes of `w` on its storage, with `secrets` in place of its one secret. */
  function rotatedTo(w: World, secrets: { version: number; value: string }[]): World {
    const { secret: _, ...rest } = w.input;
    const config = resolveConfig({ ...rest, secrets });
    return { ...w, handle: createRouter(config, coreRoutes(config)) };
  }
  const V2 = { version: 2, value: "Zq8vR2kL9mN4pX7wT1yB6cD3hF5jG0sQ" };

  it("keeps the sid of the first ID token for the link, and sends it in the logout token after a rotation (ruling 57)", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const { a } = await threeClients(w);
    const first = decodeJwt((await tokensOf(w, actor.token, a)).id_token ?? "").sid;
    const rotated = rotatedTo(w, [V2, { version: 1, value: w.input.secret ?? "" }]);
    // A second ID token of the same session and client, under the new version, carries the same sid.
    const second = decodeJwt((await tokensOf(rotated, actor.token, a)).id_token ?? "").sid;
    expect(second).toBe(first);
    await rotated.handle(post("/auth/sign-out", {}, { cookie: cookieOf(w, actor.token) }));
    expect(w.calls).toHaveLength(1);
    expect(decodeJwt(tokenOfCall(w.calls[0])).sid).toBe(first);
  });

  it("maps a pairwise hint to its session by the stored sid after its secret version is gone (ruling 57)", async () => {
    const w = world();
    const { actor } = await twoSessions(w);
    const { a } = await threeClients(w);
    const hint = (await tokensOf(w, actor.token, a)).id_token ?? "";
    const gone = rotatedTo(w, [V2]);
    const res = await gone.handle(
      new Request(
        `${BASE_URL}/auth/oauth/end-session?${new URLSearchParams({ id_token_hint: hint })}`,
        { headers: { cookie: cookieOf(w, actor.token) } },
      ),
    );
    expect(await res.text()).not.toContain('name="confirm"');
    expect(await live(w, actor.session.id)).toBe(false);
  });
});
