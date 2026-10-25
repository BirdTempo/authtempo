import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import {
  type ActionFunctionArgs,
  createStaticHandler,
  type LoaderFunctionArgs,
  type Path,
  type RouteObject,
  RouterContextProvider,
  type StaticHandlerContext,
} from "react-router";
import { describe, expect, it } from "vitest";
import { authMiddleware, authRouteModule, getSession } from "../src/index.js";

const BASE = "https://app.example.com";
const DAY = 24 * 60 * 60 * 1000;
const SESSION = "__Host-tempo_session";

function setup(core: { basePath?: string } = {}) {
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
  // The real session call of core, with a count of the calls of the middleware.
  const counter = { reads: 0 };
  const session = auth.session.bind(auth);
  auth.session = (request, options) => {
    counter.reads++;
    return session(request, options);
  };
  const module = authRouteModule(auth);
  /**
   * The arguments of a loader, an action, and a middleware, with React Router's
   * own context. `url` is built as React Router 8.4.0 builds it: getNormalizedPath
   * removes ".data" and "_routes", and createDataFunctionUrl sets the pathname,
   * whose setter resolves dot segments (server-runtime/urls.js, router/utils.js).
   */
  const routedURL = (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    url.pathname = path.endsWith("/_.data")
      ? path.replace(/_\.data$/, "")
      : path.replace(/\.data$/, "");
    url.searchParams.delete("_routes");
    return url;
  };
  const args = (request: Request) => ({
    request,
    url: routedURL(request),
    pattern: "/",
    params: {},
    context: new RouterContextProvider(),
  });
  const middleware = authMiddleware({
    auth,
    protect: (p) => p.startsWith("/account"),
    signInPath: "/sign-in",
  });
  /**
   * A request to the resource route of core through the root middleware, as
   * the server of a framework app runs it: root.tsx is the parent of auth.$.ts.
   */
  async function throughRoot(request: Request): Promise<Response> {
    const a = args(request);
    const run = request.method === "GET" ? module.loader : module.action;
    return (await middleware(a, () => run(a))) as Response;
  }
  async function signIn(): Promise<string> {
    const post = (path: string, body: unknown) =>
      module.action(
        args(
          new Request(`${BASE}${prefix}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: BASE },
            body: JSON.stringify(body),
          }),
        ),
      );
    await post("/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const res = await post("/magic-link/verify", { token });
    const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION}=`)) ?? "";
    return line.split(";")[0] ?? "";
  }
  return {
    auth,
    prefix,
    counter,
    module,
    args,
    throughRoot,
    signIn,
    middleware,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("@authtempo/react-router (plan 11d2)", () => {
  it("serves the routes of core from the loader and the action of one resource route", async () => {
    const { module, args, signIn } = setup();
    expect((await module.loader(args(new Request(`${BASE}/auth/session`)))).status).toBe(401);
    expect((await signIn()).startsWith(`${SESSION}=ts_`)).toBe(true);
  });

  // A read of the session on a route of core would add a renewed cookie after
  // core's clear line of a sign-out, and the browser would keep the cookie.
  async function signOutAfterRefresh(core: { basePath?: string }) {
    const { prefix, counter, signIn, throughRoot, advance } = setup(core);
    const cookie = await signIn();
    advance(8 * DAY);
    const before = counter.reads;
    const res = await throughRoot(
      new Request(`${BASE}${prefix}/sign-out`, {
        method: "POST",
        headers: { cookie, origin: BASE },
      }),
    );
    expect(res.status).toBe(200);
    expect(counter.reads - before).toBe(0);
    const lines = res.headers.getSetCookie();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(`${SESSION}=;`)).toBe(true);
    expect(lines[0]).toContain("Max-Age=0");
    // The count works: a page request reads the session once.
    await throughRoot(new Request(`${BASE}/`));
    expect(counter.reads - before).toBe(1);
  }

  it("reads no session for a path of core", async () => {
    await signOutAfterRefresh({});
  });

  it("reads no session for a path of core on the base path of the auth object", async () => {
    await signOutAfterRefresh({ basePath: "/api/auth" });
  });

  it("puts the session in the router context, and runs the next step", async () => {
    const { signIn, args, middleware } = setup();
    const cookie = await signIn();
    const a = args(new Request(`${BASE}/`, { headers: { cookie } }));
    let seen: string | null | undefined;
    const res = await middleware(a, async () => {
      seen = getSession(a.context)?.user.email;
      return new Response("page");
    });
    expect(await (res as Response).text()).toBe("page");
    expect(seen).toBe("ada@example.com");
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { args, middleware } = setup();
    let ran = false;
    const res = (await middleware(args(new Request(`${BASE}/account`)), async () => {
      ran = true;
      return new Response("page");
    })) as Response;
    expect(ran).toBe(false);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
  });

  /** A middleware with `rule`, and a run that records what `protect` got. */
  function probe(rule: (p: string) => boolean) {
    const { auth, args } = setup();
    const seen: string[] = [];
    const middleware = authMiddleware({
      auth,
      protect: (p) => {
        seen.push(p);
        return rule(p);
      },
      signInPath: "/sign-in",
    });
    async function run(raw: string) {
      let ran = false;
      const res = (await middleware(args(new Request(`${BASE}${raw}`)), async () => {
        ran = true;
        return new Response("page");
      })) as Response;
      return { ran, res, location: res.headers.get("location") };
    }
    return { seen, run };
  }

  // A client navigation of a framework app sends "/account.data?_routes=...".
  it("gates the routed path of a data request, not the raw path", async () => {
    const { run } = probe((p) => p === "/account");
    const { ran, res, location } = await run("/account.data?_routes=account&tab=2");
    expect(ran).toBe(false);
    expect(res.status).toBe(307);
    expect(location).toBe(`${BASE}/sign-in?next=%2Faccount%3Ftab%3D2`);
  });

  // React Router decodes each segment once before it matches: "/%61ccount"
  // runs the page of "/account", on a page request and on a data request.
  it("gates the once-decoded path that the router matched", async () => {
    const { seen, run } = probe((p) => p === "/account");
    for (const raw of ["/%61ccount", "/%61ccount.data?_routes=account"]) {
      const { ran, res, location } = await run(raw);
      expect(ran, raw).toBe(false);
      expect(res.status, raw).toBe(307);
      // next keeps the URL form of the request.
      expect(location, raw).toBe(`${BASE}/sign-in?next=%2F%2561ccount`);
    }
    expect(seen.every((p) => p === "/account")).toBe(true);
  });

  // The decoded path is not a safe next: "/%2561ccount" decodes to
  // "/%61ccount", and a browser would open that as "/account".
  it("keeps next in URL form", async () => {
    const { seen, run } = probe((p) => p === "/%61ccount");
    const { ran, location } = await run("/%2561ccount");
    expect(seen[0]).toBe("/%61ccount");
    expect(ran).toBe(false);
    expect(location).toBe(`${BASE}/sign-in?next=%2F%252561ccount`);
  });

  // "/account/...data" reaches the matcher as "/account/..", which a splat
  // route "account/*" matches; the `url` argument has the dots resolved.
  it("gates the dot segments that a splat route matches in a data request", async () => {
    const { seen, run } = probe((p) => p.startsWith("/account"));
    const cases: [string, string, string][] = [
      ["/account/...data?_routes=page", "/account/..", "%2F"],
      ["/account/..data?_routes=page", "/account/.", "%2Faccount%2F"],
      ["/account/x/...data?_routes=page", "/account/x/..", "%2Faccount%2F"],
    ];
    for (const [raw, judged, next] of cases) {
      const { ran, res, location } = await run(raw);
      expect(seen.at(-1), raw).toBe(judged);
      expect(ran, raw).toBe(false);
      expect(res.status, raw).toBe(307);
      expect(location, raw).toBe(`${BASE}/sign-in?next=${next}`);
    }
  });

  // React Router matches a decoded "?" or "#" as text of the path. The rule
  // gets the whole text through the gate: a routed string would be cut at either one.
  it("gives protect a decoded question mark and hash as text of the path", async () => {
    const { seen, run } = probe((p) => p.startsWith("/a"));
    const { ran, location } = await run("/a%3F/secret%23x");
    expect(seen[0]).toBe("/a?/secret#x");
    expect(ran).toBe(false);
    expect(location).toBe(`${BASE}/sign-in?next=%2Fa%253F%2Fsecret%2523x`);
  });

  // A route with no caseSensitive (React Router's default) matches without
  // case, so the binding folds case for the rule. `next` keeps the request's case.
  it("folds case for protect, on the decoded text, and keeps the case in next", async () => {
    const { run } = probe((p) => p === "/account" || p === "/café" || p === "/σ");
    for (const path of ["/ACCOUNT", "/%41ccount", "/CAF%C3%89", "/%CF%82"]) {
      for (const raw of [path, `${path}.data?_routes=page`]) {
        const { ran, res, location } = await run(raw);
        expect(ran, raw).toBe(false);
        expect(res.status, raw).toBe(307);
        expect(location, raw).toBe(`${BASE}/sign-in?next=${encodeURIComponent(path)}`);
      }
    }
  });

  // A route that is not a splat ends in "\/*$", so "/account/" renders
  // "/account". The rule gets the path without trailing slashes too.
  it("holds an exact rule on a path with trailing slashes", async () => {
    const { run } = probe((p) => p === "/account");
    const cases: [string, string][] = [
      ["/account/", "%2Faccount%2F"],
      ["/account//", "%2Faccount%2F%2F"],
      ["/ACCOUNT//", "%2FACCOUNT%2F%2F"],
      ["/account/_.data?_routes=account", "%2Faccount%2F"],
    ];
    for (const [raw, next] of cases) {
      const { ran, res, location } = await run(raw);
      expect(ran, raw).toBe(false);
      expect(res.status, raw).toBe(307);
      expect(location, raw).toBe(`${BASE}/sign-in?next=${next}`);
    }
    // "/" stays "/": the home page still runs with no session.
    for (const raw of ["/", "/_.data?_routes=root"]) {
      const { ran, res } = await run(raw);
      expect(ran, raw).toBe(true);
      expect(res.status, raw).toBe(200);
    }
  });

  /**
   * The pipeline of React Router: createStaticHandler with the normalizePath of
   * createRequestHandler (getNormalizedPath, server-runtime/urls.js of 8.4.0),
   * so the middleware gets the real `pattern` and `params` of the match.
   */
  function pipeline(
    caseSensitive: boolean,
    protect: (p: string) => boolean = (p) =>
      p.startsWith("/myAccount") || /^\/[^/]+\/myAccount/.test(p),
  ) {
    const { auth } = setup();
    const runs: string[] = [];
    const page = (id: string, path: string): RouteObject => ({
      id,
      path,
      caseSensitive,
      loader: () => {
        runs.push(id);
        return { id };
      },
    });
    const handler = createStaticHandler([
      {
        id: "root",
        path: "/",
        middleware: [
          authMiddleware({
            auth,
            protect,
            signInPath: "/sign-in",
          }),
        ],
        children: [
          { id: "home", index: true, loader: () => ({ home: true }) },
          page("about", "about"),
          page("myAccount", "myAccount"),
          page("myAccount-rest", "myAccount/*"),
          page("lang-myAccount", ":lang/myAccount"),
          page("q-hex", "q%3Fx"),
        ],
      },
    ]);
    const normalizePath = (request: Request): Path => {
      const url = new URL(request.url);
      const pathname = url.pathname.endsWith("/_.data")
        ? url.pathname.replace(/_\.data$/, "")
        : url.pathname.replace(/\.data$/, "");
      url.searchParams.delete("_routes");
      return { pathname, search: url.search, hash: "" };
    };
    async function serve(raw: string): Promise<Response> {
      const request = new Request(`${BASE}${raw}`);
      const result = await handler.query(request, {
        requestContext: new RouterContextProvider(),
        normalizePath,
        generateMiddlewareResponse: async (query) => {
          const inner: StaticHandlerContext | Response = await query(request);
          return inner instanceof Response
            ? inner
            : Response.json(inner.loaderData, { status: inner.statusCode });
        },
      });
      return result instanceof Response
        ? result
        : Response.json(result.loaderData, { status: result.statusCode });
    }
    return { runs, serve };
  }

  // React Router matches "/myaccount" to the route "myAccount" without case.
  // The rule is in the route's case, so the binding runs it on the route's text.
  it("holds a rule in the route's case for another case of the path", async () => {
    const { runs, serve } = pipeline(false);
    const closed = [
      "/myAccount",
      "/myaccount",
      "/MYACCOUNT",
      "/MyAccount",
      "/myaccount/",
      "/%6Dyaccount",
      "/MYACCOUNT/x",
      "/myaccount/...data?_routes=myAccount-rest",
      "/en/myaccount",
      "/en/MYACCOUNT",
    ];
    for (const path of closed) {
      for (const raw of path.includes(".data") ? [path] : [path, `${path}.data?_routes=x`]) {
        const res = await serve(raw);
        expect(res.status, raw).toBe(307);
      }
    }
    expect(runs).toEqual([]);
    // Public pages still run with no session.
    for (const raw of [
      "/",
      "/about",
      "/ABOUT",
      "/_.data?_routes=home",
      "/about.data?_routes=about",
    ]) {
      expect((await serve(raw)).status, raw).toBe(200);
    }
    expect(runs).toEqual(["about", "about", "about"]);
  });

  // React Router decodes "%253f" once to the text "%3f", and matches the route
  // "q%3Fx" without case. The rule is in the route's text, so it must still
  // hold. Two guards hold it: the upper-case hex step of the fold, and the
  // form in the route's case. Each guard alone holds it, so the proof of this
  // test removes both.
  it("holds a rule with an escape in the route's text for another hex case", async () => {
    const { runs, serve } = pipeline(false, (p) => p === "/q%3Fx");
    for (const raw of ["/q%253fx", "/Q%253FX", "/Q%253fx/", "/q%253fx.data?_routes=q-hex"]) {
      const res = await serve(raw);
      expect(res.status, raw).toBe(307);
      expect(res.headers.get("location"), raw).toMatch(/\/sign-in\?/);
    }
    expect(runs).toEqual([]);
  });

  it("answers 404 for another case when the route sets caseSensitive", async () => {
    const { runs, serve } = pipeline(true);
    for (const raw of ["/myaccount", "/MYACCOUNT", "/myaccount.data?_routes=myAccount"]) {
      expect((await serve(raw)).status, raw).toBe(404);
    }
    for (const raw of ["/myAccount", "/%6DyAccount"]) {
      expect((await serve(raw)).status, raw).toBe(307);
    }
    expect(runs).toEqual([]);
  });

  it("renews the session cookie on the page's answer", async () => {
    const { signIn, args, middleware, advance } = setup();
    const cookie = await signIn();
    advance(8 * DAY);
    const res = (await middleware(
      args(new Request(`${BASE}/account`, { headers: { cookie } })),
      async () => new Response("page"),
    )) as Response;
    expect(res.headers.getSetCookie().some((l) => l.startsWith(`${SESSION}=ts_`))).toBe(true);
  });

  it("answers null from getSession where no middleware ran", () => {
    expect(getSession(new RouterContextProvider())).toBeNull();
  });

  it("refuses protect without signInPath at construction", () => {
    const { auth } = setup();
    expect(() => authMiddleware({ auth, protect: () => true })).toThrow(/signInPath/);
  });
});

/**
 * A stand-in for core whose `handle` gives one promise to the `waitUntil`
 * it gets (ruling 29 of plan 12i). `got` holds "none" for a call with no
 * options.
 */
function waitSpy() {
  const work = Promise.resolve();
  const got: string[] = [];
  const auth = {
    async handle(_request: Request, options?: { waitUntil?: (p: Promise<unknown>) => void }) {
      got.push(options === undefined ? "none" : "options");
      options?.waitUntil?.(work);
      return new Response("ok");
    },
  };
  return { auth, work, got };
}

describe("the waitUntil of handle (ruling 29 of plan 12i)", () => {
  it("passes the option with the loader and action arguments, or none", async () => {
    const s = waitSpy();
    const args = {
      request: new Request(`${BASE}/auth/x`, { method: "POST" }),
      context: new RouterContextProvider(),
      params: {},
    } as unknown as ActionFunctionArgs;
    const seen: [Promise<unknown>, unknown][] = [];
    await authRouteModule(s.auth, { waitUntil: (p, a) => void seen.push([p, a]) }).action(args);
    expect(seen).toEqual([[s.work, args]]);
    // React Router 8 gives no platform context: with no option, handle gets none.
    await authRouteModule(s.auth).loader(args as unknown as LoaderFunctionArgs);
    expect(s.got).toEqual(["options", "none"]);
  });
});
