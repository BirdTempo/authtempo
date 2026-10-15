// The Node types for this file only: the hook below and the path of a module (tsconfig.test.json names none).
/// <reference types="node" />
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import {
  authOnRequest,
  authRouteHandlers,
  getSession,
  type SolidStartAuthOptions,
  type StartEventLike,
} from "../src/start.js";

/**
 * The real pipeline of Solid Start 2.0.6, in the server project (Node, the
 * server build of solid-js). `createMiddleware` of @solidjs/start/middleware
 * wraps the entry, and an h3 2.0.2 app runs it, as `createBaseHandler` of
 * dist/server/handler.js does. Its routes are radix3 1.1.2 routes built as
 * dist/server/routes.js builds the API routes. The middleware module imports
 * "server-only", a module that only the Vite plugin of Solid Start serves:
 * the hook below serves an empty module for it, here only.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    return next(specifier, context);
  },
});
const middlewareURL = import.meta.resolve("@solidjs/start/middleware");
const { createMiddleware } = await import("@solidjs/start/middleware");
const { getFetchEvent } = await import(new URL("../server/fetchEvent.js", middlewareURL).href);
const fromStart = createRequire(fileURLToPath(middlewareURL));
const h3 = await import(fromStart.resolve("h3"));
const radix3 = await import(fromStart.resolve("radix3"));

const BASE = "https://app.example.com";
const DAY = 24 * 60 * 60 * 1000;
const COOKIE = "__Host-tempo_session";

type RouteFn = (event: StartEventLike) => Response | Promise<Response>;

function setup(
  core: { basePath?: string } = {},
  gate: Partial<SolidStartAuthOptions> = {},
  options: { catchAll?: boolean } = {},
) {
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
  const runs: Record<string, number> = {};
  const seen: { event: StartEventLike | null } = { event: null };
  const page =
    (name: string): RouteFn =>
    (event) => {
      runs[name] = (runs[name] ?? 0) + 1;
      seen.event = event;
      return new Response(`page ${name} ${getSession(event)?.user.email ?? "none"}`);
    };
  const inner: { response: Response | null } = { response: null };
  const core_: RouteFn = async (event) => {
    const response = await (event.request.method === "POST" ? handlers.POST : handlers.GET)(event);
    inner.response = response;
    return response;
  };
  // The API routes of the example, with a child route under /account. The
  // keys are the radix3 paths that routes.js makes of the file routes.
  const routes: Record<string, { fn: RouteFn }> = {
    "/": { fn: page("home") },
    "/account": { fn: page("account") },
    "/account/:id": { fn: page("account-child") },
    "/myAccount": { fn: page("my-account") },
    [`${prefix}/**:path`]: { fn: core_ },
    ...(options.catchAll ? { "/**:rest": { fn: page("catch-all") } } : {}),
  };
  const router = radix3.createRouter({ routes });
  const onRequest = authOnRequest({
    auth,
    protect: (p) => p.startsWith("/account"),
    signInPath: "/sign-in",
    ...gate,
  });
  const app = new h3.H3();
  app.use(
    h3.defineHandler({
      middleware: createMiddleware({ onRequest: [onRequest] }),
      // The steps of createBaseHandler: parse request.url, look the path up.
      // No match renders the app root, which answers 404 in the example.
      handler: (e: unknown) => {
        const event = getFetchEvent(e) as StartEventLike;
        const match = router.lookup(new URL(event.request.url).pathname);
        if (!match) return new Response("not found", { status: 404 });
        return match.fn(event);
      },
    }),
  );
  const fetch = (request: Request): Promise<Response> => app.fetch(request);
  /** A sign-in through the middleware and the API route of core. */
  async function signIn(sent: Record<string, string> = {}) {
    const post = (path: string, body: unknown) =>
      fetch(
        new Request(`${BASE}${prefix}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, ...sent },
          body: JSON.stringify(body),
        }),
      );
    await post("/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const verified = await post("/magic-link/verify", { token });
    const lines = verified.headers.getSetCookie();
    const line = lines.find((l) => l.startsWith(`${COOKIE}=`)) ?? "";
    return { cookie: line.split(";")[0] ?? "", lines, inner: inner.response };
  }
  return {
    auth,
    prefix,
    counter,
    handlers,
    runs,
    seen,
    fetch,
    signIn,
    onRequest,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

const count = (runs: Record<string, number>) => Object.values(runs).reduce((a, b) => a + b, 0);

describe("@authtempo/solid/start (plan 11d2)", () => {
  it("serves the routes of core from the handlers of one API route", async () => {
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
    const { prefix, counter, signIn, advance, fetch } = setup(core);
    const { cookie } = await signIn();
    advance(8 * DAY);
    const before = counter.reads;
    const out = await fetch(
      new Request(`${BASE}${prefix}/sign-out`, {
        method: "POST",
        headers: { cookie, origin: BASE },
      }),
    );
    expect(out.status).toBe(200);
    expect(counter.reads - before).toBe(0);
    const lines = out.headers.getSetCookie();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(`${COOKIE}=;`)).toBe(true);
    expect(lines[0]).toContain("Max-Age=0");
    // The count works: a page request reads the session once.
    await fetch(new Request(`${BASE}/`));
    expect(counter.reads - before).toBe(1);
  }

  it("reads no session for a path of core", async () => {
    await signOutAfterRefresh({});
  });

  it("reads no session for a path of core on the base path of the auth object", async () => {
    await signOutAfterRefresh({ basePath: "/api/auth" });
  });

  it("puts the session in locals, and lets the request go on", async () => {
    const { signIn, fetch, runs, seen } = setup();
    const { cookie } = await signIn();
    const out = await fetch(new Request(`${BASE}/`, { headers: { cookie } }));
    expect(await out.text()).toBe("page home ada@example.com");
    expect(runs.home).toBe(1);
    expect(getSession(seen.event ?? { locals: {} })?.user.email).toBe("ada@example.com");
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { fetch, runs } = setup();
    const out = await fetch(new Request(`${BASE}/account?tab=2`));
    expect(out.status).toBe(307);
    expect(out.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount%3Ftab%3D2`);
    expect(count(runs)).toBe(0);
  });

  it("renews the session cookie on the page's answer", async () => {
    const { signIn, fetch, advance, runs } = setup();
    const { cookie } = await signIn();
    advance(8 * DAY);
    const out = await fetch(new Request(`${BASE}/account`, { headers: { cookie } }));
    expect(runs.account).toBe(1);
    // h3 2.0.2 merges the event's response headers into the route's answer.
    const lines = out.headers.getSetCookie();
    expect(lines.filter((l) => l.startsWith(`${COOKIE}=ts_`))).toHaveLength(1);
  });

  // An exact rule, the strictest form.
  const exact = { protect: (p: string) => p === "/account" };

  it("does not run the page for an escaped path or a path in another case", async () => {
    const { fetch, runs } = setup({}, exact);
    // radix3 does not decode: "/%61ccount" matches no route (404). Solid
    // Router compares in lower case: the entry folds "/ACCOUNT" (307).
    const cases = [
      ["/%61ccount", 404, null],
      ["/ACCOUNT", 307, "%2FACCOUNT"],
      ["/Account/", 307, "%2FAccount%2F"],
      ["/account/", 307, "%2Faccount%2F"],
    ] as const;
    for (const [path, status, next] of cases) {
      const out = await fetch(new Request(`${BASE}${path}`));
      expect(out.status, path).toBe(status);
      if (next) expect(out.headers.get("location")).toBe(`${BASE}/sign-in?next=${next}`);
    }
    expect(count(runs)).toBe(0);
  });

  it("folds case, and runs the page in another case with a session", async () => {
    const { fetch, runs, signIn } = setup({}, exact);
    const { cookie } = await signIn();
    const out = await fetch(new Request(`${BASE}/ACCOUNT`, { headers: { cookie } }));
    // radix3 compares the case: the API route does not run, and no page ran with no session.
    expect(out.status).toBe(404);
    const page = await fetch(new Request(`${BASE}/account`, { headers: { cookie } }));
    expect(await page.text()).toBe("page account ada@example.com");
    expect(runs.account).toBe(1);
  });

  // The URL parser of the request resolves dot segments, a backslash, and a
  // tab before Solid Start matches: the rule sees the path that matches.
  it("gives a prefix rule the path after the URL parse, on a child route", async () => {
    const seen: string[] = [];
    const { fetch, runs } = setup(
      {},
      {
        protect: (p) => {
          seen.push(p);
          return p.startsWith("/account");
        },
      },
    );
    const cases = [
      ["/account/x/..", "/account"],
      ["/account/.%2e/account/x", "/account/x"],
      ["/account\\x", "/account/x"],
      ["/acc\tount/x", "/account/x"],
      ["/account/%5Cx", "/account/%5Cx"],
      // No router decodes "%3F" or "%23": they stay in the path the rule gets.
      ["/account%3Fx", "/account%3Fx"],
      ["/account%23x", "/account%23x"],
    ] as const;
    for (const [path, routed] of cases) {
      seen.length = 0;
      const out = await fetch(new Request(`${BASE}${path}`));
      expect(out.status, path).toBe(307);
      expect(seen[0], path).toBe(routed);
    }
    expect(count(runs)).toBe(0);
    // "/account/.." is the home page: the rule sees "/", and the home runs.
    seen.length = 0;
    const home = await fetch(new Request(`${BASE}/account/..`));
    expect(home.status).toBe(200);
    expect(seen[0]).toBe("/");
    // "/account/../auth/session" is the route of core: the rule never runs.
    seen.length = 0;
    const core = await fetch(new Request(`${BASE}/account/../auth/session`));
    expect(core.status).toBe(401);
    expect(seen).toEqual([]);
  });

  // radix3 removes one "/" at the end, so "/account//" reaches the child
  // route "/account/:id" with an empty id. Solid Router removes one "/" at
  // the end too. The rule also gets the path with every "/" at the end removed.
  it("gives an exact rule the path with each slash at the end removed", async () => {
    const seen: string[] = [];
    const { fetch, runs } = setup(
      {},
      {
        protect: (p) => {
          seen.push(p);
          return p === "/account";
        },
      },
    );
    const cases = [
      ["/account/", "%2Faccount%2F"],
      ["/account//", "%2Faccount%2F%2F"],
      ["/ACCOUNT/", "%2FACCOUNT%2F"],
      ["/ACCOUNT//", "%2FACCOUNT%2F%2F"],
    ] as const;
    for (const [path, next] of cases) {
      const out = await fetch(new Request(`${BASE}${path}`));
      expect(out.status, path).toBe(307);
      expect(out.headers.get("location")).toBe(`${BASE}/sign-in?next=${next}`);
    }
    expect(count(runs)).toBe(0);
    expect(seen).toEqual([
      "/account",
      "/account/",
      "/account",
      "/ACCOUNT",
      "/account",
      "/ACCOUNT/",
      "/ACCOUNT",
      "/account/",
      "/account",
    ]);
    // "/" stays "/".
    seen.length = 0;
    await fetch(new Request(`${BASE}/`));
    expect(seen).toEqual(["/"]);
  });

  // Solid Router lower-cases a page path and its pattern, hex included, so
  // "/caf%c3%a9", "/CAF%C3%A9", and "/Caf%c3%a9/" run the page "/café".
  it("holds an encoded rule for every case of a page path and its escapes", async () => {
    for (const rule of ["/caf%C3%A9", "/caf%c3%a9"]) {
      const { onRequest } = setup({}, { protect: (p) => p === rule });
      for (const path of ["/caf%C3%A9", "/caf%c3%a9", "/CAF%C3%A9", "/Caf%c3%a9/"]) {
        const out = await onRequest({
          request: new Request(`${BASE}${path}`),
          response: { headers: new Headers() },
          locals: {},
        });
        expect(out?.status, `${rule} ${path}`).toBe(307);
      }
    }
  });

  // radix3 compares the case of an API route: "/MYACCOUNT" runs no route
  // "/myAccount". A rule in mixed case holds for the path that runs it.
  it("compares the case of an API route, as radix3 does", async () => {
    const seen: string[] = [];
    const { fetch, runs } = setup(
      {},
      {
        protect: (p) => {
          seen.push(p);
          return p.startsWith("/myAccount");
        },
      },
    );
    const cases = [
      ["/myAccount", 307],
      ["/myaccount", 404],
      ["/MYACCOUNT", 404],
    ] as const;
    for (const [path, status] of cases) {
      const out = await fetch(new Request(`${BASE}${path}`));
      expect(out.status, path).toBe(status);
    }
    expect(count(runs)).toBe(0);
    // The rule gets the path as matched, then in lower case when that differs.
    expect(seen).toEqual(["/myAccount", "/myaccount", "/MYACCOUNT", "/myaccount"]);
  });

  // Neither radix3 nor Solid Router decodes, so "/%61uth/session" is no route
  // of core. The gate judges the same raw text: a decode would read
  // "/auth/session", skip the rule, and run a catch-all page with no session.
  it("runs no catch-all page for an escaped base path with no session", async () => {
    const seen: string[] = [];
    const rule = (p: string) => {
      seen.push(p);
      return p !== "/";
    };
    const { fetch, runs, signIn } = setup({}, { protect: rule }, { catchAll: true });
    const paths = ["/%61uth/session", "/%61uth/x", "/%61uth/sign-out"];
    for (const path of paths) {
      const out = await fetch(new Request(`${BASE}${path}`));
      expect([307, 401, 404], path).toContain(out.status);
    }
    // The rule gets each path as the routers match it, never the decoded "/auth/…".
    expect(seen).toEqual(paths);
    expect(count(runs)).toBe(0);
    // With a session the catch-all runs for the same path: the count works.
    const { cookie } = await signIn();
    const out = await fetch(new Request(`${BASE}/%61uth/x`, { headers: { cookie } }));
    expect(await out.text()).toBe("page catch-all ada@example.com");
    expect(runs["catch-all"]).toBe(1);
  });

  it("takes the origin from Host, never from an absolute-form target", async () => {
    const { onRequest } = setup();
    // srvx 0.12.8 builds the URL of "GET http://evil.example/account" with that host.
    const event = (url: string, host?: string): StartEventLike => ({
      request: new Request(url, host ? { headers: { host } } : {}),
      response: { headers: new Headers() },
      locals: {},
    });
    const cases = [
      ["http://evil.example/account", "app.example.com", "http://app.example.com"],
      ["http://evil.example/account", undefined, BASE],
      ["http://evil.example/account", "a b", BASE],
      ["http://evil.example/account", "app.example.com@evil.example", BASE],
      ["http://_invalid_/account", "_invalid_", "http://_invalid_"],
    ] as const;
    for (const [url, host, origin] of cases) {
      const out = await onRequest(event(url, host));
      expect(out?.status, `${url} ${host}`).toBe(307);
      expect(out?.headers.get("location")).toBe(`${origin}/sign-in?next=%2Faccount`);
    }
  });

  it("takes a function that makes the auth instance at the first request", async () => {
    const { auth } = setup();
    let made = 0;
    const make = () => {
      made++;
      return auth;
    };
    const handlers = authRouteHandlers(make);
    const onRequest = authOnRequest({ auth: make });
    expect(made).toBe(0);
    await handlers.GET({ request: new Request(`${BASE}/auth/session`) });
    await onRequest({
      request: new Request(`${BASE}/`),
      response: { headers: new Headers() },
      locals: {},
    });
    expect(made).toBe(2);
  });

  it("refuses protect without signInPath at construction", () => {
    const { auth } = setup();
    expect(() => authOnRequest({ auth, protect: () => true })).toThrow(/signInPath/);
  });

  it("answers null from getSession where no middleware ran", () => {
    expect(getSession({ locals: {} })).toBeNull();
  });
});
