import { request as httpRequest } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import express, { type RequestHandler } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { authHandler, authSession, getSession } from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** A raw GET with the request target as written: Node's fetch would make it a path. */
function rawGet(
  base: string,
  target: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; location: string | null }> {
  const { hostname, port } = new URL(base);
  return new Promise((done, fail) => {
    const req = httpRequest({ host: hostname, port, path: target, headers }, (res) => {
      res.resume();
      res.on("end", () =>
        done({ status: res.statusCode ?? 0, location: res.headers.location ?? null }),
      );
    });
    req.on("error", fail);
    req.end();
  });
}

/** Raw request lines over a socket: a Host header that Node's clients would refuse. */
function rawLines(
  base: string,
  text: string,
): Promise<{ status: number; location: string | null }> {
  const { hostname, port } = new URL(base);
  return new Promise((done, fail) => {
    // Write, do not end: Node's server can drop a slow answer after the client's FIN.
    // "Connection: close" in the text makes the server end the socket.
    const socket = connect(Number(port), hostname, () => socket.write(text));
    let out = "";
    socket.on("data", (d) => {
      out += d;
    });
    socket.on("end", () => {
      const head = out.split("\r\n\r\n")[0] ?? "";
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
      const location = /\r\nlocation: ([^\r]*)/i.exec(head)?.[1] ?? null;
      done({ status, location });
    });
    socket.on("error", fail);
  });
}

/** An Express app on a port of the test. The auth instance is made after the port is known. */
async function serve(
  parser?: "json" | "form",
  opts: {
    sessionFirst?: boolean;
    pref?: boolean;
    caseSensitive?: boolean;
    subRouter?: boolean;
    /** The rule of the protected paths. Default: a prefix rule on "/account". */
    rule?: (p: string) => boolean;
  } = {},
) {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const mail: MailMessage[] = [];
  const runs = { account: 0 };
  /** Each path that the protect rule got. */
  const seen: string[] = [];
  const rule = opts.rule ?? ((p: string) => p.startsWith("/account"));
  let auth: Auth | null = null;
  const getAuth = (): Auth => {
    if (!auth) throw new Error("no auth yet");
    return auth;
  };
  const app = express();
  // Express routes without case by default: "/ACCOUNT" would reach the /account route.
  if (opts.caseSensitive) app.set("case sensitive routing", true);
  if (parser === "json") app.use(express.json());
  if (parser === "form") app.use(express.urlencoded({ extended: false }));
  const mountSession = () =>
    app.use(
      authSession({
        auth: getAuth,
        protect: (p) => {
          seen.push(p);
          return rule(p);
        },
        signInPath: "/sign-in",
      }),
    );
  // A cookie of the app, set before the routes of core.
  if (opts.pref)
    app.use((_req, res, next) => {
      res.cookie("pref", "1");
      next();
    });
  if (opts.sessionFirst) mountSession();
  app.use("/auth", authHandler(getAuth));
  if (!opts.sessionFirst) mountSession();
  app.get("/", (_req, res) => {
    res.send(getSession(res)?.user.email ?? "signed out");
  });
  const account: RequestHandler = (_req, res) => {
    runs.account++;
    res.send(`account of ${getSession(res)?.user.email}`);
  };
  // A Router has its own case rule, false by default, whatever the app sets.
  if (opts.subRouter) {
    const pages = express.Router();
    pages.get("/account", account);
    app.use(pages);
  } else app.get("/account", account);
  // Routes under /account that match a dot segment, and a route with an escape.
  app.get("/account/:id", account);
  app.get("/account/*rest", account);
  app.get("/caf%C3%A9", account);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  stops.push(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  auth = createAuth({
    baseURL: base,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [base],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock: { now: () => now },
  });
  // The real session call of core, with a count of the calls of the gate.
  const counter = { reads: 0 };
  const session = auth.session.bind(auth);
  auth.session = (request, options) => {
    counter.reads++;
    return session(request, options);
  };
  async function signIn(verifyAs: "json" | "form" = "json"): Promise<string> {
    await fetch(`${base}/auth/magic-link/request`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: "ada@example.com" }),
    });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const res = await fetch(`${base}/auth/magic-link/verify`, {
      method: "POST",
      redirect: "manual",
      headers:
        verifyAs === "json"
          ? { "content-type": "application/json", origin: base }
          : { "content-type": "application/x-www-form-urlencoded", origin: base },
      body:
        verifyAs === "json" ? JSON.stringify({ token }) : new URLSearchParams({ token }).toString(),
    });
    lastLines = res.headers.getSetCookie();
    const line = lastLines.find((l) => l.startsWith("__Host-tempo_session=")) ?? "";
    return line.split(";")[0] ?? "";
  }
  let lastLines: string[] = [];
  return {
    base,
    counter,
    runs,
    seen,
    signIn,
    lines: () => lastLines,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("@authtempo/express (plan 11d2)", () => {
  it("serves the routes of core under /auth, with the session cookie", async () => {
    const { base, signIn } = await serve();
    expect((await fetch(`${base}/auth/session`)).status).toBe(401);
    const cookie = await signIn();
    expect(cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);
    const me = await fetch(`${base}/auth/session`, { headers: { cookie } });
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("ada@example.com");
  });

  it("keeps a Set-Cookie line of an earlier middleware on the answer of core", async () => {
    const { signIn, lines } = await serve(undefined, { pref: true });
    const cookie = await signIn();
    expect(cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);
    expect(lines().some((l) => l.startsWith("pref=1"))).toBe(true);
  });

  // A read of the session on a route of core would add a renewed cookie after
  // core's clear line of a sign-out, and the browser would keep the cookie.
  it("reads no session for a path of core, with authSession mounted first", async () => {
    const { base, counter, signIn, advance } = await serve(undefined, { sessionFirst: true });
    const cookie = await signIn();
    advance(8 * DAY);
    const before = counter.reads;
    const res = await fetch(`${base}/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin: base },
    });
    expect(res.status).toBe(200);
    expect(counter.reads - before).toBe(0);
    const lines = res.headers.getSetCookie();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("__Host-tempo_session=;")).toBe(true);
    expect(lines[0]).toContain("Max-Age=0");
    // The count works: a page request reads the session once.
    await fetch(`${base}/`);
    expect(counter.reads - before).toBe(1);
  });

  it("runs no page for /ACCOUNT with no session, in an app with case sensitive routing", async () => {
    const { base, runs } = await serve(undefined, { caseSensitive: true });
    for (const path of ["/ACCOUNT", "/Account"]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect([404, 307]).toContain(res.status);
    }
    expect(runs.account).toBe(0);
    // The exact path still goes to the sign-in page.
    expect((await fetch(`${base}/account`, { redirect: "manual" })).status).toBe(307);
  });

  it("folds case for protect in a default app, on the app and on a Router", async () => {
    for (const subRouter of [false, true]) {
      const { base, runs } = await serve(undefined, { subRouter });
      for (const path of ["/ACCOUNT", "/Account", "/ACCOUNT/"]) {
        const res = await fetch(`${base}${path}`, { redirect: "manual" });
        expect(res.status).toBe(307);
        // next keeps the case of the request.
        expect(res.headers.get("location")).toBe(
          `${base}/sign-in?next=${encodeURIComponent(path)}`,
        );
      }
      expect(runs.account).toBe(0);
    }
  });

  it("judges the path of a request line in absolute form on the app's own origin", async () => {
    const { base, runs, signIn } = await serve();
    // Express's router reads "/account" from this line; the gate must judge the same path.
    const away = await rawGet(base, "http://evil.example/account");
    expect(away.status).toBe(307);
    expect(away.location).toBe(`${base}/sign-in?next=%2Faccount`);
    expect(runs.account).toBe(0);
    const cookie = await signIn();
    const page = await rawGet(base, "http://evil.example/account", { cookie });
    expect(page.status).toBe(200);
    expect(runs.account).toBe(1);
  });

  it("judges a raw path with dot segments as the router matched it", async () => {
    const { base, runs, seen } = await serve();
    // The rule gets the raw path. next is the path of the request's own URL
    // (core 12f6eed), where the URL parser resolved the dot segments.
    const rows: [string, string][] = [
      ["/account/..", "/"],
      ["/account/%2e%2e", "/"],
      ["/account/../auth/session", "/auth/session"],
      ["/account/%2e%2e/auth/session", "/auth/session"],
      ["/account/x/../../auth/x", "/auth/x"],
    ];
    for (const [path, next] of rows) {
      // Node's fetch would resolve the dot segments; a raw request line keeps them.
      const res = await rawGet(base, path);
      expect(res.status).toBe(307);
      expect(res.location).toBe(`${base}/sign-in?next=${encodeURIComponent(next)}`);
      expect(seen).toContain(path);
    }
    expect(runs.account).toBe(0);
  });

  it("judges the raw path of an absolute-form request line with dot segments", async () => {
    const { base, runs, seen } = await serve();
    const rows: [string, string][] = [
      ["/account/x/../../auth/session", "/auth/session"],
      ["/account/%2e%2e/auth/x", "/auth/x"],
      ["/account/..", "/"],
    ];
    for (const [path, next] of rows) {
      const res = await rawGet(base, `http://evil.example${path}`);
      expect(res.status).toBe(307);
      expect(res.location).toBe(`${base}/sign-in?next=${encodeURIComponent(next)}`);
      expect(seen).toContain(path);
    }
    expect(runs.account).toBe(0);
  });

  it("keeps an escaped backslash in next as it is", async () => {
    const rule = (p: string) => p.startsWith("/%5C") || p.startsWith("/account");
    const { base, seen } = await serve(undefined, { rule });
    // "/\\evil.example" would read as a link to another origin; the escape is not decoded.
    const res = await rawGet(base, "/%5Cevil.example");
    expect(res.status).toBe(307);
    expect(res.location).toBe(`${base}/sign-in?next=${encodeURIComponent("/%5Cevil.example")}`);
    expect(seen).toContain("/%5Cevil.example");
  });

  it("answers no 500 to a Host header that does not parse, on the origin of baseURL", async () => {
    const { base, signIn } = await serve();
    const lines = (path: string, extra = "") =>
      rawLines(base, `GET ${path} HTTP/1.1\r\nHost: a b\r\n${extra}Connection: close\r\n\r\n`);
    const away = await lines("/account");
    expect(away.status).toBe(307);
    expect(away.location).toBe(`${base}/sign-in?next=%2Faccount`);
    expect((await lines("/auth/session")).status).toBe(401);
    expect((await lines("/")).status).toBe(200);
    const cookie = await signIn();
    expect((await lines("/account", `Cookie: ${cookie}\r\n`)).status).toBe(200);
  });

  it("falls back to http://localhost for an auth object with no baseURL", async () => {
    const real = createAuth({
      baseURL: "https://app.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: ["https://app.example.com"],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
    });
    // A hand-made auth object: the three calls of the gate, and no baseURL.
    const auth = {
      handle: real.handle.bind(real),
      session: real.session.bind(real),
      sessionCookie: real.sessionCookie.bind(real),
    };
    const app = express();
    app.use(
      authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    stops.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await rawLines(
      base,
      "GET /account HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n",
    );
    expect(res.status).toBe(307);
    expect(res.location).toBe("http://localhost/sign-in?next=%2Faccount");
  });

  it("folds the case of escape hex for an escaped rule", async () => {
    // The route "/caf%C3%A9" matches without case, hex digits too.
    for (const prefix of ["/caf%C3%A9", "/caf%c3%a9"]) {
      const { base, runs } = await serve(undefined, { rule: (p) => p.startsWith(prefix) });
      for (const path of ["/CAF%C3%A9", "/caf%c3%a9", "/caf%C3%A9"]) {
        const res = await rawGet(base, path);
        expect(res.status).toBe(307);
      }
      expect(runs.account).toBe(0);
    }
  });

  // Express's router does not decode the mount path, so "/%61uth/session" is not a
  // route of core. The gate must judge the same raw text: a decode would read
  // "/auth/session", skip the rule, and run a catch-all page with no session.
  it("runs no catch-all page for an escaped base path with no session", async () => {
    let base = "";
    let auth: ReturnType<typeof createAuth> | null = null;
    const getAuth = () =>
      (auth ??= createAuth({
        baseURL: base,
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [base],
        storage: createMemoryAdapter(),
        mail: { send: async () => {} },
      }));
    const pages: string[] = [];
    // Each path that the rule got: the gate must run the rule on the raw text.
    const seen: string[] = [];
    const app = express();
    app.use("/auth", authHandler(getAuth));
    app.use(
      authSession({
        auth: getAuth,
        protect: (p) => {
          seen.push(p);
          return p !== "/";
        },
        signInPath: "/sign-in",
      }),
    );
    app.use((req, res) => {
      pages.push(req.originalUrl);
      res.send("page");
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of ["/%61uth/session", "/%61uth/x"]) {
        const res = await fetch(`${base}${path}`, { redirect: "manual" });
        expect(res.status).toBe(307);
      }
      expect(pages).toEqual([]);
      expect(seen).toEqual(["/%61uth/session", "/%61uth/x"]);
    } finally {
      server.close();
    }
  });

  // Express routes with strict routing off by default: app.get("/account") also
  // matches "/account/". An exact rule must protect that path too.
  it("protects a trailing-slash path under an exact rule", async () => {
    let base = "";
    let auth: ReturnType<typeof createAuth> | null = null;
    const getAuth = () =>
      (auth ??= createAuth({
        baseURL: base,
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [base],
        storage: createMemoryAdapter(),
        mail: { send: async () => {} },
      }));
    const pages: string[] = [];
    const app = express();
    app.use("/auth", authHandler(getAuth));
    app.use(
      authSession({ auth: getAuth, protect: (p) => p === "/account", signInPath: "/sign-in" }),
    );
    app.get("/account", (req, res) => {
      pages.push(req.originalUrl);
      res.send("page");
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of ["/account/", "/ACCOUNT/"]) {
        const res = await fetch(`${base}${path}`, { redirect: "manual" });
        expect(res.status).toBe(307);
      }
      expect(pages).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("does not decode an escape in the path, as Express's router does not", async () => {
    const { base, runs } = await serve(undefined, { caseSensitive: true });
    // The router matches the raw path, so "/%61ccount" is no route: 404, and no page runs.
    const res = await fetch(`${base}/%61ccount`, { redirect: "manual" });
    expect(res.status).toBe(404);
    expect(runs.account).toBe(0);
  });

  it("reads a body that express.json() parsed", async () => {
    const { signIn } = await serve("json");
    expect((await signIn("json")).startsWith("__Host-tempo_session=ts_")).toBe(true);
  });

  it("reads a form body that express.urlencoded() parsed", async () => {
    const { signIn } = await serve("form");
    expect((await signIn("form")).startsWith("__Host-tempo_session=ts_")).toBe(true);
  });

  it("gives the session to a route in res.locals", async () => {
    const { base, signIn } = await serve();
    expect(await (await fetch(`${base}/`)).text()).toBe("signed out");
    const cookie = await signIn();
    expect(await (await fetch(`${base}/`, { headers: { cookie } })).text()).toBe("ada@example.com");
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/account?tab=2`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${base}/sign-in?next=%2Faccount%3Ftab%3D2`);
  });

  it("renews the session cookie on the page's answer", async () => {
    const { base, signIn, advance } = await serve();
    const cookie = await signIn();
    advance(8 * DAY);
    const res = await fetch(`${base}/account`, { headers: { cookie } });
    expect(await res.text()).toBe("account of ada@example.com");
    expect(res.headers.getSetCookie().some((l) => l.startsWith("__Host-tempo_session=ts_"))).toBe(
      true,
    );
  });
});
