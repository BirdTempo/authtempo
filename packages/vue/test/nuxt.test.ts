import { createApp, createRouter, defineEventHandler, toPlainHandler, toWebHandler } from "h3";
import { describe, expect, it } from "vitest";
import { authEventHandler, authSessionHandler, getSession } from "../src/nuxt.js";
import { API, APP, makeServer, SESSION } from "./support.js";

const DAY = 24 * 60 * 60 * 1000;

/** An h3 app as Nitro builds one: a server middleware, the routes of core, and two pages. */
function makeApp(
  core: { basePath?: string } = {},
  protect: (pathname: string) => boolean = (p) => p.startsWith("/account"),
) {
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
      protect,
      signInPath: "/sign-in",
    }),
  );
  const router = createRouter();
  router.use(`${prefix}/**`, authEventHandler(server.auth));
  router.get(
    "/",
    defineEventHandler((event) => getSession(event)?.user.email ?? "signed out"),
  );
  // The page code: a redirect must answer before it runs. "/account/:id" is a
  // child route, as a server route server/routes/account/[id].ts is in Nitro.
  let pageRuns = 0;
  const page = defineEventHandler((event) => {
    pageRuns++;
    return `account of ${getSession(event)?.user.email}`;
  });
  router.get("/account", page);
  router.get("/account/:id", page);
  router.get("/café", page);
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
    app,
    auth: server.auth,
    prefix,
    counter,
    fetch,
    signIn,
    pageRuns: () => pageRuns,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

/** The origin of the requests through the plain handler. */
const NODE = "http://127.0.0.1:8796";

/**
 * One GET through h3's plain handler: the Node shape of h3 (a mock of Node's
 * request with the target as written), with no URL parse on the way, as
 * Node's HTTP server gives a request to Nitro.
 */
async function rawGet(
  app: ReturnType<typeof createApp>,
  target: string,
  headers: Record<string, string> = { host: "127.0.0.1:8796" },
): Promise<{ status: number; location: string | null }> {
  const res = await toPlainHandler(app)({ method: "GET", path: target, headers });
  const location = res.headers.find(([name]) => name.toLowerCase() === "location")?.[1] ?? null;
  return { status: res.status, location };
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
    const { fetch, pageRuns } = makeApp();
    const res = await fetch(new Request(`${API}/account`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${API}/sign-in?next=%2Faccount`);
    expect(pageRuns()).toBe(0);
  });

  it("reads the decoded path, as the page router reads it", async () => {
    // Vue Router renders the page of /account for /%61ccount: the gate must protect it too.
    const { fetch, pageRuns } = makeApp();
    const res = await fetch(new Request(`${API}/%61ccount`));
    expect(res.status).toBe(307);
    // next is the request's own path (core round 8): a browser that opens it
    // reaches this gate again.
    expect(res.headers.get("location")).toBe(`${API}/sign-in?next=%2F%2561ccount`);
    expect(pageRuns()).toBe(0);
  });

  it("reads an escaped ? as h3 reads it, under an exact rule", async () => {
    // h3 decodes "%3F", so /account%3F routes to the page of /account.
    const { fetch, pageRuns } = makeApp({}, (p) => p === "/account");
    const res = await fetch(new Request(`${API}/account%3F`));
    expect(res.status).toBe(307);
    // The gate judges the text that h3 routes, "/account?"; next is the request's own path.
    expect(res.headers.get("location")).toBe(`${API}/sign-in?next=%2Faccount%253F`);
    expect(pageRuns()).toBe(0);
  });

  it("gives a non-ASCII path to the rule decoded, as h3 routes it", async () => {
    const seen: string[] = [];
    const { fetch, pageRuns } = makeApp({}, (p) => {
      seen.push(p);
      return p === "/café";
    });
    const res = await fetch(new Request(`${API}/caf%C3%A9`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${API}/sign-in?next=%2Fcaf%25C3%25A9`);
    expect(seen).toEqual(["/café"]);
    expect(pageRuns()).toBe(0);
  });

  // h3 on Node routes the raw target decoded once, with no dot resolution and
  // no backslash rule: a web Request would parse the target before h3 sees it,
  // so these run through the plain handler, the Node shape of h3.
  it.each([
    ["/account/..", "/account/.."],
    ["/account/%2e%2e", "/account/.."],
    ["/account/../auth/session", "/account/../auth/session"],
    ["/account/%2e%2e/auth/session", "/account/../auth/session"],
    ["/account/x\\..\\..\\auth\\y", "/account/x\\..\\..\\auth\\y"],
    ["/account/x%5C..%5C..%5Cauth%5Cy", "/account/x\\..\\..\\auth\\y"],
    ["/account/%09../auth/x", "/account/\t../auth/x"],
  ])("protects the raw path %s as h3 routes it", async (target, judged) => {
    const seen: string[] = [];
    const { app, pageRuns } = makeApp({}, (p) => {
      seen.push(p);
      return p.startsWith("/account");
    });
    const res = await rawGet(app, target);
    expect(res.status).toBe(307);
    // next is the request's own path: the URL of the page, as a browser would resolve it.
    const page = new URL(target, NODE);
    expect(res.location).toBe(
      `${NODE}/sign-in?next=${encodeURIComponent(page.pathname + page.search)}`,
    );
    expect(seen).toEqual([judged]);
    expect(pageRuns()).toBe(0);
  });

  it("takes the origin of the redirect from Host, not from an absolute-form target", async () => {
    const { app, pageRuns } = makeApp({}, (p) => p.includes("/account"));
    const res = await rawGet(app, "http://evil.example/account");
    expect(res.status).toBe(307);
    expect(res.location?.startsWith(`${NODE}/sign-in?next=`)).toBe(true);
    expect(pageRuns()).toBe(0);
  });

  it.each([
    ["a Host that does not parse", { host: "bad host/x" }],
    ["no Host", {}],
  ])("falls back to the origin of auth.baseURL for %s", async (_, headers) => {
    const { app, pageRuns } = makeApp();
    const res = await rawGet(app, "/account", headers);
    expect(res.status).toBe(307);
    expect(res.location).toBe(`${API}/sign-in?next=%2Faccount`);
    expect(pageRuns()).toBe(0);
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
