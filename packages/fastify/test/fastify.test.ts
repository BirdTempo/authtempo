import type { AddressInfo } from "node:net";
import net from "node:net";
import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import Fastify, { type FastifyServerOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { authRoutes, authSession, getSession } from "../src/index.js";

// fastify.inject sends Host "localhost:80"; the URL of the request is http://localhost.
const BASE = "http://localhost";
const DAY = 24 * 60 * 60 * 1000;

interface AppOptions {
  /** core's own basePath. The binding gets no basePath option. */
  basePath?: string;
  /** Register the routes of core before the session hook. */
  routesFirst?: boolean;
  /** A hook of the app sets a cookie before the routes of core run. */
  pref?: boolean;
  server?: FastifyServerOptions;
  /** An exact rule: only "/account" needs a session. */
  exact?: boolean;
  /** A rule that protects every path. */
  all?: boolean;
  /** A catch-all page route "/*" at the root. */
  catchAll?: boolean;
  /** core's baseURL. Default BASE. */
  baseURL?: string;
}

/** The status line and the headers of a raw request, sent as it is over a socket. */
async function raw(port: number, target: string, host = `127.0.0.1:${port}`) {
  const head = await new Promise<string>((done, fail) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    socket.on("end", () => done(text));
    socket.on("error", fail);
  });
  const status = Number(head.split(" ")[1]);
  const location = /^location: (.*)$/im.exec(head)?.[1]?.trim() ?? "";
  return { status, location, text: head };
}

/** Runs `check` with the app on a port of the test, and closes it after. */
async function onPort(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  check: (port: number) => Promise<void>,
) {
  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    await check((app.server.address() as AddressInfo).port);
  } finally {
    await app.close();
  }
}

async function makeApp(core: AppOptions = {}) {
  const prefix = core.basePath ?? "/auth";
  let now = new Date("2026-01-01T00:00:00.000Z");
  const mail: MailMessage[] = [];
  const auth: Auth = createAuth({
    baseURL: core.baseURL ?? BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [BASE],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock: { now: () => now },
    ...(core.basePath ? { basePath: core.basePath } : {}),
  });
  // The real session call of core, with a count of the calls of the gate.
  const counter = { reads: 0 };
  const session = auth.session.bind(auth);
  auth.session = (request, options) => {
    counter.reads++;
    return session(request, options);
  };
  const app = Fastify(core.server);
  app.decorateRequest("authSession", null);
  if (core.pref)
    app.addHook("onRequest", async (_request, reply) => {
      reply.header("set-cookie", "pref=1; Path=/");
    });
  // Every path that the rule got, in order.
  const seen: string[] = [];
  const hook = authSession({
    auth,
    // An exact rule on a path that a URL writes escaped.
    protect: (p) => {
      seen.push(p);
      if (core.all) return true;
      return core.exact ? p === "/account" : p.startsWith("/account") || p === "/über";
    },
    signInPath: "/sign-in",
  });
  if (core.routesFirst) {
    await app.register(authRoutes({ auth }));
    app.addHook("onRequest", hook);
  } else {
    app.addHook("onRequest", hook);
    await app.register(authRoutes({ auth }));
  }
  app.get("/", async (request) => getSession(request)?.user.email ?? "signed out");
  // The count of runs of the protected pages: a gate that fails runs one.
  const runs = { pages: 0 };
  app.get("/account", async (request) => {
    runs.pages++;
    return `account of ${getSession(request)?.user.email}`;
  });
  app.get("/über", async (request) => {
    runs.pages++;
    return `über of ${getSession(request)?.user.email}`;
  });
  app.get<{ Params: { tab: string } }>("/account/:tab", async (request) => {
    runs.pages++;
    return `tab ${request.params.tab} of ${getSession(request)?.user.email}`;
  });
  // A wildcard route: it matches "/account/../auth/x" as the router keeps it.
  app.get("/account/*", async (request) => {
    runs.pages++;
    return `more of ${getSession(request)?.user.email}`;
  });
  if (core.catchAll)
    app.get("/*", async () => {
      runs.pages++;
      return "catch-all";
    });
  await app.ready();
  async function signIn(
    as: "json" | "form" = "json",
    sent: Record<string, string> = {},
  ): Promise<{ cookie: string; lines: string[] }> {
    await app.inject({
      method: "POST",
      url: `${prefix}/magic-link/request`,
      headers: { "content-type": "application/json", origin: BASE },
      payload: JSON.stringify({ email: "ada@example.com" }),
    });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const res = await app.inject({
      method: "POST",
      url: `${prefix}/magic-link/verify`,
      headers: {
        "content-type": as === "json" ? "application/json" : "application/x-www-form-urlencoded",
        origin: BASE,
        ...sent,
      },
      payload:
        as === "json" ? JSON.stringify({ token }) : new URLSearchParams({ token }).toString(),
    });
    const lines = linesOf(res.headers["set-cookie"]);
    const line = lines.find((l) => l.startsWith("__Host-tempo_session=")) ?? "";
    return { cookie: line.split(";")[0] ?? "", lines };
  }
  return {
    app,
    prefix,
    counter,
    runs,
    seen,
    signIn,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

function linesOf(set: string | string[] | undefined): string[] {
  if (set === undefined) return [];
  return Array.isArray(set) ? set : [set];
}

describe("@authtempo/fastify (plan 11d2)", () => {
  it("serves the routes of core with the raw JSON body, and passes every Set-Cookie line", async () => {
    const { app, signIn } = await makeApp();
    expect((await app.inject({ method: "GET", url: "/auth/session" })).statusCode).toBe(401);
    // The old cookie name (plan 12b): core answers the session line and the clear of the old name.
    const { cookie, lines } = await signIn("json", { cookie: "tempo_session=ts_old" });
    expect(cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.startsWith("tempo_session=;") && l.includes("Max-Age=0"))).toBe(
      true,
    );
  });

  it("serves a form post, which Fastify does not parse by itself", async () => {
    const { signIn } = await makeApp();
    expect((await signIn("form")).cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);
  });

  it("keeps a Set-Cookie line of an earlier hook on the answer of core", async () => {
    const { signIn } = await makeApp({ pref: true });
    const { cookie, lines } = await signIn();
    expect(cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);
    expect(lines.some((l) => l.startsWith("pref=1"))).toBe(true);
  });

  // A read of the session on a route of core would add a renewed cookie after
  // core's clear line of a sign-out, and the browser would keep the cookie.
  async function signOutAfterRefresh(core: AppOptions) {
    const { app, prefix, counter, signIn, advance } = await makeApp(core);
    const { cookie } = await signIn();
    advance(8 * DAY);
    const before = counter.reads;
    const res = await app.inject({
      method: "POST",
      url: `${prefix}/sign-out`,
      headers: { cookie, origin: BASE },
    });
    expect(res.statusCode).toBe(200);
    expect(counter.reads - before).toBe(0);
    const lines = linesOf(res.headers["set-cookie"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("__Host-tempo_session=;")).toBe(true);
    expect(lines[0]).toContain("Max-Age=0");
    // The count works: a page request reads the session once.
    await app.inject({ method: "GET", url: "/" });
    expect(counter.reads - before).toBe(1);
  }

  it("reads no session for a path of core", async () => {
    await signOutAfterRefresh({});
  });

  it("reads no session for a path of core on the base path of the auth object", async () => {
    await signOutAfterRefresh({ basePath: "/api/auth" });
  });

  it("reads no session for a path of core on a base path with an @", async () => {
    await signOutAfterRefresh({ basePath: "/@auth" });
  });

  it("reads no session for a path of core, with the routes registered before the hook", async () => {
    await signOutAfterRefresh({ routesFirst: true });
  });

  it("gives the session to a route in request.authSession", async () => {
    const { app, signIn } = await makeApp();
    expect((await app.inject({ method: "GET", url: "/" })).body).toBe("signed out");
    const { cookie } = await signIn();
    expect((await app.inject({ method: "GET", url: "/", headers: { cookie } })).body).toBe(
      "ada@example.com",
    );
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/account?tab=2" });
    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe(`${BASE}/sign-in?next=%2Faccount%3Ftab%3D2`);
  });

  // next comes from the request's URL (core: a routed string never gives next),
  // so one decode by the router gives back the path that the person asked for.
  it("gates the path as the router matches it, decoded once, with an exact rule", async () => {
    const { app, runs } = await makeApp({ exact: true });
    // find-my-way decodes "%61" to "a": the page of /account would run.
    const encoded = await app.inject({ method: "GET", url: "/%61ccount" });
    expect(encoded.statusCode).toBe(307);
    expect(encoded.headers.location).toBe(`${BASE}/sign-in?next=%2F%2561ccount`);
    // The router is case-sensitive by default; the gate folds case and fails closed.
    const upper = await app.inject({ method: "GET", url: "/ACCOUNT" });
    expect(upper.statusCode).toBe(307);
    expect(upper.headers.location).toBe(`${BASE}/sign-in?next=%2FACCOUNT`);
    expect(runs.pages).toBe(0);
  });

  it("gives the rule the decoded path, not the escaped form of a URL", async () => {
    const { app, runs, seen } = await makeApp();
    // The router matches "/über"; a URL writes the path as "/%C3%BCber".
    const res = await app.inject({ method: "GET", url: "/%C3%BCber" });
    expect(res.statusCode).toBe(307);
    expect(seen).toContain("/über");
    expect(runs.pages).toBe(0);
    expect(res.body).not.toContain("über of");
  });

  it("folds case when the router ignores case, and keeps the case in next", async () => {
    const { app, runs } = await makeApp({
      exact: true,
      server: { routerOptions: { caseSensitive: false } },
    });
    for (const [url, next] of [
      ["/ACCOUNT", "%2FACCOUNT"],
      ["/Account", "%2FAccount"],
      ["/%41ccount", "%2F%2541ccount"],
    ]) {
      const res = await app.inject({ method: "GET", url: url ?? "" });
      expect(res.statusCode).toBe(307);
      expect(res.headers.location).toBe(`${BASE}/sign-in?next=${next}`);
    }
    expect(runs.pages).toBe(0);
  });

  it("returns to the path as it came: /account/a%2Fb gives next=/account/a%2Fb", async () => {
    const { app, runs } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/account/a%2Fb" });
    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe(`${BASE}/sign-in?next=%2Faccount%2Fa%252Fb`);
    expect(runs.pages).toBe(0);
  });

  // A next of "/\evil.example" would send the person to evil.example from an
  // app's own sign-in page: a browser reads "/\" as "//".
  // find-my-way keeps "%3F" and "%23" escaped in the path it matches; only a
  // param value decodes them ("a?b"). So the rule gets "/account/a%3Fb".
  it("gives the rule %3F and %23 as the router keeps them", async () => {
    const { app, runs, seen } = await makeApp();
    for (const [url, matched] of [
      ["/account/a%3Fb", "/account/a%3Fb"],
      ["/account/a%23b", "/account/a%23b"],
    ]) {
      const res = await app.inject({ method: "GET", url: url ?? "" });
      expect(res.statusCode).toBe(307);
      expect(seen.at(-1)).toBe(matched);
    }
    expect(runs.pages).toBe(0);
  });

  // find-my-way decodes "/%61uth/session" to "/auth/session", so core's route
  // wins over "/*". Core 12f6eed skips the session read on that matched path,
  // and core answers 404 for the raw URL it gets. Core round 10 skips only when
  // the raw path is under the base path too, so the gate reads the session and
  // answers 307. Neither runs a page, and the rule only ever gets the matched
  // path, never the raw escaped text.
  it("leaves an escaped path of core to core under a catch-all route", async () => {
    const { app, runs, seen } = await makeApp({ all: true, catchAll: true });
    const before = seen.length;
    for (const url of ["/%61uth/session", "/%61uth/x", "/a%75th/x"]) {
      const res = await app.inject({ method: "GET", url });
      expect([307, 401, 404]).toContain(res.statusCode);
    }
    for (const p of seen.slice(before)) expect(["/auth/session", "/auth/x"]).toContain(p);
    expect(runs.pages).toBe(0);
  });

  // find-my-way keeps "%3F" escaped in the path and compares the hex digits as
  // text, so "/q%3fx" and "/q%3Fx" both reach the route "/:slug" with slug "q?x".
  // A rule written with "%3F" must hold for every hex case.
  it("asks the rule with the escapes in upper case, so the hex case of a request does not open a page", async () => {
    for (const caseSensitive of [true, false]) {
      const auth = createAuth({
        baseURL: BASE,
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [BASE],
        storage: createMemoryAdapter(),
        mail: { send: async () => {} },
      });
      const app = Fastify({ routerOptions: { caseSensitive } });
      app.decorateRequest("authSession", null);
      app.addHook(
        "onRequest",
        authSession({ auth, protect: (p) => p === "/q%3Fx", signInPath: "/sign-in" }),
      );
      let runs = 0;
      app.get("/:slug", async (request) => {
        runs++;
        return request.params;
      });
      await app.ready();
      for (const url of ["/q%3Fx", "/q%3fx", "/Q%3FX", "/Q%3fx/"]) {
        const res = await app.inject({ method: "GET", url });
        expect([307, 404]).toContain(res.statusCode);
      }
      expect(runs).toBe(0);
      await app.close();
    }
  });

  it("keeps an escaped backslash escaped in next", async () => {
    const { app } = await makeApp({ all: true });
    const res = await app.inject({ method: "GET", url: "/%5Cevil.example" });
    expect(res.statusCode).toBe(307);
    const next = new URL(res.headers.location ?? "").searchParams.get("next") ?? "";
    expect(next).toBe("/%5Cevil.example");
    expect(next.startsWith("/%5C")).toBe(true);
  });

  // "GET http://evil.example/account HTTP/1.1": the host of the request line
  // must not become the origin, and the URL must not break.
  it("gates a request line in absolute form on the origin of the Host header", async () => {
    const { app, runs } = await makeApp({ exact: true });
    await onPort(app, async (port) => {
      const res = await raw(port, "http://evil.example/account");
      expect(res.text.split("\r\n")[0]).toBe("HTTP/1.1 307 Temporary Redirect");
      expect(res.location).toBe(`http://127.0.0.1:${port}/sign-in?next=%2Faccount`);
    });
    expect(runs.pages).toBe(0);
  });

  // A Host header that is not an authority: the origin of core's baseURL.
  it("answers no 500 for a Host header that does not parse", async () => {
    const { app, runs } = await makeApp({ exact: true, baseURL: "http://app.example" });
    await onPort(app, async (port) => {
      const page = await raw(port, "/", "a b");
      expect(page.status).toBe(200);
      const account = await raw(port, "/account", "a b");
      expect(account.status).toBe(307);
      expect(account.location).toBe("http://app.example/sign-in?next=%2Faccount");
      const core = await raw(port, "/auth/session", "a b");
      expect(core.status).toBe(401);
    });
    expect(runs.pages).toBe(0);
  });

  // light-my-request and fetch drop a dot segment before the request leaves;
  // a raw client does not, and find-my-way routes "/account/.." to "/account/:tab".
  // A URL reads "\\" as "/"; find-my-way routes "/account/x\\..\\.." to "/account/*".
  it("gives the rule the matched path itself, and next the path of the request", async () => {
    const { app, runs, seen } = await makeApp();
    await onPort(app, async (port) => {
      // The raw path, the path find-my-way matches, and next: the request's
      // URL as a URL parser reads it.
      const cases: [string, string, string][] = [
        ["/account/..", "/account/..", "%2F"],
        ["/account/%2e%2e", "/account/..", "%2F"],
        ["/account/../auth/x", "/account/../auth/x", "%2Fauth%2Fx"],
        ["/account/x\\..\\..\\auth\\y", "/account/x\\..\\..\\auth\\y", "%2Fauth%2Fy"],
        [
          "/account/x%5C..%5C..%5Cauth%5Cy",
          "/account/x\\..\\..\\auth\\y",
          "%2Faccount%2Fx%255C..%255C..%255Cauth%255Cy",
        ],
        // The router keeps "%25", so "%252e" stays "%252e" (a route "/x/%2e" matches it).
        [
          "/account/%252e%252e/auth/x",
          "/account/%252e%252e/auth/x",
          "%2Faccount%2F%25252e%25252e%2Fauth%2Fx",
        ],
        ["/account/%09../auth/x", "/account/\t../auth/x", "%2Faccount%2F%2509..%2Fauth%2Fx"],
      ];
      for (const [path, matched, next] of cases) {
        const res = await raw(port, path);
        expect(res.status).toBe(307);
        expect(res.location).toBe(`http://127.0.0.1:${port}/sign-in?next=${next}`);
        expect(seen.at(-1)).toBe(matched);
      }
    });
    expect(runs.pages).toBe(0);
  });

  // Fastify takes a router option from routerOptions when the app set it
  // there, else from the deprecated top-level field. The hook reads neither:
  // it protects each form that the router can match.
  const shapes = (option: string): [string, FastifyServerOptions][] => [
    ["a default app", {}],
    ["the option at the top level", { [option]: true }],
    ["the option in routerOptions", { routerOptions: { [option]: true } }],
    [
      "the option at the top level and routerOptions for another key",
      { [option]: true, routerOptions: { maxParamLength: 500 } },
    ],
  ];
  for (const [option, target, next] of [
    ["ignoreDuplicateSlashes", "//account", "%2Faccount"],
    ["ignoreTrailingSlash", "/account/", "%2Faccount%2F"],
    ["useSemicolonDelimiter", "/account;x=1", "%2Faccount%3Bx%3D1"],
  ] as const) {
    it(`gates ${target} with ${option} in each place, and runs no page`, async () => {
      for (const [, server] of shapes(option)) {
        const { app, runs } = await makeApp({ exact: true, server });
        await onPort(app, async (port) => {
          const res = await raw(port, target);
          expect(res.status).toBe(307);
          expect(res.location).toBe(`http://127.0.0.1:${port}/sign-in?next=${next}`);
        });
        expect(runs.pages).toBe(0);
      }
    });
  }

  it("renews the session cookie on the page's answer", async () => {
    const { app, signIn, advance } = await makeApp();
    const { cookie } = await signIn();
    advance(8 * DAY);
    const res = await app.inject({ method: "GET", url: "/account", headers: { cookie } });
    expect(res.body).toBe("account of ada@example.com");
    const lines = linesOf(res.headers["set-cookie"]);
    expect(lines.some((l) => l.startsWith("__Host-tempo_session=ts_"))).toBe(true);
  });

  it("sends every method under the base path to core, never to a catch-all page", async () => {
    const auth = createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [BASE],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
    });
    const runs: string[] = [];
    const app = Fastify();
    app.addHook("onRequest", authSession({ auth, protect: () => true, signInPath: "/sign-in" }));
    await app.register(authRoutes({ auth }));
    // A catch-all route of the app, for every method.
    app.all("/*", async (request) => {
      runs.push(request.method);
      return "page";
    });
    try {
      for (const method of ["PUT", "DELETE", "PATCH"] as const)
        expect((await app.inject({ method, url: "/auth/x" })).statusCode, method).not.toBe(200);
      expect(runs).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("refuses protect without signInPath at construction", async () => {
    const { app } = await makeApp();
    expect(() => authSession({ auth: {} as never, protect: () => true })).toThrow(/signInPath/);
    expect(() => authRoutes({ auth: {} as never, basePath: "/auth/" })).toThrow(/basePath/);
    await app.close();
  });
});
