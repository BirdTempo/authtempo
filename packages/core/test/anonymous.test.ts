import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { type ResolvedConfig, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import {
  ANONYMOUS_REFUSED,
  ANONYMOUS_ROWS,
  deleteAnonymous,
  signInAnonymous,
} from "../src/engine/anonymous.js";
import { requestEmailChange } from "../src/engine/email-change.js";
import { decideDevice } from "../src/engine/oauth-device.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { passkeyRegistrationOptions, verifyPasskeyRegistration } from "../src/engine/passkeys.js";
import { changePassword } from "../src/engine/password.js";
import { addPhone, verifyAddPhone } from "../src/engine/phone.js";
import { updateProfile } from "../src/engine/profile.js";
import { enablePasskeyMethod } from "../src/engine/second-factor-methods.js";
import { type ResolvedSession, resolveSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { createApiToken } from "../src/engine/tokens.js";
import { enableTotp, setupTotp } from "../src/engine/totp.js";
import { setUsername } from "../src/engine/username.js";
import { draftUserRow } from "../src/engine/users.js";
import { ROUTES, type RouteKey } from "../src/http/route-list.js";
import { createRouter, type Route } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { createMemoryLimiter, systemClock } from "../src/index.js";
import type { LimiterPort } from "../src/limiter/port.js";
import { type ModelName, schema } from "../src/schema.js";
import { USER_CHILD_MODELS } from "../src/storage/sql.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post, settled, tokenFromMail } from "./helpers.js";
import { authorizeGet, oauthHandle, pkce, REDIRECT, registered } from "./oauth-helpers.js";
import { observed } from "./observe-helpers.js";
import { OPERATOR_SECRETS, operatorFixture, operatorHeader } from "./operator-helpers.js";
import { FAST } from "./password-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

/**
 * The routes that an anonymous session must not reach (plan 12i Task 6),
 * written out beside the constant. A key that leaves `ANONYMOUS_REFUSED`
 * keeps its row here, and the row fails.
 */
const REFUSED: readonly RouteKey[] = [
  "POST /reauth",
  "POST /reauth/passkey/options",
  "POST /reauth/email",
  "POST /user/update",
  "POST /user/change-email",
  "POST /user/change-email/verify",
  "POST /user/username",
  "POST /user/delete",
  "POST /user/delete/confirm",
  "POST /social/:provider/link",
  "POST /passkey/register/options",
  "POST /passkey/register/verify",
  "POST /password/change",
  "POST /phone/add",
  "POST /phone/add/verify",
  "POST /totp/setup",
  "POST /totp/enable",
  "POST /second-factor/passkey/options",
  "POST /second-factor/passkey/enable",
  "POST /second-factor/email/enable",
  "POST /organizations/create",
  "POST /organizations/invitations/accept",
  "POST /tokens",
  "POST /oauth/authorize",
  "POST /oauth/device",
];

afterEach(() => {
  vi.restoreAllMocks();
});

const KEYS = ROUTES.map((r) => `${r.method} ${r.path}` as RouteKey);
/** The routes whose entry declares `anonymous_refused`. The delete declares it for a session that is not anonymous. */
const DECLARING = ROUTES.filter((r) => (r.codes as readonly string[]).includes("anonymous_refused"))
  .map((r) => `${r.method} ${r.path}` as RouteKey)
  .filter((k) => k !== "POST /anonymous/delete");

/** Every feature that a route of `REFUSED` needs, with anonymous sign-in on. */
function features(extra: Partial<AuthConfig> = {}): Partial<AuthConfig> {
  return {
    password: { hash: FAST, uniformSignUp: false },
    social: { google: { clientId: "g", clientSecret: "g" } },
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE_URL] },
    organizations: {},
    oauth: {
      resources: [`${BASE_URL}/mcp`],
      registration: { cimd: false, dynamic: true },
      device: {},
    },
    username: {},
    phone: { sms: createRecordingSms(), regions: ["+1"], isolateLimiter: "allow" },
    anonymous: { isolateLimiter: "allow" },
    ...extra,
  };
}

/**
 * The engine, and a router whose handlers count their calls. The router
 * waits for the work after the answer, so a test reads the phone code that
 * a route sent (ruling 23 of plan 12i).
 */
function world(extra: Partial<AuthConfig> = {}) {
  const auth = makeAuth(features(extra));
  const calls: string[] = [];
  const routes = coreRoutes(auth.config).map(
    (r): Route => ({
      ...r,
      handler: (ctx) => {
        calls.push(r.key ?? r.path);
        return r.handler(ctx);
      },
    }),
  );
  return { auth, calls, handle: settled(createRouter(auth.config, routes)) };
}
type World = ReturnType<typeof world>;

let ip = 0;
/**
 * A request from a new IP, so the per-IP limit of the sign-in counts only
 * where a test means it. Core reads `cf-connecting-ip` by default
 * (`defaultClientIp`), so this header gives each request its own IP.
 */
const fromNewIp = () => ({ "cf-connecting-ip": `198.51.100.${++ip}` });

/** The session token of an answer that set the session cookie. */
function cookieToken(res: Response): string {
  const line = res.headers.getSetCookie().find((s) => s.startsWith("__Host-tempo_session="));
  const token = line?.slice("__Host-tempo_session=".length).split(";")[0];
  if (!token) throw new Error("the answer set no session cookie");
  return token;
}

/** One anonymous sign-in through the route: the token, the cookie, and the resolved session. */
async function anonymous(w: {
  auth: { config: ResolvedConfig };
  handle: (request: Request) => Promise<Response>;
}) {
  const res = await w.handle(post("/auth/anonymous/sign-in", {}, fromNewIp()));
  if (res.status !== 200) throw new Error(`the sign-in answered ${res.status}`);
  const token = cookieToken(res);
  const resolved = await resolveSession(w.auth.config, token);
  if (!resolved) throw new Error("no session");
  return { token, cookie: `__Host-tempo_session=${token}`, resolved };
}

/** The rows of every model, so a test sees any write. */
async function dump(w: World): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const model of Object.keys(schema) as ModelName[])
    out[model] = await w.auth.storage.findMany(model, []);
  return out;
}

/** A request to the route of `key` with `credential`. A POST is a trusted JSON post. */
function requestOf(key: RouteKey, credential: Record<string, string>): Request {
  const [method, path = ""] = key.split(" ");
  const url = `/auth${path.replace(":provider", "google")}`;
  if (method === "POST") return post(url, {}, credential);
  return new Request(`${BASE_URL}${url}`, { headers: { ...credential, origin: APP_ORIGIN } });
}

const users = (w: Pick<World, "auth">) => w.auth.storage.findMany("user", []);

describe("anonymous sign-in (plan 12i Task 6)", () => {
  it("creates a user with no address and opens a session with via anonymous", async () => {
    const afterCreate = vi.fn();
    const w = world({ hooks: { session: { afterCreate } } });
    const res = await w.handle(post("/auth/anonymous/sign-in", {}, fromNewIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: Record<string, unknown> };
    expect(body.token).toBe(cookieToken(res));
    expect(body.user).toMatchObject({ email: null, emailVerified: false, name: null });
    const [user, ...rest] = await users(w);
    expect(rest).toEqual([]);
    expect(user).toMatchObject({ email: null, name: null, isAnonymous: true, phone: null });
    expect(afterCreate).toHaveBeenCalledTimes(1);
    expect(afterCreate.mock.calls[0]?.[0]).toMatchObject({ via: "anonymous" });
    // The session reads back, with the null address in the answer.
    const session = await w.handle(
      get("/auth/session", { cookie: `__Host-tempo_session=${body.token}` }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: null } });
  });

  it("answers the live anonymous session again and creates nothing", async () => {
    const w = world();
    const first = await anonymous(w);
    const again = await w.handle(post("/auth/anonymous/sign-in", {}, { cookie: first.cookie }));
    expect(again.status).toBe(200);
    const body = (await again.json()) as { token: string; user: { id: string } };
    expect(body.token).toBe(first.token);
    expect(body.user.id).toBe(first.resolved.user.id);
    expect(await users(w)).toHaveLength(1);
    expect(await w.auth.storage.findMany("session", [])).toHaveLength(1);
    // The bearer form of the same session answers it too.
    const bearer = await w.handle(
      post("/auth/anonymous/sign-in", {}, { authorization: `Bearer ${first.token}` }),
    );
    expect(((await bearer.json()) as { token: string }).token).toBe(first.token);
    expect(await users(w)).toHaveLength(1);
  });

  it("answers conflict with a live session of another kind", async () => {
    const w = world();
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const before = await dump(w);
    const res = await w.handle(
      post("/auth/anonymous/sign-in", {}, { cookie: `__Host-tempo_session=${ada.token}` }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
    expect(await dump(w)).toEqual(before);
  });

  it("makes a new user when the cookie names no live session", async () => {
    const w = world();
    const res = await w.handle(
      post("/auth/anonymous/sign-in", {}, { cookie: `__Host-tempo_session=ts_${"a".repeat(43)}` }),
    );
    expect(res.status).toBe(200);
    expect(await users(w)).toHaveLength(1);
  });

  it("refuses a body with a key and a sign-up rule that names an address", async () => {
    const w = world();
    const body = await w.handle(post("/auth/anonymous/sign-in", { email: "a@example.com" }));
    expect(body.status).toBe(400);
    expect(await body.json()).toEqual({ error: "invalid_body" });
    const closed = world({ signUp: "invited" });
    const res = await closed.handle(post("/auth/anonymous/sign-in", {}, fromNewIp()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "sign_up_closed" });
    expect(await users(closed)).toEqual([]);
  });

  it("answers the refusal of a before hook and writes nothing", async () => {
    const { hookRefusal } = await import("../src/engine/hooks.js");
    const refused = world({
      hooks: {
        user: {
          beforeCreate: () => {
            throw hookRefusal("no");
          },
        },
      },
    });
    const res = await refused.handle(post("/auth/anonymous/sign-in", {}, fromNewIp()));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "hook_refused" });
    expect(await users(refused)).toEqual([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = world({
      hooks: {
        session: {
          // A JavaScript app can answer any value; the patch check refuses this key.
          beforeCreate: (() => ({ field: "x" })) as never,
        },
      },
    });
    const bad = await broken.handle(post("/auth/anonymous/sign-in", {}, fromNewIp()));
    expect(bad.status).toBe(500);
    expect(await bad.json()).toEqual({ error: "hook_failed" });
    expect(await users(broken)).toEqual([]);
  });

  it("checks the captcha when the app names the flow", async () => {
    const verify = vi.fn(async () => "fail" as const);
    const w = world({ captcha: { port: { verify }, flows: ["anonymous-sign-in"] } });
    const none = await w.handle(post("/auth/anonymous/sign-in", {}, fromNewIp()));
    expect(await none.json()).toEqual({ error: "captcha_required" });
    const failed = await w.handle(
      post("/auth/anonymous/sign-in", {}, { ...fromNewIp(), "x-captcha-response": "t" }),
    );
    expect(await failed.json()).toEqual({ error: "captcha_failed" });
    const down = world({
      captcha: {
        port: { verify: async () => "unavailable" as const },
        flows: ["anonymous-sign-in"],
        onUnavailable: "refuse",
      },
    });
    const refused = await down.handle(
      post("/auth/anonymous/sign-in", {}, { ...fromNewIp(), "x-captcha-response": "t" }),
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "captcha_unavailable" });
    expect(await users(w)).toEqual([]);
  });

  it("limits the sign-in by IP", async () => {
    const w = world();
    const same = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 10; i++)
      expect((await w.handle(post("/auth/anonymous/sign-in", {}, same))).status).toBe(200);
    const eleventh = await w.handle(post("/auth/anonymous/sign-in", {}, same));
    expect(eleventh.status).toBe(429);
    expect(await eleventh.json()).toEqual({ error: "rate_limited" });
    expect(await users(w)).toHaveLength(10);
    // The limit is per IP: another IP gets in in the same hour.
    expect((await w.handle(post("/auth/anonymous/sign-in", {}, fromNewIp()))).status).toBe(200);
    // A new hour opens the window again.
    w.auth.clock.advance(60 * 60 * 1000);
    expect((await w.handle(post("/auth/anonymous/sign-in", {}, same))).status).toBe(200);
  });

  it("caps the anonymous users of the deployment per day (ruling 25 M4)", async () => {
    const day = 24 * 60 * 60 * 1000;
    const o = observed({ anonymous: { isolateLimiter: "allow", dailyCap: 2 } });
    const signIn = () => o.auth.handle(post("/auth/anonymous/sign-in", {}, fromNewIp()));
    expect((await signIn()).status).toBe(200);
    expect((await signIn()).status).toBe(200);
    // A new IP: the per-IP limit allows it, and the cap of the deployment refuses it.
    const third = await signIn();
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "rate_limited" });
    expect(await o.storage.findMany("user", [])).toHaveLength(2);
    const hits = (await o.events()).filter((e) => e.name === "limit.hit");
    expect(hits.map((e) => e.family)).toEqual(["anonymous:all-day"]);
    // The window is 24 hours.
    o.clock.advance(day - 1000);
    expect((await signIn()).status).toBe(429);
    o.clock.advance(1000);
    expect((await signIn()).status).toBe(200);
  });

  it("counts no failed captcha against the daily cap (ruling 31 L-B)", async () => {
    const verify = vi.fn(async ({ token }: { token: string }) =>
      token === "good" ? ("pass" as const) : ("fail" as const),
    );
    const w = world({
      anonymous: { isolateLimiter: "allow", dailyCap: 1 },
      captcha: { port: { verify }, flows: ["anonymous-sign-in"] },
    });
    const signIn = (token: string) =>
      w.handle(
        post("/auth/anonymous/sign-in", {}, { ...fromNewIp(), "x-captcha-response": token }),
      );
    for (let i = 0; i < 3; i++)
      expect(await (await signIn("bad")).json()).toEqual({ error: "captcha_failed" });
    // The cap of 1 is still free: the three failures counted nothing.
    expect((await signIn("good")).status).toBe(200);
    const second = await signIn("good");
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited" });
    expect(await users(w)).toHaveLength(1);
  });

  it("answers not_found in process with anonymous off", async () => {
    const auth = makeAuth(features({ anonymous: false }));
    expect(
      await signInAnonymous(auth.config, { current: null, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const ada = await verifiedSession(auth, "ada@example.com");
    expect(await deleteAnonymous(auth.config, { session: ada })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("the anonymous config (plan 12i Task 6)", () => {
  const input = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: makeAuth().storage,
    mail: { send: async () => {} },
  };
  it("defaults ttlDays to 30 and refuses a value out of bounds", () => {
    expect(resolveConfig({ ...input, anonymous: { isolateLimiter: "allow" } }).anonymous).toEqual({
      ttlDays: 30,
      sweepBatch: 100,
      dailyCap: 1000,
    });
    expect(
      resolveConfig({
        ...input,
        anonymous: { isolateLimiter: "allow", ttlDays: 365, sweepBatch: 1, dailyCap: 100_000 },
      }).anonymous,
    ).toEqual({ ttlDays: 365, sweepBatch: 1, dailyCap: 100_000 });
    expect(resolveConfig({ ...input, anonymous: false }).anonymous).toBeNull();
    expect(resolveConfig(input).anonymous).toBeNull();
    for (const ttlDays of [0, 366, 1.5])
      expect(() =>
        resolveConfig({ ...input, anonymous: { isolateLimiter: "allow", ttlDays } }),
      ).toThrow("anonymous.ttlDays must be an integer from 1 to 365");
    for (const sweepBatch of [0, 101, 2.5])
      expect(() =>
        resolveConfig({ ...input, anonymous: { isolateLimiter: "allow", sweepBatch } }),
      ).toThrow("anonymous.sweepBatch must be an integer from 1 to 100");
    for (const dailyCap of [0, 100_001, 2.5])
      expect(() =>
        resolveConfig({ ...input, anonymous: { isolateLimiter: "allow", dailyCap } }),
      ).toThrow("anonymous.dailyCap must be an integer from 1 to 100000");
    expect(() => resolveConfig({ ...input, anonymous: { ttl: 3 } as never })).toThrow(
      "anonymous.ttl is not an option; core has ttlDays, sweepBatch, dailyCap, isolateLimiter",
    );
    expect(() => resolveConfig({ ...input, anonymous: true as never })).toThrow(
      "anonymous must be an object or false",
    );
  });

  it("refuses anonymous with an isolate limiter: the daily cap is per deployment (ruling 27)", () => {
    const message = "anonymous needs a shared limiter: the daily cap is per deployment";
    const shared: LimiterPort = { scope: "shared", allow: async () => true };
    // The default limiter is the memory limiter, which counts per isolate.
    expect(() => createAuth({ ...input, anonymous: {} })).toThrow(message);
    expect(() =>
      createAuth({ ...input, limiter: createMemoryLimiter(systemClock), anonymous: {} }),
    ).toThrow(message);
    // A limiter of the app with no scope counts as isolate.
    expect(() =>
      createAuth({ ...input, limiter: { allow: async () => true }, anonymous: {} }),
    ).toThrow(message);
    expect(() => createAuth({ ...input, anonymous: { isolateLimiter: "allow" } })).not.toThrow();
    expect(() => createAuth({ ...input, limiter: shared, anonymous: {} })).not.toThrow();
    expect(() => createAuth({ ...input, anonymous: { isolateLimiter: "yes" as "allow" } })).toThrow(
      'anonymous.isolateLimiter must be "allow" or absent',
    );
  });
});

describe("ANONYMOUS_REFUSED (plan 12i Task 6)", () => {
  it("holds each refused entry to a route of ROUTES", () => {
    for (const key of ANONYMOUS_REFUSED) expect(KEYS).toContain(key);
    expect([...ANONYMOUS_REFUSED].sort()).toEqual([...REFUSED].sort());
  });

  it("declares anonymous_refused at exactly the refused routes", () => {
    expect([...DECLARING].sort()).toEqual([...ANONYMOUS_REFUSED].sort());
  });

  it.each([...REFUSED])("refuses each listed route to an anonymous session: %s", async (key) => {
    const w = world();
    const a = await anonymous(w);
    for (const credential of [{ cookie: a.cookie }, { authorization: `Bearer ${a.token}` }]) {
      const before = await dump(w);
      w.calls.length = 0;
      const res = await w.handle(requestOf(key, credential));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "anonymous_refused" });
      expect(w.calls).toEqual([]);
      expect(await dump(w)).toEqual(before);
    }
  });

  it("lets an anonymous session read, refresh, and sign out", async () => {
    const w = world();
    const a = await anonymous(w);
    const cookie = { cookie: a.cookie };
    for (const key of [
      "GET /session",
      "GET /sessions",
      "GET /passkeys",
      "GET /identities",
    ] as const)
      expect((await w.handle(requestOf(key, cookie))).status, key).toBe(200);
    w.auth.clock.advance(2 * 24 * 60 * 60 * 1000);
    const refreshed = await w.handle(post("/auth/session/refresh", {}, cookie));
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ user: { email: null } });
    expect((await w.handle(post("/auth/sign-out", {}, cookie))).status).toBe(200);
    expect(await w.auth.storage.findMany("session", [])).toEqual([]);
  });

  it("decides the routes that joined the lane after Task 6 (ruling 31 join)", async () => {
    const w = world({
      social: {
        google: { clientId: "g", clientSecret: "g" },
        slack: { clientId: "sl", clientSecret: "s" },
      },
    });
    const a = await anonymous(w);
    const cookie = { cookie: a.cookie };
    const before = await dump(w);
    // The link of a preset of Task 14 is the link route: refused for every provider.
    const slack = await w.handle(post("/auth/social/slack/link", {}, cookie));
    expect(slack.status).toBe(403);
    expect(await slack.json()).toEqual({ error: "anonymous_refused" });
    // The phone remove of Task 5 is not listed: an anonymous user holds no phone.
    const removed = await w.handle(post("/auth/phone/remove", {}, cookie));
    expect(removed.status).toBe(404);
    expect(await removed.json()).toEqual({ error: "not_found" });
    expect(await dump(w)).toEqual(before);
    // The phone sign-in of Task 5 is a sign-in, not a change of this user: not listed.
    const request = await w.handle(post("/auth/phone/request", { phone: "+14155550100" }, cookie));
    expect(await request.json()).toEqual({ sent: true });
  });

  it("decides the operator user routes of plan 12f2: not listed, the operator guard refuses them (the move onto main)", async () => {
    const w = world({
      organizations: {
        platformRole: "operator",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      },
      operator: { users: true },
    });
    const a = await anonymous(w);
    const before = await dump(w);
    // A session needs the platform role, a second factor, and a verified address: an
    // anonymous user has none, so the guard answers operator_required before the body.
    for (const path of ["/auth/operator/users/update", "/auth/operator/users/delete"]) {
      const res = await w.handle(
        post(
          path,
          { userId: a.resolved.user.id, name: "Pat", reason: "Ticket 1" },
          { cookie: a.cookie },
        ),
      );
      expect([path, res.status, await res.json()]).toEqual([
        path,
        403,
        { error: "operator_required" },
      ]);
    }
    expect(await dump(w)).toEqual(before);
  });

  it("decides the invitation confirm of plan 12f2 Task 3: not listed, a sign-in that links nothing", async () => {
    const w = world({
      operator: {
        users: true,
        secrets: [{ name: "support", secretHash: "e".repeat(64), scopes: ["users"] }],
      },
    });
    const made = await operatorApi(w.auth.config).users.create({
      actor: { kind: "app", name: "support-tool" },
      email: "ivy@example.com",
      reason: "Ticket 1",
      ip: null,
      userAgent: null,
    });
    if (!made.ok) throw new Error(made.code);
    const token = tokenFromMail(w.auth.mail.at(-1)?.text ?? "");
    const a = await anonymous(w);
    const res = await w.handle(post("/auth/user/invite/confirm", { token }, { cookie: a.cookie }));
    expect(res.status).toBe(200);
    // The session of the invited user, and the anonymous user stays as it was: no upgrade.
    expect(await resolveSession(w.auth.config, cookieToken(res))).toMatchObject({
      user: { id: made.value.userId },
    });
    expect((await users(w)).map((u) => [u.id, u.isAnonymous]).sort()).toEqual(
      [
        [made.value.userId, false],
        [a.resolved.user.id, true],
      ].sort(),
    );
    expect(await resolveSession(w.auth.config, a.token)).not.toBeNull();
  });

  it("refuses a listed route to an anonymous user with anonymous off since", async () => {
    const w = world();
    const a = await anonymous(w);
    const off = makeAuth(features({ anonymous: false }));
    const handle = createRouter(
      { ...off.config, storage: w.auth.storage, clock: w.auth.clock },
      coreRoutes(off.config),
    );
    const res = await handle(requestOf("POST /tokens", { cookie: a.cookie }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "anonymous_refused" });
  });

  it("reads the session and the user once on a listed route: the handler takes the rows of the step", async () => {
    const w = world();
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const reads: string[] = [];
    const findOne = w.auth.storage.findOne.bind(w.auth.storage);
    w.auth.storage.findOne = ((m, where) => {
      reads.push(m);
      return findOne(m, where);
    }) as typeof w.auth.storage.findOne;
    const cookie = { cookie: `__Host-tempo_session=${ada.token}` };
    // A route of the list and a route off it: the same reads of the session and the user.
    for (const key of ["POST /user/update", "POST /sessions/revoke-others"] as const) {
      reads.length = 0;
      const res = await w.handle(
        post(
          `/auth${key.slice("POST ".length)}`,
          key === "POST /user/update" ? { name: "Ada" } : {},
          cookie,
        ),
      );
      expect(res.status, key).toBe(200);
      expect([
        key,
        reads.filter((m) => m === "session").length,
        reads.filter((m) => m === "user").length,
      ]).toEqual([key, 1, 1]);
    }
  });

  it("serves a listed route to a session that is not anonymous", async () => {
    const w = world();
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const res = await w.handle(
      post("/auth/user/update", { name: "Ada" }, { cookie: `__Host-tempo_session=${ada.token}` }),
    );
    expect(res.status).toBe(200);
    expect(w.calls).toEqual(["POST /user/update"]);
  });
});

describe("the anonymous branch of provedAccount and handleProved (plan 12i Task 6, ruling 15)", () => {
  it("refuses each gate of a way in or a privilege to an anonymous user in process", async () => {
    const w = world({ totp: {} });
    const a = await anonymous(w);
    const session: ResolvedSession = a.resolved;
    const { config } = w.auth;
    const before = await dump(w);
    const refused = { ok: false, code: "email_unverified", status: 403 };
    const answers = {
      passkeyOptions: await passkeyRegistrationOptions(config, { user: session.user }),
      passkeyVerify: await verifyPasskeyRegistration(config, { user: session.user, response: {} }),
      firstPassword: await changePassword(config, { session, newPassword: "a new password 1" }),
      totpEnable: await enableTotp(config, { session, code: "123456" }),
      passkeyMethod: await enablePasskeyMethod(config, { session, password: "x", response: {} }),
      profile: await updateProfile(config, { session, name: "Anon" }),
      apiToken: await createApiToken(config, { user: session.user, name: "ci" }),
      username: await setUsername(config, { session, username: "anon", ip: null, userAgent: null }),
      phone: await addPhone(config, { session, phone: "+14155550100", ip: null }),
      phoneVerify: await verifyAddPhone(config, {
        session,
        code: "123456",
        ip: null,
        userAgent: null,
      }),
      emailChange: await requestEmailChange(config, { session, newEmail: "a@example.com" }),
    };
    for (const [name, r] of Object.entries(answers)) expect([name, r]).toEqual([name, refused]);
    // The TOTP setup checks the password first, and an anonymous user has none.
    expect(
      await setupTotp(config, { userId: session.user.id, password: "correct horse battery" }),
    ).toMatchObject({ ok: false });
    expect(await dump(w)).toEqual(before);
  });

  it("denies the OAuth grant gates to an anonymous user", async () => {
    const h = oauthHandle({ anonymous: { isolateLimiter: "allow" }, oauth: oauthWithDevice() });
    const a = await anonymous({ auth: h, handle: h.auth.handle });
    const clientId = await registered(h);
    const { challenge } = await pkce();
    // The authorize step: the redirect carries access_denied, and no consent page.
    const res = await h.auth.handle(authorizeGet({ clientId, challenge }, a.cookie));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    // The device approve: the page of the code answers unverified, and no grant.
    const tvClient = await h.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        client_name: "Living room TV",
        grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
      }),
    );
    const tv = ((await tvClient.json()) as { client_id: string }).client_id;
    const started = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/device_authorization`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: tv,
          scope: "mcp:read",
          resource: `${BASE_URL}/mcp`,
        }).toString(),
      }),
    );
    expect(started.status).toBe(200);
    const { user_code } = (await started.json()) as { user_code: string };
    const step = await decideDevice(h.config, {
      userCode: user_code,
      decision: "allow",
      session: a.resolved,
      ip: null,
    });
    expect(step).toMatchObject({ kind: "code", error: "unverified" });
    expect(await h.storage.findMany("oauthConsent", [])).toEqual([]);
  });
});

/** The OAuth config of oauthHandle with the device grant on. */
function oauthWithDevice(): NonNullable<AuthConfig["oauth"]> {
  return {
    resources: [`${BASE_URL}/mcp`, `${BASE_URL}/files`],
    scopes: { "mcp:read": "Read your documents", "mcp:write": "Change your documents" },
    registration: { cimd: false, dynamic: true },
    device: {},
  };
}

describe("the anonymous delete (plan 12i Task 6)", () => {
  it("deletes the anonymous user with no fresh rule", async () => {
    const beforeDelete = vi.fn();
    const afterDelete = vi.fn();
    const afterEnd = vi.fn();
    const w = world({
      hooks: { user: { beforeDelete, afterDelete }, session: { afterEnd } },
      session: { freshMinutes: 5 },
    });
    const a = await anonymous(w);
    const other = await anonymous(w);
    // Past the fresh window: the session is the only key of the user.
    w.auth.clock.advance(10 * 60 * 1000);
    const res = await w.handle(post("/auth/anonymous/delete", {}, { cookie: a.cookie }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie().some((s) => s.startsWith("__Host-tempo_session=;"))).toBe(
      true,
    );
    expect((await users(w)).map((u) => u.id)).toEqual([other.resolved.user.id]);
    expect(
      await w.auth.storage.findMany("session", [
        { field: "userId", op: "eq", value: a.resolved.user.id },
      ]),
    ).toEqual([]);
    expect(beforeDelete).toHaveBeenCalledTimes(1);
    expect(beforeDelete.mock.calls[0]?.[0]).toMatchObject({
      user: { id: a.resolved.user.id },
      organizations: [],
    });
    expect(afterDelete).toHaveBeenCalledTimes(1);
    expect(afterDelete.mock.calls[0]?.[0]).toMatchObject({ user: { id: a.resolved.user.id } });
    expect(afterEnd).toHaveBeenCalledTimes(1);
    expect(afterEnd.mock.calls[0]?.[0]).toMatchObject({ reason: "account_deleted" });
    // The token answers 401 after the delete.
    expect((await w.handle(get("/auth/session", { cookie: a.cookie }))).status).toBe(401);
  });

  it("refuses the delete to a session that is not anonymous", async () => {
    const w = world();
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const before = await dump(w);
    const res = await w.handle(
      post("/auth/anonymous/delete", {}, { cookie: `__Host-tempo_session=${ada.token}` }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "anonymous_refused" });
    expect(await dump(w)).toEqual(before);
    expect((await w.handle(post("/auth/anonymous/delete", {}))).status).toBe(401);
  });

  it("answers the refusal of user.beforeDelete and keeps the user", async () => {
    const { hookRefusal } = await import("../src/engine/hooks.js");
    const w = world({
      hooks: {
        user: {
          beforeDelete: () => {
            throw hookRefusal("keep");
          },
        },
      },
    });
    const a = await anonymous(w);
    const res = await w.handle(post("/auth/anonymous/delete", {}, { cookie: a.cookie }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "hook_refused" });
    expect(await users(w)).toHaveLength(1);
    expect(await w.auth.storage.findMany("session", [])).toHaveLength(1);
    const broken = world({
      hooks: {
        user: {
          beforeDelete: () => {
            throw new Error("down");
          },
        },
      },
    });
    const b = await anonymous(broken);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await broken.handle(post("/auth/anonymous/delete", {}, { cookie: b.cookie }));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "hook_failed" });
    expect(await users(broken)).toHaveLength(1);
  });

  it("limits the delete by user and checks the body", async () => {
    const w = world({
      hooks: {
        user: {
          beforeDelete: async () => {
            const { hookRefusal } = await import("../src/engine/hooks.js");
            throw hookRefusal("keep");
          },
        },
      },
    });
    const a = await anonymous(w);
    const bad = await w.handle(post("/auth/anonymous/delete", { x: 1 }, { cookie: a.cookie }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_body" });
    for (let i = 0; i < 5; i++)
      expect(
        (await w.handle(post("/auth/anonymous/delete", {}, { cookie: a.cookie }))).status,
      ).toBe(403);
    const sixth = await w.handle(post("/auth/anonymous/delete", {}, { cookie: a.cookie }));
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ error: "rate_limited" });
  });

  it("deletes nothing when the proof session ended after the router read it (ruling 25 L2)", async () => {
    const afterDelete = vi.fn();
    const w = world({ hooks: { user: { afterDelete } } });
    const a = await anonymous(w);
    // A sign-out in parallel ends the session after the router step resolved it.
    expect((await w.handle(post("/auth/sign-out", {}, { cookie: a.cookie }))).status).toBe(200);
    expect(await deleteAnonymous(w.auth.config, { session: a.resolved })).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    expect((await users(w)).map((u) => u.id)).toEqual([a.resolved.user.id]);
    expect(afterDelete).not.toHaveBeenCalled();
  });

  it("holds ANONYMOUS_ROWS to the user child models", () => {
    expect(Object.keys(ANONYMOUS_ROWS).sort()).toEqual([...USER_CHILD_MODELS].sort());
    for (const [model, what] of Object.entries(ANONYMOUS_ROWS))
      expect([model, what.length > 0]).toEqual([model, true]);
  });
});

describe("the anonymous sweep (plan 12i Task 6)", () => {
  it("sweeps anonymous users past ttlDays with no live session, at most 100", async () => {
    const afterDelete = vi.fn();
    const w = world({
      limiter: { allow: async () => true },
      session: { ttlDays: 7, slidingRefreshDays: 1 },
      hooks: { user: { afterDelete } },
    });
    const made = [];
    for (let i = 0; i < 102; i++) made.push(await anonymous(w));
    // The clock stands still, so the 102 users share one createdAt, and the read orders them
    // by id. The live user is the lowest id: it is the first row of each read of the tie
    // group. Only the `held` set keeps it out of the next page (ruling 31 L-A).
    expect(new Set(made.map((m) => m.resolved.user.createdAt.getTime())).size).toBe(1);
    const live = made.reduce((a, b) => (b.resolved.user.id < a.resolved.user.id ? b : a));
    const day = 24 * 60 * 60 * 1000;
    // 31 days on. The live user reads its session each day, so the sliding refresh keeps it.
    for (let d = 0; d < 31; d++) {
      w.auth.clock.advance(day);
      expect(await resolveSession(w.auth.config, live.token)).not.toBeNull();
    }
    const first = await sweepExpired(w.auth.config);
    expect(first.anonymousUsers).toBe(100);
    expect(afterDelete).toHaveBeenCalledTimes(100);
    expect(await users(w)).toHaveLength(2);
    const second = await sweepExpired(w.auth.config);
    expect(second.anonymousUsers).toBe(1);
    expect((await users(w)).map((u) => u.id)).toEqual([live.resolved.user.id]);
    expect((await sweepExpired(w.auth.config)).anonymousUsers).toBe(0);
  });

  it("keeps a user that is not anonymous: a verified address and a phone sign-up (ruling 25 M3)", async () => {
    const sms = createRecordingSms();
    const w = world({
      limiter: { allow: async () => true },
      session: { ttlDays: 7 },
      phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    });
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const phone = "+14155550100";
    expect((await w.handle(post("/auth/phone/request", { phone }, fromNewIp()))).status).toBe(200);
    const code = /^(\d+) is your /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
    const verified = await w.handle(post("/auth/phone/verify", { phone, code }, fromNewIp()));
    expect(verified.status).toBe(200);
    const phoneUser = ((await verified.json()) as { user: { id: string } }).user.id;
    const guest = await anonymous(w);
    // Past the 30 days of anonymous.ttlDays and the 7 days of each session: no session is live.
    w.auth.clock.advance(31 * 24 * 60 * 60 * 1000);
    const kept = await users(w);
    expect(kept.find((u) => u.id === phoneUser)).toMatchObject({ email: null, isAnonymous: false });
    expect((await sweepExpired(w.auth.config)).anonymousUsers).toBe(1);
    expect((await users(w)).map((u) => u.id).sort()).toEqual([ada.user.id, phoneUser].sort());
    expect((await users(w)).some((u) => u.id === guest.resolved.user.id)).toBe(false);
  });

  it("deletes the session rows of a swept user that are past the cap but not past expiresAt (ruling 25 L1)", async () => {
    const opened = world({
      limiter: { allow: async () => true },
      session: { ttlDays: 7 },
      anonymous: { isolateLimiter: "allow", ttlDays: 1 },
    });
    const a = await anonymous(opened);
    // The app then turns on an absolute cap of 1 day. The session keeps its expiresAt.
    const w = world({
      storage: opened.auth.storage,
      clock: opened.auth.clock,
      limiter: { allow: async () => true },
      session: { ttlDays: 7, absoluteDays: 1 },
      anonymous: { isolateLimiter: "allow", ttlDays: 1 },
    });
    // Two days on: the cap ends the session, and its expiresAt is 5 days ahead.
    opened.auth.clock.advance(2 * 24 * 60 * 60 * 1000);
    const rows = await opened.auth.storage.findMany("session", []);
    expect(rows.map((r) => r.expiresAt > opened.auth.clock.now())).toEqual([true]);
    expect((await sweepExpired(w.auth.config)).anonymousUsers).toBe(1);
    expect(await users(opened)).toEqual([]);
    expect(
      await opened.auth.storage.findMany("session", [
        { field: "userId", op: "eq", value: a.resolved.user.id },
      ]),
    ).toEqual([]);
  });

  it("deletes at most anonymous.sweepBatch users per sweep (ruling 25 M1)", async () => {
    const afterDelete = vi.fn();
    const w = world({
      limiter: { allow: async () => true },
      session: { ttlDays: 7 },
      anonymous: { isolateLimiter: "allow", sweepBatch: 3 },
      hooks: { user: { afterDelete } },
    });
    for (let i = 0; i < 5; i++) await anonymous(w);
    w.auth.clock.advance(31 * 24 * 60 * 60 * 1000);
    expect((await sweepExpired(w.auth.config)).anonymousUsers).toBe(3);
    expect(afterDelete).toHaveBeenCalledTimes(3);
    expect(await users(w)).toHaveLength(2);
    expect((await sweepExpired(w.auth.config)).anonymousUsers).toBe(2);
    expect(afterDelete).toHaveBeenCalledTimes(5);
  });

  it("takes the oldest anonymous user first by createdAt, not by id (ruling 25 L3)", async () => {
    const w = world({
      limiter: { allow: async () => true },
      anonymous: { isolateLimiter: "allow", sweepBatch: 1 },
    });
    // A Better Auth anonymous user keeps its random id through compat (plan 12i
    // Task 16), so an id has no time order. The newer user has the lower id.
    const t0 = w.auth.clock.now();
    const day = 24 * 60 * 60 * 1000;
    const guest = { email: null, emailVerified: false, name: null, isAnonymous: true };
    await w.auth.storage.create("user", draftUserRow({ ...guest, id: "zQ3kV9" }, t0));
    await w.auth.storage.create(
      "user",
      draftUserRow({ ...guest, id: "aB7pX2" }, new Date(t0.getTime() + day)),
    );
    w.auth.clock.advance(40 * day);
    expect((await sweepExpired(w.auth.config)).anonymousUsers).toBe(1);
    expect((await users(w)).map((u) => u.id)).toEqual(["aB7pX2"]);
  });

  it("keeps an anonymous user younger than ttlDays and counts 0 with anonymous off", async () => {
    const w = world({ limiter: { allow: async () => true }, session: { ttlDays: 7 } });
    const a = await anonymous(w);
    w.auth.clock.advance(8 * 24 * 60 * 60 * 1000);
    expect(await resolveSession(w.auth.config, a.token)).toBeNull();
    expect((await sweepExpired(w.auth.config)).anonymousUsers).toBe(0);
    expect(await users(w)).toHaveLength(1);
    const off = makeAuth();
    expect((await sweepExpired(off.config)).anonymousUsers).toBe(0);
  });
});

describe("the null address in the answers of an anonymous user (plan 12i Task 6)", () => {
  it("answers the operator reads of an anonymous user with a null address", async () => {
    const f = await operatorFixture({ config: { anonymous: { isolateLimiter: "allow" } } });
    const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
    const a = await anonymous({ auth: f.auth, handle });
    const id = a.resolved.user.id;
    const header = operatorHeader(OPERATOR_SECRETS.support);
    const list = await handle(get("/auth/operator/users?limit=50", header));
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { users: { id: string; email: string | null }[] };
    expect(listed.users.find((u) => u.id === id)).toMatchObject({ email: null });
    const search = await handle(get(`/auth/operator/users/search?id=${id}`, header));
    expect(await search.json()).toMatchObject({ users: [{ id, email: null }] });
    const one = await handle(get(`/auth/operator/users/get?userId=${id}`, header));
    expect(await one.json()).toMatchObject({ user: { id, email: null } });
  });

  it("redeems a handoff of an anonymous session with a null address", async () => {
    const auth = makeAuth({
      handoff: { schemes: ["consumera://"] },
      anonymous: { isolateLimiter: "allow" },
    });
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const a = await anonymous({ auth, handle });
    const { verifier, challenge } = await pkce();
    const q = `challenge=${challenge}&redirect=${encodeURIComponent("consumera://auth")}`;
    const page = await handle(get(`/auth/handoff/start?${q}`));
    const h =
      /data-continue="\/auth\/handoff\/continue\?h=(hs_[A-Za-z0-9_-]+)"/.exec(
        await page.text(),
      )?.[1] ?? "";
    const confirm = await handle(get(`/auth/handoff/continue?h=${h}`, { cookie: a.cookie }));
    expect(await confirm.text()).toContain("Signed in.");
    const res = await handle(
      new Request(`${BASE_URL}/auth/handoff/continue`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: BASE_URL,
          cookie: a.cookie,
        },
        body: new URLSearchParams({ h }).toString(),
      }),
    );
    const code = new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const redeem = await handle(post("/auth/handoff/redeem", { code, verifier }));
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toMatchObject({ user: { id: a.resolved.user.id, email: null } });
  });

  it("answers the in-process api of an anonymous user", async () => {
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: makeAuth().storage,
      mail: { send: async () => {} },
      anonymous: { isolateLimiter: "allow" },
    });
    const api = auth.api.anonymous;
    if (!api) throw new Error("no anonymous api");
    const made = await api.signIn({ current: null, ip: null, userAgent: null });
    if (!made.ok) throw new Error(made.code);
    const resolved = await auth.api.getSession(made.value.token);
    if (!resolved) throw new Error("no session");
    expect(await api.delete({ session: resolved })).toEqual({ ok: true, value: { ok: true } });
    expect(await auth.api.getSession(made.value.token)).toBeNull();
  });
});
