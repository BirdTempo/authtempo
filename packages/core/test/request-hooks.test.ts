import { describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "../src/config.js";
import { requestEmailOtp } from "../src/engine/email-otp.js";
import {
  hookRefusal,
  type RequestAfterEvent,
  type RequestHookEvent,
  type RequestHooks,
} from "../src/engine/hooks.js";
import {
  BODY_CAP_FLOOR,
  BODY_CAPS,
  bindBodyRoute,
  hookBodyBytes,
  readBodyBytes,
} from "../src/http/body-cap.js";
import type { RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { AuthEvent } from "../src/observe/port.js";
import { get, makeAuth, post, recordCredential, tokenFromMail } from "./helpers.js";
import { observed } from "./observe-helpers.js";

const ADDRESS = "a@example.com";
const IP = { "cf-connecting-ip": "203.0.113.9" };

/** An auth with the request hooks of `request`, and its router. */
function withHooks(request: RequestHooks, more: Parameters<typeof makeAuth>[0] = {}) {
  const auth = makeAuth({ hooks: { request }, ...more });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  return { ...auth, handle };
}

const ask = (body: unknown = { email: ADDRESS }, headers: Record<string, string> = IP) =>
  post("/auth/magic-link/request", body, headers);

describe("the config of hooks.request", () => {
  const base = () => {
    const { storage } = makeAuth();
    return {
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: ["https://app.example.com"],
      storage,
      mail: { send: async () => {} },
    };
  };

  it("has no request hook by default, and takes the two points", () => {
    expect(resolveConfig(base()).hooks.request).toEqual({});
    const resolved = resolveConfig({
      ...base(),
      hooks: { request: { before() {}, after() {} } },
    }).hooks.request;
    expect(Object.keys(resolved).sort()).toEqual(["after", "before"]);
  });

  it("refuses a point that it does not know, and a point that is no function", () => {
    const refusal = (request: unknown) => {
      try {
        resolveConfig({ ...base(), hooks: { request: request as RequestHooks } });
      } catch (e) {
        return e instanceof ConfigError ? e.message : `not a ConfigError: ${String(e)}`;
      }
      return "no refusal";
    };
    expect(refusal({ beforeAll() {} })).toContain("hooks.request.beforeAll");
    expect(refusal({ before: "x" })).toContain("hooks.request.before");
  });
});

describe("hooks.request.before", () => {
  it("gets the route, the params, the URL, the headers, the IP, and the JSON body", async () => {
    const seen: (Omit<RequestHookEvent, "json"> & { body: unknown })[] = [];
    const auth = withHooks({
      async before(e) {
        const { json, ...rest } = e;
        seen.push({ ...rest, body: await json() });
      },
    });
    expect((await auth.handle(ask())).status).toBe(200);
    expect(seen).toHaveLength(1);
    const [e] = seen;
    expect(e?.route).toBe("POST /magic-link/request");
    expect(e?.params).toEqual({});
    expect(e?.url.href).toBe("https://api.example.com/auth/magic-link/request");
    expect(e?.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(e?.ip).toBe("203.0.113.9");
    expect(e?.body).toEqual({ email: ADDRESS });
    // The handler read the same body after the hook: the mail went out.
    expect(auth.mail.map((m) => m.to)).toEqual([ADDRESS]);
  });

  it("lets the handler read the body when the hook reads it two times, or not at all", async () => {
    for (const reads of [0, 2]) {
      const auth = withHooks({
        async before(e) {
          for (let i = 0; i < reads; i++) expect(await e.json()).toEqual({ email: ADDRESS });
        },
      });
      expect([reads, (await auth.handle(ask())).status]).toEqual([reads, 200]);
      expect(auth.mail).toHaveLength(1);
    }
  });

  it("answers 403 hook_refused with the message, and the handler does not run", async () => {
    const auth = withHooks({
      async before(e) {
        const body = (await e.json()) as { email?: string } | undefined;
        if (body?.email?.endsWith("@example.com"))
          throw hookRefusal("This address is not allowed.");
      },
    });
    const res = await auth.handle(ask());
    expect([res.status, await res.json()]).toEqual([
      403,
      { error: "hook_refused", message: "This address is not allowed." },
    ]);
    expect(auth.mail).toEqual([]);
    expect(await auth.storage.findMany("verification", [])).toEqual([]);
    // Another address passes the same hook.
    const other = await auth.handle(ask({ email: "b@example.org" }));
    expect(other.status).toBe(200);
    expect(auth.mail.map((m) => m.to)).toEqual(["b@example.org"]);
  });

  it("answers 500 hook_failed for any other throw, with one event and no message of the error", async () => {
    const o = observed({
      hooks: {
        request: {
          before() {
            throw new TypeError("a secret detail");
          },
        },
      },
    });
    const res = await o.auth.handle(ask());
    expect([res.status, await res.json()]).toEqual([500, { error: "hook_failed" }]);
    const events = await o.events();
    const failed = events.filter((e: AuthEvent) => e.name === "hook.before_failed");
    expect(failed).toMatchObject([{ hook: "request.before", errorName: "TypeError" }]);
    expect(JSON.stringify(events)).not.toContain("a secret detail");
    expect(o.mail).toEqual([]);
  });

  it("gives a value that is new for the hook: a change of it changes nothing of the request", async () => {
    const later: unknown[] = [];
    const auth = withHooks({
      async before(e) {
        e.headers.set("cf-connecting-ip", "10.9.9.9");
        e.headers.delete("origin");
        e.url.pathname = "/auth/other";
        e.params.x = "y";
        ((await e.json()) as { email: string }).email = "evil@example.org";
      },
      // The second event comes from the request again, so it shows what the request holds now.
      async after(e) {
        later.push({
          ip: e.headers.get("cf-connecting-ip"),
          origin: e.headers.get("origin"),
          path: e.url.pathname,
          params: e.params,
          body: await e.json(),
        });
      },
    });
    expect((await auth.handle(ask())).status).toBe(200);
    expect(auth.mail.map((m) => m.to)).toEqual([ADDRESS]);
    expect(later).toEqual([
      {
        ip: "203.0.113.9",
        origin: "https://app.example.com",
        path: "/auth/magic-link/request",
        params: {},
        body: { email: ADDRESS },
      },
    ]);
  });

  it("gives undefined for a body that is not JSON, and for a GET", async () => {
    const bodies: unknown[] = [];
    const auth = withHooks({
      async before(e) {
        bodies.push(await e.json());
      },
    });
    await auth.handle(get("/auth/session", IP));
    await auth.handle(
      new Request("https://api.example.com/auth/magic-link/request", {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://app.example.com", ...IP },
        body: JSON.stringify({ email: ADDRESS }),
      }),
    );
    await auth.handle(
      new Request("https://api.example.com/auth/magic-link/request", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.com", ...IP },
        body: "{ not json",
      }),
    );
    expect(bodies).toEqual([undefined, undefined, undefined]);
  });

  it("keeps the cap of the route: a body past it answers 413, with or without a read of the hook", async () => {
    const large = { email: ADDRESS, pad: "x".repeat(BODY_CAP_FLOOR) };
    for (const reads of [true, false]) {
      const auth = withHooks({
        async before(e) {
          if (reads) await e.json();
        },
      });
      const res = await auth.handle(ask(large));
      expect([reads, res.status, await res.json()]).toEqual([
        reads,
        413,
        { error: "body_too_large" },
      ]);
      expect(auth.mail).toEqual([]);
    }
  });

  it("runs after the rules of the router: no hook for a refused origin or an unknown path", async () => {
    const routes: string[] = [];
    const auth = withHooks({
      before(e) {
        routes.push(e.route);
      },
    });
    const foreign = await auth.handle(
      post("/auth/magic-link/request", { email: ADDRESS }, { origin: "https://evil.example" }),
    );
    expect(foreign.status).toBe(403);
    expect((await auth.handle(get("/auth/no-such-route"))).status).toBe(404);
    // A feature that is off answers 404 before the hook too.
    expect((await auth.handle(post("/auth/anonymous/sign-in", {}))).status).toBe(404);
    expect(routes).toEqual([]);
  });

  it("gives the path parameters of a route with a parameter", async () => {
    const seen: { route: string; params: Record<string, string> }[] = [];
    const auth = withHooks(
      {
        before(e) {
          seen.push({ route: e.route, params: e.params });
        },
      },
      // A long value: the events check reads each config secret as a text that no event may hold.
      {
        social: {
          github: {
            clientId: "request-hook-client",
            clientSecret: recordCredential("request-hook-github-secret-0123456789"),
          },
        },
      },
    );
    await auth.handle(get("/auth/social/github/start", IP));
    expect(seen).toEqual([
      { route: "GET /social/:provider/start", params: { provider: "github" } },
    ]);
  });

  it("does not run for an in-process call", async () => {
    let calls = 0;
    const auth = withHooks({
      before() {
        calls++;
      },
    });
    await auth.seedUser(ADDRESS);
    expect((await requestEmailOtp(auth.config, { email: ADDRESS, ip: "10.0.0.1" })).ok).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("the body read of a request hook", () => {
  const body = (key: RouteKey | undefined) => {
    const request = new Request("https://api.example.com/auth/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    bindBodyRoute(request, key);
    return request;
  };

  it("reads and keeps the body of a route at the floor, and each later read gets the same bytes", async () => {
    const request = body("POST /magic-link/request");
    const first = await hookBodyBytes(request);
    expect(new TextDecoder().decode(first ?? new Uint8Array())).toBe('{"a":1}');
    expect(request.bodyUsed).toBe(true);
    expect(await hookBodyBytes(request)).toBe(first);
    expect(await readBodyBytes(request, BODY_CAP_FLOOR)).toBe(first);
    // A read with a lower cap than the kept bytes still refuses them.
    await expect(readBodyBytes(request, 3)).rejects.toThrow("more than 3 bytes");
  });

  it("does not touch the body of a route with a reader of its own", async () => {
    // Each route of BODY_CAPS reads above the floor, and binds its slow work before its read.
    const large = Object.keys(BODY_CAPS) as RouteKey[];
    expect(large.length).toBeGreaterThan(0);
    const own: (RouteKey | undefined)[] = [
      ...large,
      "POST /scim/v2/Users",
      "PUT /scim/v2/Users/:id",
      "PATCH /scim/v2/Groups/:id",
      "POST /sso/:connectionId/acs",
      // A request that the router bound to no route.
      undefined,
    ];
    for (const key of own) {
      const request = body(key);
      expect([key, await hookBodyBytes(request), request.bodyUsed]).toEqual([
        key,
        undefined,
        false,
      ]);
    }
  });
});

describe("hooks.request.after", () => {
  it("gets the status and the code of each answer, and cannot change it", async () => {
    const seen: Pick<RequestAfterEvent, "route" | "status" | "code">[] = [];
    const auth = withHooks({
      after(e) {
        seen.push({ route: e.route, status: e.status, code: e.code });
        // The event is a new value: a change of it reaches no answer.
        e.status = 599;
      },
    });
    const sent = await auth.handle(ask());
    expect(sent.status).toBe(200);
    const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    const bad = await auth.handle(post("/auth/magic-link/verify", { token: `${token}x` }, IP));
    expect(seen).toEqual([
      { route: "POST /magic-link/request", status: 200, code: null },
      { route: "POST /magic-link/verify", status: bad.status, code: "invalid_token" },
    ]);
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it("gets the same body as the handler read", async () => {
    const bodies: unknown[] = [];
    const auth = withHooks({
      async after(e) {
        bodies.push(await e.json());
      },
    });
    expect((await auth.handle(ask())).status).toBe(200);
    // The handler read the stream. The hook has no bytes then, and it gets undefined.
    expect(bodies).toEqual([undefined]);
    const both = withHooks({
      async before(e) {
        await e.json();
      },
      async after(e) {
        bodies.push(await e.json());
      },
    });
    expect((await both.handle(ask())).status).toBe(200);
    expect(bodies).toEqual([undefined, { email: ADDRESS }]);
  });

  it("keeps the answer when the hook throws, and emits hook.after_failed", async () => {
    const o = observed({
      hooks: {
        request: {
          after() {
            throw new RangeError("a secret detail");
          },
        },
      },
    });
    const res = await o.auth.handle(ask());
    expect([res.status, await res.json()]).toEqual([200, { sent: true }]);
    const events = await o.events();
    const failed = events.filter((e: AuthEvent) => e.name === "hook.after_failed");
    expect(failed).toMatchObject([{ hook: "request.after", errorName: "RangeError" }]);
    expect(JSON.stringify(events)).not.toContain("a secret detail");
  });

  it("does not run after a refusal of the before hook", async () => {
    let after = 0;
    const auth = withHooks({
      before() {
        throw hookRefusal("No.");
      },
      after() {
        after++;
      },
    });
    expect((await auth.handle(ask())).status).toBe(403);
    expect(after).toBe(0);
  });
});
