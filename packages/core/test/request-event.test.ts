import { describe, expect, it, vi } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { authErrorRedirect } from "../src/http/redirect.js";
import { createRouter } from "../src/http/router.js";
import { SIGN_IN_ROUTES } from "../src/observe/events.js";
import type { AuthEvent } from "../src/observe/port.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { BASE_URL, get, post, tokenFromMail } from "./helpers.js";
import { REDIRECT, RESOURCE, SCOPES } from "./oauth-helpers.js";
import { formPost, observed } from "./observe-helpers.js";
import { FAST } from "./password-helpers.js";
import { fakeDns } from "./sso/helpers.js";

// Plan 12h Task 4 (spec 31 items 5 and 6): the request event and the sign-in failure.

type Observed = ReturnType<typeof observed>;

const only = (events: AuthEvent[], name: string) => events.filter((e) => e.name === name);

/** The error code of an answer: the JSON error, or the auth_error of its Location. */
async function answerCode(res: Response): Promise<string | undefined> {
  const location = res.headers.get("location");
  if (location !== null)
    return new URL(location, BASE_URL).searchParams.get("auth_error") ?? undefined;
  const body: unknown = await res.json();
  return typeof body === "object" && body !== null ? String(Reflect.get(body, "error")) : undefined;
}

/** The form post of a magic link sign-in with this `next`. Answers its redirect. */
async function linkSignIn(s: Observed, next: string): Promise<Response> {
  await s.auth.handle(post("/auth/magic-link/request", { email: "ada@example.com", next }));
  const token = tokenFromMail(s.mail.at(-1)?.text ?? "");
  return s.auth.handle(formPost("/auth/magic-link/verify", { token }));
}

/** A magic link token that a first verify spent. */
async function spentLink(s: Observed): Promise<string> {
  await s.auth.handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
  const token = tokenFromMail(s.mail.at(-1)?.text ?? "");
  const first = await s.auth.handle(post("/auth/magic-link/verify", { token }));
  expect(first.status).toBe(200);
  return token;
}

/** The config of the SSO sign-in routes of plan 12d: organizations, OIDC, SAML, and two fake resolvers. */
const SSO_ON: Partial<AuthConfig> = {
  organizations: {},
  sso: { oidc: true, saml: true, dns: [fakeDns("a", {}), fakeDns("b", {})] },
};

/**
 * One failing request for each sign-in route, with the session method that
 * the route opens and the provider of a social route. `over` is the config
 * that mounts the route. A key of SIGN_IN_ROUTES with no row here fails the
 * test.
 */
const FAILING: Readonly<
  Record<
    string,
    {
      via: string;
      provider?: string;
      over?: Partial<AuthConfig>;
      make: (s: Observed) => Promise<Request>;
    }
  >
> = {
  "POST /password/sign-in": {
    via: "password",
    make: async () =>
      post("/auth/password/sign-in", { email: "ada@example.com", password: "wrong password 1" }),
  },
  "GET /magic-link/verify": {
    via: "magic_link",
    make: async () => get("/auth/magic-link/verify?token=short"),
  },
  // A form post of a spent link answers a redirect with auth_error, not a 4xx.
  "POST /magic-link/verify": {
    via: "magic_link",
    make: async (s) => formPost("/auth/magic-link/verify", { token: await spentLink(s) }),
  },
  "POST /otp/verify": {
    via: "email_otp",
    make: async () => post("/auth/otp/verify", { email: "ada@example.com", code: "000000" }),
  },
  // Plan 12i Task 5: a code for a number that got none.
  "POST /phone/verify": {
    via: "phone",
    over: { phone: { sms: createRecordingSms(), regions: ["+1"], isolateLimiter: "allow" } },
    make: async () => post("/auth/phone/verify", { phone: "+14155550100", code: "000000" }),
  },
  // Plan 12i Task 6: a sign-in over the limit of one IP.
  "POST /anonymous/sign-in": {
    via: "anonymous",
    over: { anonymous: {}, limiter: { allow: async () => false } },
    make: async () => post("/auth/anonymous/sign-in", {}),
  },
  "POST /passkey/authenticate/verify": {
    via: "passkey",
    make: async () => post("/auth/passkey/authenticate/verify", {}),
  },
  "POST /handoff/redeem": {
    via: "handoff",
    make: async () => post("/auth/handoff/redeem", { code: "spent", verifier: "x" }),
  },
  "GET /social/:provider/callback": {
    via: "social",
    provider: "google",
    make: async () => get("/auth/social/google/callback?code=c1&state=nope"),
  },
  "POST /social/apple/callback": {
    via: "social",
    provider: "apple",
    make: async () => formPost("/auth/social/apple/callback", { code: "c1", state: "nope" }),
  },
  // A state that no start wrote: the step `state` answers sso_failed (plan 12d).
  "GET /sso/:connectionId/callback": {
    via: "sso",
    over: SSO_ON,
    make: async () => get("/auth/sso/c1/callback?code=c1&state=nope"),
  },
  // A RelayState that no start wrote: the step `request` answers sso_failed.
  "POST /sso/:connectionId/acs": {
    via: "sso",
    over: SSO_ON,
    make: async () => formPost("/auth/sso/c1/acs", { SAMLResponse: "PHg+", RelayState: "nope" }),
  },
};

describe("the request event (plan 12h Task 4)", () => {
  it("emits one request event for each answer, with its route key", async () => {
    const s = observed();
    const res = await s.auth.handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
    expect(res.status).toBe(200);
    const requests = only(await s.events(), "request");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      level: "info",
      route: "POST /magic-link/request",
      method: "POST",
      status: 200,
      outcome: "ok",
      // The fake mail send moves the clock by 25 ms.
      durationMs: 25,
      traceId: res.headers.get("x-authtempo-trace"),
    });
    expect(requests[0]).not.toHaveProperty("code");
    expect(requests[0]).not.toHaveProperty("rejected");
  });

  it("reports the request events that a full buffer drops at the head of the next batch", async () => {
    // A real full buffer of a real Auth (plan 12h Task 12): 12 answers, room for 10 events.
    const s = observed({}, { buffer: 10 });
    for (let i = 0; i < 12; i++) await s.auth.handle(get("/auth/health"));
    expect(s.auth.observe.stats()).toEqual({
      buffered: 10,
      dropped: { buffer_full: 2, sink_timeout: 0, sink_threw: 0 },
    });
    const events = await s.events();
    expect(events.map((e) => e.name)).toEqual(["observe.dropped", ...Array(10).fill("request")]);
    expect(events[0]).toMatchObject({ buffer_full: 2, sink_timeout: 0, sink_threw: 0 });
  });

  it("names the code and the outcome of a failure", async () => {
    const s = observed();
    const bad = await s.auth.handle(post("/auth/magic-link/request", { nope: 1 }));
    const denied = await s.auth.handle(get("/auth/sessions"));
    let limited = bad;
    for (let i = 0; i < 20 && limited.status !== 429; i++)
      limited = await s.auth.handle(post("/auth/magic-link/request", { email: "bob@example.com" }));
    expect([bad.status, denied.status, limited.status]).toEqual([400, 401, 429]);
    s.stop();
    const thrown = await s.auth.handle(
      post("/auth/magic-link/request", { email: "cy@example.com" }),
    );
    expect(thrown.status).toBe(500);
    const events = await s.events();
    const of = (res: Response) =>
      events.filter(
        (e) => e.name === "request" && e.traceId === res.headers.get("x-authtempo-trace"),
      );
    expect(of(bad)).toMatchObject([{ outcome: "client_error", status: 400, code: "invalid_body" }]);
    expect(of(denied)).toMatchObject([{ outcome: "denied", status: 401, code: "unauthorized" }]);
    expect(of(limited)).toMatchObject([{ outcome: "limited", status: 429, code: "rate_limited" }]);
    expect(of(thrown)).toMatchObject([{ outcome: "server_error", status: 500, code: "internal" }]);
    expect(only(events, "error.internal")).toMatchObject([
      { traceId: thrown.headers.get("x-authtempo-trace"), route: "POST /magic-link/request" },
    ]);
  });

  it("reads the code of a redirect", async () => {
    const s = observed();
    const token = await spentLink(s);
    // A GET of a well-formed link answers the confirm page (plan 2b), so the
    // spent link is the form post of the confirm page.
    const res = await s.auth.handle(formPost("/auth/magic-link/verify", { token }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("auth_error=invalid_token");
    const event = only(await s.events(), "request").at(-1);
    expect(event).toMatchObject({
      route: "POST /magic-link/verify",
      status: 302,
      outcome: "client_error",
      code: "invalid_token",
    });
  });

  it("reads no failure from the next of a sign-in that succeeds", async () => {
    // The client chooses the next, and safeNext keeps its query (rulings 16 and 19 of plan 12h).
    // "/?auth_error=x" lands on the exact URL of an auth error redirect, with no mark.
    for (const next of ["/home?auth_error=invalid_token", "/x?error=1", "/?auth_error=x"]) {
      const s = observed();
      const res = await linkSignIn(s, next);
      expect(res.status, next).toBe(302);
      expect(res.headers.get("location"), next).toBe(`${BASE_URL}${next}`);
      expect(res.headers.get("set-cookie"), next).toContain("__Host-tempo_session=");
      const events = await s.events();
      expect(only(events, "request").at(-1), next).toMatchObject({
        route: "POST /magic-link/verify",
        status: 302,
        outcome: "redirect",
      });
      expect(only(events, "request").at(-1), next).not.toHaveProperty("code");
      expect(only(events, "sign_in"), next).not.toContainEqual(
        expect.objectContaining({ outcome: "failure" }),
      );
    }
  });

  it("reads the OAuth error of an authorize redirect to a registered redirect_uri", async () => {
    const s = observed({
      oauth: {
        resources: [RESOURCE],
        scopes: SCOPES,
        registration: { cimd: false, dynamic: true },
      },
    });
    const reg = await s.auth.handle(
      post("/auth/oauth/register", { redirect_uris: [REDIRECT], client_name: "Test client" }),
    );
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    // A response_type other than code: the error goes back to the redirect_uri (RFC 6749 section 4.1.2.1).
    const query = new URLSearchParams({
      client_id,
      redirect_uri: REDIRECT,
      response_type: "token",
      state: "s1",
    });
    const res = await s.auth.handle(get(`/auth/oauth/authorize?${query}`));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("unsupported_response_type");
    expect(only(await s.events(), "request").at(-1)).toMatchObject({
      route: "GET /oauth/authorize",
      status: 302,
      outcome: "client_error",
      code: "unsupported_response_type",
    });
  });

  it("keeps no code of a redirect that is not a listed code", async () => {
    const batches: AuthEvent[][] = [];
    const config = resolveConfig({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      observe: { sink: { write: (b) => void batches.push([...b]) } },
    });
    // A route stub of the router: a marked auth error redirect with a code outside the list.
    const handle = createRouter(config, [
      {
        method: "GET",
        path: "/stub",
        handler: async () => authErrorRedirect(config, "not_a_listed_code"),
      },
    ]);
    const res = await handle(get("/auth/stub"));
    expect(res.headers.get("location")).toBe(`${BASE_URL}/?auth_error=not_a_listed_code`);
    await config.observe.flush();
    const [event] = only(batches.flat(), "request");
    expect(event).toMatchObject({ route: "unmatched", status: 302, outcome: "client_error" });
    expect(event).not.toHaveProperty("code");
    // The router drops the code before the emit, so the observer marks no rejected field.
    expect(event?.rejected).toBeUndefined();
  });

  it("answers 500 with the trace header when a route returns immutable headers", async () => {
    const batches: AuthEvent[][] = [];
    const config = resolveConfig({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      observe: { sink: { write: (b) => void batches.push([...b]) } },
    });
    // Response.redirect answers immutable headers, so the set of the trace header throws.
    const fixed = async () => Response.redirect(`${BASE_URL}/next`, 302);
    const handle = createRouter(config, [
      { method: "GET", path: "/stub", handler: fixed },
      { method: "POST", path: "/stub", handler: fixed, preflight: fixed },
    ]);
    const res = await handle(get("/auth/stub"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    const traceId = res.headers.get("x-authtempo-trace");
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    // A preflight of a foreign origin that the route answers takes the same boundary.
    const pre = await handle(
      new Request(`${BASE_URL}/auth/stub`, {
        method: "OPTIONS",
        headers: { origin: "https://other.example" },
      }),
    );
    expect(pre.status).toBe(500);
    expect(pre.headers.get("x-authtempo-trace")).toMatch(/^[0-9a-f]{32}$/);
    await config.observe.flush();
    const events = batches.flat();
    expect(events.map((e) => [e.name, e.method, e.status])).toEqual([
      ["error.internal", "GET", undefined],
      ["request", "GET", 500],
      ["error.internal", "OPTIONS", undefined],
      ["request", "OPTIONS", 500],
    ]);
    expect(events[1]).toMatchObject({ traceId, outcome: "server_error", code: "internal" });
  });

  it("names an unmatched path, and the real method of a HEAD and a PUT", async () => {
    const s = observed();
    const res = await s.auth.handle(get("/auth/nope"));
    expect(res.status).toBe(404);
    // The router serves GET and POST only, so a HEAD and a PUT of a route path answer 404.
    const head = await s.auth.handle(new Request(`${BASE_URL}/auth/session`, { method: "HEAD" }));
    expect(head.status).toBe(404);
    const put = await s.auth.handle(
      new Request(`${BASE_URL}/auth/magic-link/request`, { method: "PUT", body: "{}" }),
    );
    expect(put.status).toBe(404);
    const requests = only(await s.events(), "request");
    expect(requests).toMatchObject([
      {
        route: "unmatched",
        method: "GET",
        status: 404,
        outcome: "client_error",
        code: "not_found",
      },
      { route: "unmatched", method: "HEAD", status: 404, code: "not_found" },
      { route: "unmatched", method: "PUT", status: 404, code: "not_found" },
    ]);
    for (const e of requests) expect(e.rejected).toBeUndefined();
  });

  it("emits a sign-in failure for each sign-in route that answers a failure", async () => {
    const keys = Object.keys(SIGN_IN_ROUTES);
    expect(keys.length).toBeGreaterThan(0);
    // Each row of FAILING is a sign-in route, so a lost row of SIGN_IN_ROUTES fails here.
    expect(Object.keys(FAILING).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      const row = FAILING[key];
      expect(row, `a failing request for ${key}`).toBeDefined();
      if (!row) continue;
      const s = observed(row.over);
      expect(SIGN_IN_ROUTES[key as keyof typeof SIGN_IN_ROUTES], key).toBe(row.via);
      const req = await row.make(s);
      const before = (await s.events()).length;
      const res = await s.auth.handle(req);
      const events = (await s.events()).slice(before);
      const code = await answerCode(res);
      expect(code, key).toBeDefined();
      const request = only(events, "request");
      expect(request, key).toMatchObject([{ route: key }]);
      expect(["client_error", "denied", "limited"], key).toContain(request[0]?.outcome);
      expect(only(events, "sign_in"), key).toEqual([
        expect.objectContaining({
          method: row.via,
          outcome: "failure",
          code,
          traceId: res.headers.get("x-authtempo-trace"),
          ...(row.provider ? { provider: row.provider } : {}),
        }),
      ]);
    }
  });

  it("emits no sign-in failure for an OPTIONS of a sign-in route", async () => {
    const s = observed();
    const res = await s.auth.handle(
      new Request(`${BASE_URL}/auth/password/sign-in`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
    const events = await s.events();
    expect(only(events, "request")).toMatchObject([
      { route: "POST /password/sign-in", method: "OPTIONS", status: 403, outcome: "denied" },
    ]);
    expect(only(events, "sign_in")).toEqual([]);
  });

  it("gives every event of a request its trace id", async () => {
    const s = observed();
    const start = await s.auth.handle(get("/auth/social/google/start?next=%2Fhome"));
    const bind = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const before = (await s.events()).length;
    // The token endpoint answers 502: the callback writes the fault line social.token_status.
    const res = await s.auth.handle(
      get(`/auth/social/google/callback?code=c1&state=${encodeURIComponent(state)}`, {
        cookie: bind,
      }),
    );
    expect(res.status).toBe(302);
    const events = (await s.events()).slice(before);
    const trace = res.headers.get("x-authtempo-trace");
    expect(events.map((e) => e.name).sort()).toEqual(["request", "sign_in", "social.token_status"]);
    for (const e of events) {
      expect(e.traceId, e.name).toBe(trace);
      expect(e.route, e.name).toBe("GET /social/:provider/callback");
      expect(e.rejected, e.name).toBeUndefined();
    }
  });

  it("gives the fault event of a password sign-in the trace id of its request", async () => {
    // An after hook of the app that throws: the sign-in answers 200 and writes hook.after_failed.
    const s = observed({
      password: { hash: FAST, uniformSignUp: false },
      hooks: {
        session: {
          afterCreate: () => {
            throw new Error("app hook down");
          },
        },
      },
    });
    const body = { email: "ada@example.com", password: "correct horse battery" };
    expect((await s.auth.handle(post("/auth/password/sign-up", body))).status).toBe(200);
    const before = (await s.events()).length;
    const res = await s.auth.handle(post("/auth/password/sign-in", body));
    expect(res.status).toBe(200);
    const events = (await s.events()).slice(before);
    // The sign_in event of the commit (Task 5) has the same scope.
    expect(events.map((e) => e.name).sort()).toEqual(["hook.after_failed", "request", "sign_in"]);
    for (const e of events) {
      expect(e.traceId, e.name).toBe(res.headers.get("x-authtempo-trace"));
      expect(e.route, e.name).toBe("POST /password/sign-in");
      expect(e.rejected, e.name).toBeUndefined();
    }
  });

  it("marks an event of the construction config unscoped", async () => {
    // The real module, not the event recorder: the check run refuses each
    // unscoped record, and this test makes two on purpose (plan 12h Task 12).
    const { createObserver, unscopedOf } = await vi.importActual<
      typeof import("../src/observe/observer.js")
    >("../src/observe/observer.js");
    const batches: AuthEvent[][] = [];
    const observer = createObserver(
      {
        sink: { write: (b) => void batches.push([...b]) },
        include: { ip: "none", userAgent: "none", email: "none" },
        trustTraceparent: false,
        buffer: 1000,
        flushTimeoutMs: 2000,
        readiness: false,
      },
      {
        clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
        hashSecret: () => "s",
        secrets: new Set(),
      },
    );
    unscopedOf(observer).emit({ name: "passkey.counter_moved" });
    unscopedOf(observer).emit({ name: "passkey.counter_moved" });
    observer.emit({ name: "passkey.counter_moved" });
    await observer.flush();
    const [first, second, plain] = batches.flat();
    expect(first).toMatchObject({ name: "passkey.counter_moved", rejected: ["unscoped"] });
    expect(second).toMatchObject({ rejected: ["unscoped"] });
    expect(first?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(second?.traceId).not.toBe(first?.traceId);
    expect(plain?.rejected).toBeUndefined();
  });
});

describe("the raw IP and the raw agent of a request (plan 12h Task 12, ruling 29)", () => {
  const SECRET = "0123456789abcdef0123456789abcdef";
  /** A social client secret in the form of an IP address: the app may set any text. */
  const IP_SECRET = "2001:db8::77";
  const RAW = { include: { ip: "raw", userAgent: "raw", email: "none" } } as const;

  /** One health request with these headers. Answers its request event. */
  async function requestEvent(s: Observed, headers: Record<string, string>): Promise<AuthEvent> {
    await s.auth.handle(get("/auth/health", headers));
    const [event] = only(await s.events(), "request");
    if (!event) throw new Error("no request event");
    return event;
  }

  it("lets no config secret in the agent or the IP header reach a sink event", async () => {
    const s = observed({}, RAW);
    await s.auth.handle(
      get("/auth/health", { "user-agent": `x ${SECRET}`, "cf-connecting-ip": SECRET }),
    );
    const events = await s.events();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(JSON.stringify(e), e.name).not.toContain(SECRET);
    expect(only(events, "request")[0]).toMatchObject({ userAgent: "x ***" });
  });

  it("scrubs a config secret in a raw IP that is an IP address", async () => {
    const s = observed({ social: { google: { clientId: "gid", clientSecret: IP_SECRET } } }, RAW);
    const event = await requestEvent(s, { "cf-connecting-ip": IP_SECRET });
    expect(JSON.stringify(event)).not.toContain(IP_SECRET);
    expect(event).not.toHaveProperty("ip");
  });

  it("drops a raw IP that is not an IP address, and keeps one that is", async () => {
    const bad = await requestEvent(observed({}, RAW), { "cf-connecting-ip": "not an address" });
    expect(bad).not.toHaveProperty("ip");
    const good = await requestEvent(observed({}, RAW), { "cf-connecting-ip": "203.0.113.9" });
    expect(good.ip).toBe("203.0.113.9");
  });

  it("scrubs the agent before the cut at 256 characters, so no head of a secret stays", async () => {
    const s = observed({}, RAW);
    const event = await requestEvent(s, { "user-agent": `${"a".repeat(240)}${SECRET}` });
    expect(event.userAgent).toBe(`${"a".repeat(240)}***`);
  });
});
