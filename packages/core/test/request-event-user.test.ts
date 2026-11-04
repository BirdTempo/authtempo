import { describe, expect, it } from "vitest";
import { ANONYMOUS_REFUSED } from "../src/engine/anonymous.js";
import { startHandoff } from "../src/engine/handoff.js";
import { createAdmin } from "../src/engine/operator/platform-role.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteContract } from "../src/http/contract/types.js";
import { IMPERSONATION_REFUSED } from "../src/http/impersonation-rules.js";
import { ROUTES, type RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { AuthEvent } from "../src/observe/port.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { SOCIAL } from "./every-feature.js";
import {
  BASE_URL,
  LONG_TEST_MS,
  makeAuth,
  post,
  recordAddress,
  recordCredential,
  tokenFromMail,
} from "./helpers.js";
import { observed } from "./observe-helpers.js";
import { FAST } from "./password-helpers.js";
import { enrolled, PASSWORD, verifiedSession } from "./totp-helpers.js";

// Plan 12n decision 17 (spec 31): the `request` event names the user of the
// session that a step of the request resolved. It names no user when no
// session resolved. So an operator ties a refusal of a route to an account.
// Ruling 37 of plan 12n puts one mark, `markRequestUser`, at each step that
// resolves the request's session. These steps are the handler's read, the
// two refusal steps of the router, the sign-out, the link callback, and an
// anonymous caller.

type Observed = ReturnType<typeof observed>;

/** The request events of the answer `res`, by its trace id. */
const requestsOf = (events: AuthEvent[], res: Response) =>
  events.filter((e) => e.name === "request" && e.traceId === res.headers.get("x-authtempo-trace"));

/** A magic link sign-in of `email` through the routes: the session cookie and the user id. */
async function signedIn(s: Observed, email: string) {
  await s.auth.handle(post("/auth/magic-link/request", { email }));
  const link = tokenFromMail(s.mail.at(-1)?.text ?? "");
  const res = await s.auth.handle(post("/auth/magic-link/verify", { token: link }));
  expect(res.status).toBe(200);
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
  const token = line?.split(";")[0]?.split("=")[1];
  if (!token) throw new Error("the sign-in set no session cookie");
  const user = await s.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error("the sign-in made no user");
  return { cookie: `__Host-tempo_session=${recordCredential(token)}`, userId: user.id };
}

describe("the user of the request event (plan 12n decision 17)", () => {
  it("names the user of the session of a signed-in write, on a success and on a refusal", async () => {
    const s = observed();
    const ada = await signedIn(s, "ada@example.com");
    const ended = await s.auth.handle(
      post("/auth/sessions/revoke-others", {}, { cookie: ada.cookie }),
    );
    expect(ended.status).toBe(200);
    // The session resolves before the body read, so the 400 of the body names Ada too.
    const refused = await s.auth.handle(post("/auth/sessions/revoke", {}, { cookie: ada.cookie }));
    expect([refused.status, await refused.json()]).toEqual([400, { error: "invalid_body" }]);
    const events = await s.events();
    expect(requestsOf(events, ended)).toMatchObject([
      { route: "POST /sessions/revoke-others", status: 200, userId: ada.userId },
    ]);
    expect(requestsOf(events, refused)).toMatchObject([
      { route: "POST /sessions/revoke", status: 400, code: "invalid_body", userId: ada.userId },
    ]);
  });

  it("names no user of an anonymous write, or of a write whose session does not resolve", async () => {
    const s = observed();
    const anonymous = await s.auth.handle(
      post("/auth/magic-link/request", { email: "bo@example.com" }),
    );
    expect(anonymous.status).toBe(200);
    // A cookie whose token names no session: the handler resolves none.
    const unknown = await s.auth.handle(
      post(
        "/auth/sessions/revoke-others",
        {},
        { cookie: `__Host-tempo_session=${recordCredential("x".repeat(43))}` },
      ),
    );
    expect(unknown.status).toBe(401);
    const events = await s.events();
    const [a, u] = [requestsOf(events, anonymous), requestsOf(events, unknown)];
    expect(a).toMatchObject([{ route: "POST /magic-link/request", status: 200 }]);
    expect(u).toMatchObject([
      { route: "POST /sessions/revoke-others", status: 401, code: "unauthorized" },
    ]);
    expect(a[0]).not.toHaveProperty("userId");
    expect(u[0]).not.toHaveProperty("userId");
  });

  it("names the user of the link on a link callback that the provider step refuses", async () => {
    // The provider's token endpoint of `observed` answers 502, after the read of the link's session.
    const s = observed();
    const ada = await signedIn(s, "ada@example.com");
    const started = await s.auth.handle(
      post("/auth/social/google/link", {}, { cookie: ada.cookie }),
    );
    const { url } = (await started.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";
    // The binding cookie of the flow: the one cookie of the start that is not the session cookie.
    const bind =
      started.headers
        .getSetCookie()
        .find((c) => !c.startsWith("__Host-tempo_session="))
        ?.split(";")[0] ?? "";
    const res = await s.auth.handle(
      new Request(`${BASE_URL}/auth/social/google/callback?code=c&state=${state}`, {
        headers: { cookie: `${ada.cookie}; ${recordCredential(bind)}` },
      }),
    );
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("auth_error")).toBe(
      "oauth_failed",
    );
    expect(requestsOf(await s.events(), res)).toMatchObject([
      { route: "GET /social/:provider/callback", status: 302, userId: ada.userId },
    ]);
  });
});

/** The contract of each route, by key. */
const CONTRACT: Record<string, RouteContract> = ROUTE_CONTRACT;
const KEYS = ROUTES.map((r) => `${r.method} ${r.path}` as RouteKey);
const entryOf = (key: RouteKey) => {
  const entry = ROUTES.find((r) => `${r.method} ${r.path}` === key);
  if (!entry) throw new Error(`no entry ${key}`);
  return entry;
};
/** A route that takes the session: its entry names the session cookie or a `ts_` bearer. */
const takesSession = (key: RouteKey) =>
  entryOf(key).auth.some((form) => form === "session" || form === "sessionCookie");

/** A PKCE challenge and an app redirect of the `example://` scheme, for the handoff routes. */
const HANDOFF = { challenge: "A".repeat(43), redirect: "example://auth" };

/**
 * The world of the walk: every feature on, so each route of `ROUTES` has
 * its handler, and a sink that keeps each event. Each person comes from the
 * flows of the product. Root and Op become operators by `createAdmin` of
 * the app. Op turns on TOTP and signs in after the grant (ruling 50 of plan
 * 12f). Op starts an impersonation of Ada through the route. A stranger
 * signs in as an anonymous user through the route.
 */
async function walkWorld() {
  const batches: AuthEvent[][] = [];
  // The walk makes no network call: a provider fetch would fail the route, not reach the network.
  const offline = (async () => {
    throw new Error("the walk makes no network call");
  }) as typeof fetch;
  const auth = makeAuth({
    password: { hash: FAST, uniformSignUp: false },
    social: { ...SOCIAL, fetch: offline },
    passkey: {
      rpID: "api.example.com",
      rpName: "Example",
      origins: [BASE_URL],
      relatedOrigins: true,
      signUp: { isolateLimiter: "allow" },
    },
    handoff: { schemes: ["example://"] },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      dynamicRoles: {},
      teams: {},
    },
    oauth: {
      resources: [`${BASE_URL}/mcp`],
      registration: { cimd: false, dynamic: true },
      device: {},
    },
    operator: {
      secrets: [
        {
          name: "default",
          secretHash: "0".repeat(64),
          scopes: ["keys", "secrets", "users", "sessions", "audit", "sso"],
        },
      ],
      users: true,
      impersonation: {},
    },
    sso: { dns: [{ name: "none", txt: async () => [] }] },
    scim: {},
    openapi: true,
    username: {},
    phone: { sms: createRecordingSms(), regions: ["+1"], isolateLimiter: "allow", signUp: true },
    anonymous: { isolateLimiter: "allow" },
    multiSession: {},
    observe: { sink: { write: (b) => void batches.push([...b]) }, readiness: true },
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const admin = async (email: string) => {
    const made = await createAdmin(auth.config, {
      actor: { kind: "app", name: "walk" },
      email,
      reason: "the operators of the walk",
      ip: null,
      userAgent: null,
    });
    if (!made.ok) throw new Error(made.code);
  };
  await verifiedSession(auth, "root@platform.example");
  await admin("root@platform.example");
  await verifiedSession(auth, "op@platform.example");
  await admin("op@platform.example");
  auth.clock.advance(1_000);
  const op = await enrolled(auth, "op@platform.example");
  const ada = await verifiedSession(auth, "ada@example.com");
  const cookieOf = (res: Response) => {
    const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
    const token = line?.slice("__Host-tempo_session=".length).split(";")[0];
    if (!token) throw new Error(`the answer ${res.status} set no session cookie`);
    return recordCredential(token);
  };
  const started = await handle(
    post(
      "/auth/operator/impersonate",
      { userId: ada.user.id, reason: "Ticket 9: a support call" },
      { cookie: `__Host-tempo_session=${op.session.token}` },
    ),
  );
  const impersonation = cookieOf(started);
  const stranger = cookieOf(await handle(post("/auth/anonymous/sign-in", {})));
  const strangerId = (await resolveSession(auth.config, stranger, "read-only"))?.user.id;
  if (!strangerId) throw new Error("the anonymous sign-in opened no session");
  let ip = 0;
  /** The request of `key` with `headers`: a sample value per path parameter, a sample query and body. */
  async function requestOf(key: RouteKey, headers: Record<string, string>): Promise<Request> {
    const entry = entryOf(key);
    // `:provider` takes a configured provider. Each other parameter takes a value of the id form.
    const path = entry.path.replace(":provider", "google").replace(/:([A-Za-z]+)/g, "p-$1");
    const sample = await sampleOf(key);
    const query = sample.query ? `?${new URLSearchParams(sample.query)}` : "";
    const url = `${BASE_URL}/auth${path}${query}`;
    ip++;
    const from = recordAddress(`198.18.${ip >> 8}.${ip & 255}`);
    const h = { "cf-connecting-ip": from, ...headers };
    if (entry.method === "GET") return new Request(url, { headers: h });
    // baseURL is the Origin: the router trusts it, and the consent and confirm forms take it only.
    if (entry.method === "DELETE")
      return new Request(url, { method: "DELETE", headers: { origin: BASE_URL, ...h } });
    const body = sample.body ?? {};
    const media = CONTRACT[key]?.body?.media ?? ["json"];
    if (media.includes("json"))
      return new Request(url, {
        method: entry.method,
        headers: { "content-type": "application/json", origin: BASE_URL, ...h },
        body: JSON.stringify(body),
      });
    return new Request(url, {
      method: entry.method,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL, ...h },
      body: new URLSearchParams(body as Record<string, string>).toString(),
    });
  }
  /**
   * The input of a route that reads its session only after its input
   * passes. Each other route takes no query and an empty body.
   */
  async function sampleOf(
    key: RouteKey,
  ): Promise<{ query?: Record<string, string>; body?: Record<string, string> }> {
    const handoff = async () => {
      const r = await startHandoff(auth.config, { ...HANDOFF, ip: null });
      if (!r.ok) throw new Error(r.code);
      return recordCredential(r.value.handoffId);
    };
    switch (key) {
      case "GET /handoff/start":
        return { query: HANDOFF };
      case "GET /handoff/continue":
        return { query: { h: await handoff() } };
      case "POST /handoff/continue":
        return { body: { h: await handoff() } };
      case "POST /organizations/invitations/decline":
        return { body: { token: "inv_none" } };
      default:
        return {};
    }
  }
  /** The `userId` of the one request event of the answer `res` to `key`, or null with none. */
  async function userOf(key: string, res: Response): Promise<string | null> {
    return (await eventOf(key, res)).userId ?? null;
  }
  /** The one request event of the answer `res` to `key`. */
  async function eventOf(key: string, res: Response) {
    await auth.config.observe.flush();
    const events = requestsOf(batches.flat(), res);
    expect(
      events.map((e) => e.route),
      key,
    ).toEqual([key]);
    return (events[0] ?? {}) as { status?: number; code?: string; userId?: string };
  }
  /**
   * The answer of each route, by route key. Each answer holds the status
   * and the code of its request event, and the `userId` of the event or null.
   */
  async function walk(
    keys: readonly RouteKey[],
    cookieFor: (key: RouteKey) => Promise<string | null>,
  ): Promise<{ users: Record<string, string | null>; answers: Record<string, string> }> {
    const users: Record<string, string | null> = {};
    const answers: Record<string, string> = {};
    for (const key of keys) {
      const token = await cookieFor(key);
      const headers = token === null ? {} : { cookie: `__Host-tempo_session=${token}` };
      const event = await eventOf(key, await handle(await requestOf(key, headers)));
      users[key] = event.userId ?? null;
      answers[key] = `${event.status} ${event.code ?? "-"}`;
    }
    return { users, answers };
  }
  return { auth, handle, ada, impersonation, stranger, strangerId, walk, userOf, sampleOf };
}

describe("the user of the request event on every route (ruling 37 of plan 12n)", () => {
  it("holds each sample input of the walk to its route's contract", async () => {
    const w = await walkWorld();
    for (const key of KEYS) {
      const sample = await w.sampleOf(key);
      if (sample.query) {
        const schema = CONTRACT[key]?.query?.schema;
        expect(schema?.safeParse(sample.query).success, `${key}: the sample query`).toBe(true);
      }
      if (sample.body) {
        const schema = CONTRACT[key]?.body?.schema;
        expect(schema?.safeParse(sample.body).success, `${key}: the sample body`).toBe(true);
      }
    }
  });

  // It walks every route of ROUTES with a fresh session per route. In the
  // whole-branch review run of 2026-11-03 it took 1237 ms (rr-final L-6 of
  // plan 12n). The 1-minute load was 1.7 to 13.8 on 18 cores.
  it("names the signed-in caller on each route that takes a session, refusals too, and no user on any other route", {
    timeout: LONG_TEST_MS,
  }, async () => {
    const w = await walkWorld();
    // A verified user with a fresh session per route. A route that deletes the user leaves the next route a new one.
    let made = 0;
    let caller = (await verifiedSession(w.auth, "bo@example.com")).user.id;
    const expected: Record<string, string | null> = {};
    const { users: seen, answers } = await w.walk(KEYS, async (key) => {
      const live = await w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: caller }]);
      if (!live) {
        made++;
        caller = (await verifiedSession(w.auth, `bo-${made}@example.com`)).user.id;
      }
      expected[key] = takesSession(key) ? caller : null;
      const { token } = await createSession(w.auth.config, {
        userId: caller,
        ip: null,
        userAgent: null,
        proved: true,
      });
      return recordCredential(token);
    });
    // The walk holds GET /session and POST /session/refresh too (ruling 27 a).
    expect(seen).toEqual(expected);
    const named = KEYS.filter((key) => expected[key] !== null);
    expect(named.length).toBeGreaterThan(100);
    // Most of them refuse the empty body or the caller's rank, and each refusal names the caller.
    expect(named.filter((key) => /^4/.test(answers[key] ?? "")).length).toBeGreaterThan(50);
  });

  it("names the impersonated user on each refusal of the impersonation step", async () => {
    const w = await walkWorld();
    const keys = KEYS.filter((key) => IMPERSONATION_REFUSED.has(key));
    expect(keys.length).toBeGreaterThan(0);
    const { users, answers } = await w.walk(keys, async () => w.impersonation);
    expect(answers).toEqual(Object.fromEntries(keys.map((k) => [k, "403 impersonation_session"])));
    expect(users).toEqual(Object.fromEntries(keys.map((key) => [key, w.ada.user.id])));
  });

  it("names the anonymous user on each refusal of the anonymous step", async () => {
    const w = await walkWorld();
    const keys = KEYS.filter((key) => ANONYMOUS_REFUSED.has(key));
    expect(keys.length).toBeGreaterThan(0);
    const { users, answers } = await w.walk(keys, async () => w.stranger);
    expect(answers).toEqual(Object.fromEntries(keys.map((k) => [k, "403 anonymous_refused"])));
    expect(users).toEqual(Object.fromEntries(keys.map((key) => [key, w.strangerId])));
  });

  it("names no user on any route of a request with no session", async () => {
    const w = await walkWorld();
    const { users } = await w.walk(KEYS, async () => null);
    expect(users).toEqual(Object.fromEntries(KEYS.map((key) => [key, null])));
  });

  it("names an anonymous caller of a sign-in, on a success and on a refusal, and no other caller", async () => {
    const w = await walkWorld();
    const bo = await verifiedSession(w.auth, "bo@example.com");
    const asCaller = (token: string) => ({ cookie: `__Host-tempo_session=${token}` });
    const sends = (cookie: Record<string, string>) => [
      post("/auth/magic-link/request", { email: "new@example.com" }, cookie),
      post("/auth/password/sign-in", { email: "bo@example.com", password: `${PASSWORD}!` }, cookie),
    ];
    const rows: [string, number, string | null][] = [];
    for (const [who, cookie] of [
      ["stranger", asCaller(w.stranger)],
      ["bo", asCaller(bo.token)],
    ] as const) {
      for (const req of sends(cookie)) {
        const key = `POST ${new URL(req.url).pathname.slice("/auth".length)}`;
        const res = await w.handle(req);
        rows.push([who, res.status, await w.userOf(key, res)]);
      }
    }
    // A signed-in caller who is not anonymous: the sign-in acts on no session of it, so no user.
    expect(rows).toEqual([
      ["stranger", 200, w.strangerId],
      ["stranger", 401, w.strangerId],
      ["bo", 200, null],
      ["bo", 401, null],
    ]);
  });
});
