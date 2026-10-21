import { describe, expect, it } from "vitest";
import { SIGN_IN_ROUTES } from "../src/observe/events.js";
import { createObserver, unscopedOf } from "../src/observe/observer.js";
import type { AuthEvent } from "../src/observe/port.js";
import { BASE_URL, get, post, tokenFromMail } from "./helpers.js";
import { formPost, observed } from "./observe-helpers.js";
import { FAST } from "./password-helpers.js";

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

/** A magic link token that a first verify spent. */
async function spentLink(s: Observed): Promise<string> {
  await s.auth.handle(post("/auth/magic-link/request", { email: "ada@example.com" }));
  const token = tokenFromMail(s.mail.at(-1)?.text ?? "");
  const first = await s.auth.handle(post("/auth/magic-link/verify", { token }));
  expect(first.status).toBe(200);
  return token;
}

/**
 * One failing request for each sign-in route, with the session method that
 * the route opens and the provider of a social route. A key of
 * SIGN_IN_ROUTES with no row here fails the test.
 */
const FAILING: Readonly<
  Record<string, { via: string; provider?: string; make: (s: Observed) => Promise<Request> }>
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
    for (const key of keys) {
      const s = observed();
      const row = FAILING[key];
      expect(row, `a failing request for ${key}`).toBeDefined();
      if (!row) continue;
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
    expect(events.map((e) => e.name).sort()).toEqual(["hook.after_failed", "request"]);
    for (const e of events) {
      expect(e.traceId, e.name).toBe(res.headers.get("x-authtempo-trace"));
      expect(e.route, e.name).toBe("POST /password/sign-in");
      expect(e.rejected, e.name).toBeUndefined();
    }
  });

  it("marks an event of the construction config unscoped", async () => {
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
      { clock: { now: () => new Date("2026-01-01T00:00:00.000Z") }, hashSecret: () => "s" },
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
