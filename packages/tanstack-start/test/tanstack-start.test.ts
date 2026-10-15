import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { createMiddleware } from "@tanstack/react-start";
import { describe, expect, it } from "vitest";
import {
  authRequestServer,
  authRouteHandlers,
  getSession,
  type SessionContext,
  type StartAuthOptions,
} from "../src/index.js";

const BASE = "https://app.example.com";
const DAY = 24 * 60 * 60 * 1000;
const COOKIE = "__Host-tempo_session";

type Step = { response: Response };

function setup(core: { basePath?: string } = {}, gate: Partial<StartAuthOptions> = {}) {
  const prefix = core.basePath ?? "/auth";
  let now = new Date("2026-01-01T00:00:00.000Z");
  const mail: MailMessage[] = [];
  const auth: Auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [BASE],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock: { now: () => now },
    ...core,
  });
  // The real session call of core, with a count of its calls.
  const counter = { reads: 0 };
  const session = auth.session.bind(auth);
  auth.session = (request, options) => {
    counter.reads++;
    return session(request, options);
  };
  const handlers = authRouteHandlers(auth);
  const server = authRequestServer({
    auth,
    protect: (p) => p.startsWith("/account"),
    signInPath: "/sign-in",
    ...gate,
  });
  /**
   * One request through the middleware, as TanStack Start runs it: the
   * middleware, then the route's handler as the next step. `pathname` is the
   * one that TanStack gives the middleware (getNormalizedURL of
   * @tanstack/router-core 1.171.37, read with a probe on 2026-10-15).
   */
  const run = async (
    request: Request,
    pathname?: string,
    handler: (request: Request, context: SessionContext) => Response | Promise<Response> = () =>
      new Response("page"),
  ) => {
    let seen: SessionContext | null = null;
    let runs = 0;
    let inner: Response | null = null;
    const out = await server<Step>({
      request,
      pathname,
      next: async ({ context }) => {
        seen = context;
        runs++;
        inner = await handler(request, context);
        return { response: inner };
      },
    });
    const response = out instanceof Response ? out : out.response;
    return { response, seen: (): SessionContext | null => seen, runs, inner: () => inner };
  };
  const coreHandler = (request: Request) =>
    request.method === "POST" ? handlers.POST({ request }) : handlers.GET({ request });
  /** A sign-in through the middleware and the route handlers of core. */
  async function signIn(sent: Record<string, string> = {}) {
    const post = (path: string, body: unknown) =>
      run(
        new Request(`${BASE}${prefix}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, ...sent },
          body: JSON.stringify(body),
        }),
        `${prefix}${path}`,
        coreHandler,
      );
    await post("/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const verified = await post("/magic-link/verify", { token });
    const lines = verified.response.headers.getSetCookie();
    const line = lines.find((l) => l.startsWith(`${COOKIE}=`)) ?? "";
    return { cookie: line.split(";")[0] ?? "", lines, inner: verified.inner() };
  }
  return {
    auth,
    prefix,
    counter,
    handlers,
    coreHandler,
    run,
    signIn,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("@authtempo/tanstack-start (plan 11d2)", () => {
  it("serves the routes of core from the server handlers of one route", async () => {
    const { handlers, signIn } = setup();
    expect((await handlers.GET({ request: new Request(`${BASE}/auth/session`) })).status).toBe(401);
    expect((await signIn()).cookie.startsWith(`${COOKIE}=ts_`)).toBe(true);
  });

  it("passes every Set-Cookie line of core unchanged", async () => {
    const { signIn } = setup();
    // The old cookie name (plan 12b): core answers the session line and the clear of the old name.
    const { cookie, lines, inner } = await signIn({ cookie: "tempo_session=ts_old" });
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(inner?.headers.getSetCookie());
    expect(cookie.startsWith(`${COOKIE}=ts_`)).toBe(true);
    expect(lines.some((l) => l.startsWith("tempo_session=;") && l.includes("Max-Age=0"))).toBe(
      true,
    );
  });

  // A read of the session on a route of core would add a renewed cookie after
  // core's clear line of a sign-out, and the browser would keep the cookie.
  async function signOutAfterRefresh(core: { basePath?: string }) {
    const { prefix, counter, signIn, advance, run, coreHandler } = setup(core);
    const { cookie } = await signIn();
    advance(8 * DAY);
    const before = counter.reads;
    const out = await run(
      new Request(`${BASE}${prefix}/sign-out`, {
        method: "POST",
        headers: { cookie, origin: BASE },
      }),
      `${prefix}/sign-out`,
      coreHandler,
    );
    expect(out.response.status).toBe(200);
    expect(counter.reads - before).toBe(0);
    const lines = out.response.headers.getSetCookie();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(`${COOKIE}=;`)).toBe(true);
    expect(lines[0]).toContain("Max-Age=0");
    // The count works: a page request reads the session once.
    await run(new Request(`${BASE}/`), "/");
    expect(counter.reads - before).toBe(1);
  }

  it("reads no session for a path of core", async () => {
    await signOutAfterRefresh({});
  });

  it("reads no session for a path of core on the base path of the auth object", async () => {
    await signOutAfterRefresh({ basePath: "/api/auth" });
  });

  it("gives the session to the next step in the context", async () => {
    const { signIn, run } = setup();
    const { cookie } = await signIn();
    const out = await run(new Request(`${BASE}/`, { headers: { cookie } }), "/");
    expect(await out.response.text()).toBe("page");
    expect(getSession(out.seen())?.user.email).toBe("ada@example.com");
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { run } = setup();
    const out = await run(new Request(`${BASE}/account?tab=2`), "/account");
    expect(out.seen()).toBeNull();
    expect(out.runs).toBe(0);
    expect(out.response.status).toBe(307);
    expect(out.response.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount%3Ftab%3D2`);
  });

  it("renews the session cookie on the page's answer", async () => {
    const { signIn, run, advance } = setup();
    const { cookie } = await signIn();
    advance(8 * DAY);
    const out = await run(new Request(`${BASE}/account`, { headers: { cookie } }), "/account");
    expect(out.runs).toBe(1);
    const lines = out.response.headers.getSetCookie();
    expect(lines.filter((l) => l.startsWith(`${COOKIE}=ts_`))).toHaveLength(1);
  });

  // An exact rule, the strictest form: each path below runs the route
  // "/account" in TanStack's router, so each must reach the rule as "/account".
  const exact = { protect: (p: string) => p === "/account" };

  it("gates an escaped path as the path that the router matches", async () => {
    const { run } = setup({}, exact);
    // TanStack gives the middleware "/account" for "/%61ccount". With no
    // pathname, the binding decodes the path itself, and next is the raw path.
    const cases = [
      ["/account", "%2Faccount%3Ftab%3D2"],
      [undefined, "%2F%2561ccount%3Ftab%3D2"],
    ] as const;
    for (const [pathname, next] of cases) {
      const out = await run(new Request(`${BASE}/%61ccount?tab=2`), pathname);
      expect(out.response.status).toBe(307);
      expect(out.response.headers.get("location")).toBe(`${BASE}/sign-in?next=${next}`);
      expect(out.runs).toBe(0);
    }
  });

  it("gates a path with a slash at the end, which the router removes", async () => {
    const { run } = setup({}, exact);
    const cases = [
      ["/account/", "%2Faccount%2F"],
      ["/account//", "%2Faccount%2F%2F"],
    ] as const;
    for (const [path, next] of cases) {
      const out = await run(new Request(`${BASE}${path}`), path);
      expect(out.response.status).toBe(307);
      expect(out.response.headers.get("location")).toBe(`${BASE}/sign-in?next=${next}`);
      expect(out.runs).toBe(0);
    }
  });

  it("folds case, as the router matches without case, and keeps the case in next", async () => {
    const { run, signIn } = setup({}, exact);
    const cases = [
      ["/ACCOUNT", "%2FACCOUNT"],
      ["/Account/", "%2FAccount%2F"],
    ] as const;
    for (const [path, next] of cases) {
      const out = await run(new Request(`${BASE}${path}`), path);
      expect(out.response.status).toBe(307);
      expect(out.response.headers.get("location")).toBe(`${BASE}/sign-in?next=${next}`);
      expect(out.runs).toBe(0);
    }
    // With a session the page runs, at the case of the request.
    const { cookie } = await signIn();
    const out = await run(new Request(`${BASE}/ACCOUNT`, { headers: { cookie } }), "/ACCOUNT");
    expect(out.runs).toBe(1);
    expect(getSession(out.seen())?.user.email).toBe("ada@example.com");
  });

  it("gives protect the path decoded as the router decodes it", async () => {
    const seen: string[] = [];
    const { run } = setup(
      {},
      {
        protect: (p) => {
          seen.push(p);
          return p === "/café";
        },
      },
    );
    const out = await run(new Request(`${BASE}/caf%C3%A9`), "/caf%C3%A9");
    expect(out.response.status).toBe(307);
    expect(out.runs).toBe(0);
    // "%25" stays escaped, as in the router: "/%2561ccount" is not "/account".
    await run(new Request(`${BASE}/%2561ccount`), "/%2561ccount");
    expect(seen).toContain("/café");
    expect(seen).toContain("/%2561ccount");
  });

  // A dot segment never reaches the router: the URL parser of the request
  // resolves it, and TanStack gives the middleware the resolved path (read
  // with a probe of the built example, 2026-10-15). A child route under the
  // prefix rule therefore runs only for a path that the rule sees.
  it("gives a prefix rule the path left after the dot segments", async () => {
    const seen: string[] = [];
    const { run } = setup(
      {},
      {
        protect: (p) => {
          seen.push(p);
          return p.startsWith("/account");
        },
      },
    );
    const cases = [
      ["/account/..", "/", 1],
      ["/account/%2e%2e", "/", 1],
      ["/account/x/..", "/account/", 0],
      ["/account/.%2e/account", "/account", 0],
    ] as const;
    for (const [path, pathname, runs] of cases) {
      const request = new Request(`${BASE}${path}`);
      expect(new URL(request.url).pathname).toBe(pathname);
      const out = await run(request, pathname);
      expect(out.runs).toBe(runs);
      expect(out.response.status).toBe(runs ? 200 : 307);
    }
    // "/account/../auth/session" is the route of core: the rule never runs.
    const before = seen.length;
    const core = await run(new Request(`${BASE}/account/../auth/session`), "/auth/session");
    expect(seen.length).toBe(before);
    expect(core.runs).toBe(1);
    // The fold asks the rule again in lower case when the first answer is false.
    expect([...new Set(seen)]).toEqual(["/", "/account"]);
  });

  // srvx 0.11.22, the Node server of TanStack Start, builds request.url from
  // the request line: "GET http://evil.example/account" with Host
  // app.example.com gives a request on http://evil.example (review M1).
  it("takes the origin of the redirect from the Host header, not the request line", async () => {
    const { run } = setup();
    const request = new Request("http://evil.example/account", {
      headers: { host: "app.example.com" },
    });
    const out = await run(request, "/account");
    expect(out.response.status).toBe(307);
    expect(out.response.headers.get("location")).toBe(
      "http://app.example.com/sign-in?next=%2Faccount",
    );
    expect(out.runs).toBe(0);
  });

  // srvx gives a Host "a b" the origin http://_invalid_.
  it("falls back on the origin of core's baseURL for a Host that does not parse", async () => {
    const { run } = setup();
    for (const host of ["a b", "app.example.com/x", "evil@app.example.com"]) {
      const request = new Request("http://_invalid_/account", { headers: { host } });
      const out = await run(request, "/account");
      expect(out.response.status).toBe(307);
      expect(out.response.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
      expect(out.runs).toBe(0);
    }
  });

  // The router compares the lower-case route with the lower-case path, so
  // "/myaccount" and "/MYACCOUNT" run the page of "/myAccount" (review M2).
  it("runs a lower-case rule on the lower-case path, so every case is protected", async () => {
    const { run } = setup({}, { protect: (p) => p.startsWith("/myaccount") });
    for (const path of ["/myAccount", "/MYACCOUNT", "/myaccount", "/MyAccount/x"]) {
      const out = await run(new Request(`${BASE}${path}`), path);
      expect(out.response.status).toBe(307);
      expect(out.runs).toBe(0);
    }
  });

  // core 3aa2d84: the gate reads no session only when the raw path and the
  // routed path are both of core. TanStack gives "/auth/session" for
  // "/%61uth/session", and a catch-all page must not run for it.
  it("never runs a catch-all page for an escaped path of core", async () => {
    const seen: string[] = [];
    const { run, coreHandler } = setup(
      {},
      {
        protect: (p) => {
          seen.push(p);
          return p !== "/";
        },
      },
    );
    const cases = [
      ["GET", "/%61uth/session", "/auth/session"],
      ["GET", "/%61uth/x", "/auth/x"],
      ["POST", "/%61uth/sign-out", "/auth/sign-out"],
    ] as const;
    for (const [method, raw, pathname] of cases) {
      const request = new Request(`${BASE}${raw}`, { method, headers: { origin: BASE } });
      const out = await run(request, pathname, coreHandler);
      expect([307, 401, 404]).toContain(out.response.status);
      expect(out.runs).toBe(0);
    }
    expect([...new Set(seen)]).toEqual(["/auth/session", "/auth/x", "/auth/sign-out"]);
  });

  // decodePath escapes a control character again after it decodes it: the
  // router matches "/account/%09../auth/x", not a path with a raw tab.
  it("gives protect a control character escaped, as the router keeps it", async () => {
    const seen: string[] = [];
    const record = (p: string) => {
      seen.push(p);
      return true;
    };
    const { run } = setup({}, { protect: record });
    const out = await run(new Request(`${BASE}/account/%09../auth/x`), "/account/%09../auth/x");
    expect(out.response.status).toBe(307);
    expect(seen).toContain("/account/%09../auth/x");
    expect(seen.some((p) => p.includes("\t"))).toBe(false);
  });

  // next is the page URL, not the decoded path: the decoded "/%61ccount" of
  // "/%2561ccount" would open as "/account" in the browser.
  it("puts the page URL in next, not the decoded path", async () => {
    const { run } = setup({}, { protect: () => true });
    const out = await run(new Request(`${BASE}/%2561ccount?a=1`), "/%2561ccount");
    expect(out.response.status).toBe(307);
    expect(out.response.headers.get("location")).toBe(
      `${BASE}/sign-in?next=%2F%252561ccount%3Fa%3D1`,
    );
    expect(out.runs).toBe(0);
  });

  // Solid Start needs its own vitest project: see vitest.config.ts and
  // tanstack-start.solid.test.ts.
  it("runs as the request middleware of React Start", async () => {
    const { auth } = setup();
    const mw = createMiddleware({ type: "request" }).server(
      authRequestServer({ auth, protect: (p) => p === "/account", signInPath: "/sign-in" }),
    );
    let runs = 0;
    const out = await mw.options.server?.({
      request: new Request(`${BASE}/account`),
      pathname: "/account",
      context: {},
      handlerType: "router",
      next: async () => {
        runs++;
        return { request: new Request(BASE), pathname: "/", context: {}, response: new Response() };
      },
    } as never);
    expect(out instanceof Response && out.status).toBe(307);
    expect(runs).toBe(0);
  });

  it("takes a function that makes the auth instance at the first request", async () => {
    const { auth } = setup();
    let made = 0;
    const make = () => {
      made++;
      return auth;
    };
    const handlers = authRouteHandlers(make);
    const server = authRequestServer({ auth: make });
    expect(made).toBe(0);
    await handlers.GET({ request: new Request(`${BASE}/auth/session`) });
    await server({
      request: new Request(`${BASE}/`),
      next: () => ({ response: new Response("page") }),
    });
    expect(made).toBe(2);
  });

  it("refuses protect without signInPath at construction", () => {
    const { auth } = setup();
    expect(() => authRequestServer({ auth, protect: () => true })).toThrow(/signInPath/);
  });

  it("answers null from getSession for a context that holds no session", () => {
    expect(getSession(undefined)).toBeNull();
    expect(getSession({})).toBeNull();
  });
});
