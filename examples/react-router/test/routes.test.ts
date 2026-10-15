import type { MailMessage } from "@authtempo/core";
import { authMiddleware, authRouteModule } from "@authtempo/react-router";
import {
  createStaticHandler,
  matchRoutes,
  type Path,
  type RouteObject,
  RouterContextProvider,
  type StaticHandlerContext,
} from "react-router";
import { describe, expect, it } from "vitest";
import { createAppAuth } from "../app/auth.server.js";
import { createRoutes } from "../app/routes.js";

const BASE = "http://localhost:5173";
const SESSION = "__Host-tempo_session";

/**
 * getNormalizedPath of react-router 8.4.0 (dist/production/lib/server-runtime/urls.js,
 * read 2026-10-15), which createRequestHandler gives to the static handler. The
 * package does not export it. It removes ".data" and "_routes" of a client navigation.
 */
function normalizePath(request: Request): Path {
  const url = new URL(request.url);
  const pathname = url.pathname.endsWith("/_.data")
    ? url.pathname.replace(/_\.data$/, "")
    : url.pathname.replace(/\.data$/, "");
  const params = new URLSearchParams(url.search);
  params.delete("_routes");
  const search = params.toString();
  return { pathname, search: search ? `?${search}` : "", hash: "" };
}

/** Every route as createRoutes gives it, with caseSensitive removed: an app that forgot it. */
function withoutCaseSensitive(routes: RouteObject[]): RouteObject[] {
  return routes.map((route) => {
    const { caseSensitive: _, ...rest } = route;
    return (
      route.children ? { ...rest, children: withoutCaseSensitive(route.children) } : rest
    ) as RouteObject;
  });
}

type RouteSet = typeof createRoutes;

function makeApp(options: { caseSensitive?: boolean; routes?: RouteSet } = {}) {
  const sent: MailMessage[] = [];
  const loads: string[] = [];
  const auth = createAppAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    mail: {
      async send(m) {
        sent.push(m);
      },
    },
  });
  const routes = (options.routes ?? createRoutes)(
    () => auth,
    (id) => loads.push(id),
  );
  const handler = createStaticHandler(
    options.caseSensitive === false ? withoutCaseSensitive(routes) : routes,
  );
  /**
   * What createRequestHandler of react-router 8.4.0 does (server-runtime/server.js,
   * read 2026-10-15): a ".data" request of a client navigation and a document
   * request go to query, a resource route goes to queryRoute with its routeId, and
   * every call takes normalizePath. A framework app encodes a ".data" answer
   * as a turbo-stream; this example answers the loader data as JSON.
   */
  async function serve(request: Request): Promise<Response> {
    const requestContext = new RouterContextProvider();
    const path = normalizePath(request);
    const last = matchRoutes(handler.dataRoutes, path.pathname)?.at(-1)?.route;
    // In a framework app, a route module with no default export is a resource route.
    if (!new URL(request.url).pathname.endsWith(".data") && last?.id === "auth")
      return handler.queryRoute(request, {
        routeId: last.id,
        requestContext,
        normalizePath,
        generateMiddlewareResponse: async (queryRoute) => queryRoute(request),
      });
    const result = await handler.query(request, {
      requestContext,
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
  async function signIn(): Promise<string> {
    const post = (path: string, body: unknown) =>
      serve(
        new Request(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify(body),
        }),
      );
    await post("/auth/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
    const verified = await post("/auth/magic-link/verify", { token });
    const line = verified.headers.getSetCookie().find((l) => l.startsWith(`${SESSION}=`)) ?? "";
    return line.split(";")[0] ?? "";
  }
  return { loads, serve, signIn };
}

describe("the React Router example (plan 11d2)", () => {
  it("runs the middleware and the loaders in React Router's server pipeline", async () => {
    const { loads, serve, signIn } = makeApp();
    const away = await serve(new Request(`${BASE}/account`));
    expect(away.status).toBe(307);
    expect(away.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
    // The page code does not run for a person with no session.
    expect(loads).toEqual([]);
    const cookie = await signIn();
    expect(cookie.startsWith(`${SESSION}=ts_`)).toBe(true);
    const account = await serve(new Request(`${BASE}/account`, { headers: { cookie } }));
    expect(((await account.json()) as { account: { email: string } }).account.email).toBe(
      "ada@example.com",
    );
    expect(loads).toEqual(["account"]);
  });

  // A client navigation sends "/account.data?_routes=account", not "/account".
  it("gates the data request of a client navigation on the page's path", async () => {
    const { loads, serve, signIn } = makeApp();
    const away = await serve(new Request(`${BASE}/account.data?_routes=account`));
    expect(away.status).toBe(307);
    expect(away.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
    expect(loads).toEqual([]);
    const cookie = await signIn();
    const data = await serve(
      new Request(`${BASE}/account.data?_routes=account`, { headers: { cookie } }),
    );
    expect(((await data.json()) as { account: { email: string } }).account.email).toBe(
      "ada@example.com",
    );
    expect(loads).toEqual(["account"]);
  });

  // React Router decodes each segment once, and the route "account" sets
  // caseSensitive. No form of the path runs the page with no session.
  it("runs no page for another case or an escape of a protected path", async () => {
    const { loads, serve } = makeApp();
    for (const path of ["/%61ccount", "/%61ccount.data?_routes=account"]) {
      const res = await serve(new Request(`${BASE}${path}`));
      expect(res.status, path).toBe(307);
      // next keeps the URL form of the request.
      expect(res.headers.get("location"), path).toBe(`${BASE}/sign-in?next=%2F%2561ccount`);
    }
    for (const path of ["/ACCOUNT", "/Account", "/%41ccount", "/ACCOUNT.data?_routes=account"]) {
      const res = await serve(new Request(`${BASE}${path}`));
      expect(res.status, path).toBe(404);
    }
    expect(loads).toEqual([]);
  });

  // With no caseSensitive, React Router runs the page of "/account" for
  // "/ACCOUNT". The binding folds case, so the person still gets the redirect.
  it("sends another case to the sign-in page when a route has no caseSensitive", async () => {
    const { loads, serve } = makeApp({ caseSensitive: false });
    const cases: [string, string][] = [
      ["/ACCOUNT", "%2FACCOUNT"],
      ["/%41ccount", "%2F%2541ccount"],
      ["/ACCOUNT.data?_routes=account", "%2FACCOUNT"],
      ["/%41ccount.data?_routes=account", "%2F%2541ccount"],
    ];
    for (const [path, next] of cases) {
      const res = await serve(new Request(`${BASE}${path}`));
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location"), path).toBe(`${BASE}/sign-in?next=${next}`);
    }
    expect(loads).toEqual([]);
  });

  // A ".data" name that ends in dots reaches the matcher raw: "/account/...data"
  // is "/account/.." to the splat route "account/*". The `url` of the
  // middleware has the dots resolved: "/".
  it("gates the dot segments of a data request on a splat route", async () => {
    const { loads, serve, signIn } = makeApp();
    const cases: [string, string][] = [
      ["/account/...data?_routes=account-rest", "%2F"],
      ["/account/..data?_routes=account-rest", "%2Faccount%2F"],
      ["/account/x/...data?_routes=account-rest", "%2Faccount%2F"],
    ];
    for (const [path, next] of cases) {
      const res = await serve(new Request(`${BASE}${path}`));
      expect(res.status, path).toBe(307);
      expect(res.headers.get("location"), path).toBe(`${BASE}/sign-in?next=${next}`);
    }
    expect(loads).toEqual([]);
    // The same request with a session reaches the splat route: the case is real.
    const cookie = await signIn();
    const res = await serve(
      new Request(`${BASE}/account/...data?_routes=account-rest`, { headers: { cookie } }),
    );
    const data = (await res.json()) as { "account-rest": { path: string } };
    expect(data["account-rest"].path).toBe("..");
    expect(loads).toEqual(["account-rest"]);
  });

  /**
   * The SvelteKit review's P1 shape: a splat route at the root and a rule on
   * every path but "/". React Router decodes "/%61uth/session" to "/auth/session"
   * and ranks the static "auth/*" over "*", so no page runs for it. The rule
   * records each path it gets.
   */
  const rootSplat =
    (seen: string[]): RouteSet =>
    (getAuth, onLoad = () => {}) => {
      const core = authRouteModule(getAuth);
      const protect = (p: string) => {
        seen.push(p);
        return p !== "/";
      };
      return [
        {
          id: "root",
          path: "/",
          middleware: [authMiddleware({ auth: getAuth, protect, signInPath: "/sign-in" })],
          children: [
            { id: "auth", path: "auth/*", loader: core.loader, action: core.action },
            {
              id: "page",
              path: "*",
              loader: () => {
                onLoad("page");
                return { page: true };
              },
            },
          ],
        },
      ];
    };

  it("sends an escaped path of core to core, not to a root splat page", async () => {
    const seen: string[] = [];
    const { loads, serve } = makeApp({ routes: rootSplat(seen) });
    for (const path of ["/%61uth/session", "/%61uth/x", "/%61uth/session.data?_routes=auth"]) {
      const res = await serve(new Request(`${BASE}${path}`));
      // Core round 10 judges a page unless the raw path and the routed path are
      // both under the base path, so the rule may answer 307 before core's 404.
      expect([307, 401, 404], `${path}: ${res.status}`).toContain(res.status);
    }
    // The status set alone cannot fail: the rule must get the matched paths.
    expect([...new Set(seen)].sort()).toEqual(["/auth/session", "/auth/x"]);
    // "/AUTH/session" goes to the auth route without case, and core answers 404
    // for it. The gate compares the base path with case, so the rule holds and
    // the person gets the sign-in redirect: no page and no route of core runs.
    const upper = await serve(new Request(`${BASE}/%41UTH/session`));
    expect(upper.status).toBe(307);
    expect(loads).toEqual([]);
    // The splat page runs behind the rule: "/other" needs a session.
    expect((await serve(new Request(`${BASE}/other`))).status).toBe(307);
  });

  // React Router 8.4.0 runs the loader of a resource route for OPTIONS
  // (queryRoute of router.js, read 2026-10-15), so core answers the preflight.
  it("passes a preflight to the routes of core", async () => {
    const { serve } = makeApp();
    const res = await serve(
      new Request(`${BASE}/auth/session`, {
        method: "OPTIONS",
        headers: { origin: BASE, "access-control-request-method": "POST" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(BASE);
  });
});
