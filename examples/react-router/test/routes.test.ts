import type { MailMessage } from "@authtempo/core";
import {
  createStaticHandler,
  matchRoutes,
  type Path,
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

function makeApp() {
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
  const handler = createStaticHandler(
    createRoutes(
      () => auth,
      (id) => loads.push(id),
    ),
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
        return inner instanceof Response ? inner : Response.json(inner.loaderData);
      },
    });
    return result instanceof Response ? result : Response.json(result.loaderData);
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
