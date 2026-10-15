import http from "node:http";
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
}

async function makeApp(core: AppOptions = {}) {
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
  const hook = authSession({
    auth,
    // An exact rule on a path that a URL writes escaped.
    protect: core.exact
      ? (p) => p === "/account"
      : (p) => p.startsWith("/account") || p === "/über",
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

  it("gates the path as the router matches it, decoded once, with an exact rule", async () => {
    const { app, runs } = await makeApp({ exact: true });
    // find-my-way decodes "%61" to "a": the page of /account would run.
    const encoded = await app.inject({ method: "GET", url: "/%61ccount" });
    expect(encoded.statusCode).toBe(307);
    expect(encoded.headers.location).toBe(`${BASE}/sign-in?next=%2Faccount`);
    // The router is case-sensitive by default; the gate folds case and fails closed.
    const upper = await app.inject({ method: "GET", url: "/ACCOUNT" });
    expect(upper.statusCode).toBe(307);
    expect(upper.headers.location).toBe(`${BASE}/sign-in?next=%2FACCOUNT`);
    expect(runs.pages).toBe(0);
  });

  it("gives the rule the decoded path, not the escaped form of a URL", async () => {
    const { app, runs } = await makeApp();
    // The router matches "/über"; a URL writes the path as "/%C3%BCber".
    const res = await app.inject({ method: "GET", url: "/%C3%BCber" });
    expect(res.statusCode).toBe(307);
    expect(runs.pages).toBe(0);
    expect(res.body).not.toContain("über of");
  });

  it("folds case when the router ignores case, and keeps the case in next", async () => {
    const { app, runs } = await makeApp({
      exact: true,
      server: { routerOptions: { caseSensitive: false } },
    });
    for (const url of ["/ACCOUNT", "/Account", "/%41ccount"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(307);
      expect(res.headers.location).toBe(
        `${BASE}/sign-in?next=${encodeURIComponent(decodeURI(url))}`,
      );
    }
    expect(runs.pages).toBe(0);
  });

  // "GET http://evil.example/account HTTP/1.1": the host of the request line
  // must not become the origin, and the URL must not break.
  it("gates a request line in absolute form on the origin of the Host header", async () => {
    const { app, runs } = await makeApp({ exact: true });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as AddressInfo;
      const head = await new Promise<string>((done, fail) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write(
            `GET http://evil.example/account HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
          );
        });
        let text = "";
        socket.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        socket.on("end", () => done(text.split("\r\n\r\n")[0] ?? ""));
        socket.on("error", fail);
      });
      expect(head.split("\r\n")[0]).toBe("HTTP/1.1 307 Temporary Redirect");
      expect(head.toLowerCase()).toContain(
        `location: http://127.0.0.1:${port}/sign-in?next=%2faccount`,
      );
      expect(runs.pages).toBe(0);
    } finally {
      await app.close();
    }
  });

  // light-my-request and fetch drop a dot segment before the request leaves;
  // a raw client does not, and find-my-way routes "/account/.." to "/account/:tab".
  // A URL reads "\\" as "/"; find-my-way routes "/account/x\\..\\.." to "/account/*".
  it("gates a dot segment that the router keeps", async () => {
    const { app, runs } = await makeApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as AddressInfo;
      for (const path of [
        "/account/..",
        "/account/%2e%2e",
        "/account/../auth/x",
        "/account/x\\..\\..\\auth\\y",
        "/account/x%5C..%5C..%5Cauth%5Cy",
        // The router keeps "%2e" and a tab as text; a URL reads "%2e" as "." and drops a tab.
        "/account/%252e%252e/auth/x",
        "/account/%09../auth/x",
      ]) {
        const res = await new Promise<{ status: number; body: string }>((done, fail) => {
          http
            .get({ host: "127.0.0.1", port, path }, (r) => {
              let body = "";
              r.on("data", (chunk: Buffer) => {
                body += chunk.toString("utf8");
              });
              r.on("end", () => done({ status: r.statusCode ?? 0, body }));
            })
            .on("error", fail);
        });
        expect(res.body).not.toMatch(/tab|more of/);
        expect(res.status).toBe(307);
      }
      expect(runs.pages).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("renews the session cookie on the page's answer", async () => {
    const { app, signIn, advance } = await makeApp();
    const { cookie } = await signIn();
    advance(8 * DAY);
    const res = await app.inject({ method: "GET", url: "/account", headers: { cookie } });
    expect(res.body).toBe("account of ada@example.com");
    const lines = linesOf(res.headers["set-cookie"]);
    expect(lines.some((l) => l.startsWith("__Host-tempo_session=ts_"))).toBe(true);
  });

  it("refuses protect without signInPath at construction", async () => {
    const { app } = await makeApp();
    expect(() => authSession({ auth: {} as never, protect: () => true })).toThrow(/signInPath/);
    expect(() => authRoutes({ auth: {} as never, basePath: "/auth/" })).toThrow(/basePath/);
    await app.close();
  });
});
