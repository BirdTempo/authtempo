import { createApp, createRouter, defineEventHandler, toWebHandler } from "h3";
import { describe, expect, it } from "vitest";
import { authEventHandler, authSessionHandler, getSession } from "../src/nuxt.js";
import { API, APP, makeServer, SESSION } from "./support.js";

const DAY = 24 * 60 * 60 * 1000;

/** An h3 app as Nitro builds one: a server middleware, the routes of core, and two pages. */
function makeApp(core: { basePath?: string } = {}) {
  const prefix = core.basePath ?? "/auth";
  let now = new Date("2026-01-01T00:00:00.000Z");
  const server = makeServer({ clock: { now: () => now }, ...core });
  // The real session call of core, with a count of the calls of the middleware.
  const counter = { reads: 0 };
  const session = server.auth.session.bind(server.auth);
  server.auth.session = (request, options) => {
    counter.reads++;
    return session(request, options);
  };
  const app = createApp();
  app.use(
    authSessionHandler({
      auth: server.auth,
      protect: (p) => p.startsWith("/account"),
      signInPath: "/sign-in",
    }),
  );
  const router = createRouter();
  router.use(`${prefix}/**`, authEventHandler(server.auth));
  router.get(
    "/",
    defineEventHandler((event) => getSession(event)?.user.email ?? "signed out"),
  );
  router.get(
    "/account",
    defineEventHandler((event) => `account of ${getSession(event)?.user.email}`),
  );
  app.use(router.handler);
  const fetch = toWebHandler(app);
  async function signIn(): Promise<string> {
    const post = (path: string, body: unknown) =>
      fetch(
        new Request(`${API}${prefix}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: APP },
          body: JSON.stringify(body),
        }),
      );
    await post("/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(server.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const res = await post("/magic-link/verify", { token });
    const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION}=`)) ?? "";
    return line.split(";")[0] ?? "";
  }
  return {
    auth: server.auth,
    prefix,
    counter,
    fetch,
    signIn,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("@authtempo/vue/nuxt (plan 11d2)", () => {
  it("serves the routes of core through an h3 handler", async () => {
    const { fetch, signIn } = makeApp();
    expect((await fetch(new Request(`${API}/auth/session`))).status).toBe(401);
    expect((await signIn()).startsWith(`${SESSION}=ts_`)).toBe(true);
  });

  // A read of the session on a route of core would add a renewed cookie after
  // core's clear line of a sign-out, and the browser would keep the cookie.
  async function signOutAfterRefresh(core: { basePath?: string }) {
    const { prefix, counter, fetch, signIn, advance } = makeApp(core);
    const cookie = await signIn();
    advance(8 * DAY);
    const before = counter.reads;
    const res = await fetch(
      new Request(`${API}${prefix}/sign-out`, { method: "POST", headers: { cookie, origin: APP } }),
    );
    expect(res.status).toBe(200);
    expect(counter.reads - before).toBe(0);
    const lines = res.headers.getSetCookie();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(`${SESSION}=;`)).toBe(true);
    expect(lines[0]).toContain("Max-Age=0");
    // The count works: a page request reads the session once.
    await fetch(new Request(`${API}/`));
    expect(counter.reads - before).toBe(1);
  }

  it("reads no session for a path of core", async () => {
    await signOutAfterRefresh({});
  });

  it("reads no session for a path of core on the base path of the auth object", async () => {
    await signOutAfterRefresh({ basePath: "/api/auth" });
  });

  it("gives the session to a handler in event.context", async () => {
    const { fetch, signIn } = makeApp();
    expect(await (await fetch(new Request(`${API}/`))).text()).toBe("signed out");
    const cookie = await signIn();
    expect(await (await fetch(new Request(`${API}/`, { headers: { cookie } }))).text()).toBe(
      "ada@example.com",
    );
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { fetch } = makeApp();
    const res = await fetch(new Request(`${API}/account`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${API}/sign-in?next=%2Faccount`);
  });

  it("reads the decoded path, as the page router reads it", async () => {
    // Vue Router renders the page of /account for /%61ccount: the gate must protect it too.
    const { fetch } = makeApp();
    const res = await fetch(new Request(`${API}/%61ccount`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${API}/sign-in?next=%2Faccount`);
  });

  it("renews the session cookie on the page's answer", async () => {
    const { fetch, signIn, advance } = makeApp();
    const cookie = await signIn();
    advance(8 * DAY);
    const res = await fetch(new Request(`${API}/account`, { headers: { cookie } }));
    expect(await res.text()).toBe("account of ada@example.com");
    expect(res.headers.getSetCookie().some((l) => l.startsWith(`${SESSION}=ts_`))).toBe(true);
  });

  it("refuses protect without signInPath at construction", () => {
    const { auth } = makeApp();
    expect(() => authSessionHandler({ auth, protect: () => true })).toThrow(/signInPath/);
  });
});
