import type { MailMessage } from "@authtempo/core";
import {
  createStaticHandler,
  RouterContextProvider,
  type StaticHandlerContext,
} from "react-router";
import { describe, expect, it } from "vitest";
import { createAppAuth } from "../app/auth.server.js";
import { createRoutes } from "../app/routes.js";

const BASE = "http://localhost:5173";
const SESSION = "__Host-tempo_session";

function makeApp() {
  const sent: MailMessage[] = [];
  const auth = createAppAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    mail: {
      async send(m) {
        sent.push(m);
      },
    },
  });
  const handler = createStaticHandler(createRoutes(() => auth));
  /**
   * What createRequestHandler of react-router 8.4.0 does: queryRoute for a
   * resource route, and query with generateMiddlewareResponse for a page.
   */
  async function serve(request: Request): Promise<Response> {
    const requestContext = new RouterContextProvider();
    if (new URL(request.url).pathname.startsWith("/auth/"))
      return handler.queryRoute(request, {
        requestContext,
        generateMiddlewareResponse: async (queryRoute) => queryRoute(request),
      });
    const result = await handler.query(request, {
      requestContext,
      generateMiddlewareResponse: async (query) => {
        const inner: StaticHandlerContext | Response = await query(request);
        return inner instanceof Response ? inner : Response.json(inner.loaderData);
      },
    });
    return result instanceof Response ? result : Response.json(result.loaderData);
  }
  return { sent, serve };
}

describe("the React Router example (plan 11d2)", () => {
  it("runs the middleware and the loaders in React Router's server pipeline", async () => {
    const { sent, serve } = makeApp();
    const post = (path: string, body: unknown) =>
      serve(
        new Request(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify(body),
        }),
      );
    const away = await serve(new Request(`${BASE}/account`));
    expect(away.status).toBe(307);
    expect(away.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
    await post("/auth/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
    const verified = await post("/auth/magic-link/verify", { token });
    const line = verified.headers.getSetCookie().find((l) => l.startsWith(`${SESSION}=`)) ?? "";
    const cookie = line.split(";")[0] ?? "";
    expect(cookie.startsWith(`${SESSION}=ts_`)).toBe(true);
    const account = await serve(new Request(`${BASE}/account`, { headers: { cookie } }));
    expect(((await account.json()) as { account: { email: string } }).account.email).toBe(
      "ada@example.com",
    );
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
