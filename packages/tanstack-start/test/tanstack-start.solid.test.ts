import { createAuth, createMemoryAdapter } from "@authtempo/core";
import { createMiddleware } from "@tanstack/solid-start";
import { expect, it } from "vitest";
import { authRequestServer } from "../src/index.js";

const BASE = "https://app.example.com";

// The real request middleware of Solid Start on a real core instance.
it("runs as the request middleware of Solid Start", async () => {
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [BASE],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
  });
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
  expect(out instanceof Response && out.headers.get("location")).toBe(
    `${BASE}/sign-in?next=%2Faccount`,
  );
  expect(runs).toBe(0);
});
