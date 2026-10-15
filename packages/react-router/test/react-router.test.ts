import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { RouterContextProvider } from "react-router";
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
  // The arguments of a loader, an action, and a middleware, with React Router's own context.
  const args = (request: Request) => ({
    request,
    url: new URL(request.url),
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
    let seen: string | undefined;
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

  // A client navigation of a framework app sends "/account.data?_routes=...".
  // React Router gives the middleware the raw request and the routed `url`.
  it("gates the routed URL of a data request, not the raw URL", async () => {
    const { auth, args } = setup();
    const exact = authMiddleware({
      auth,
      protect: (p) => p === "/account",
      signInPath: "/sign-in",
    });
    const a = {
      ...args(new Request(`${BASE}/account.data?_routes=account&tab=2`)),
      url: new URL(`${BASE}/account?tab=2`),
    };
    let ran = false;
    const res = (await exact(a, async () => {
      ran = true;
      return new Response("page");
    })) as Response;
    expect(ran).toBe(false);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount%3Ftab%3D2`);
  });

  // React Router decodes each segment once before it matches: "/%61ccount"
  // runs the page of "/account", on a page request and on a data request.
  it("gates the once-decoded path that the router matched", async () => {
    const { auth, args } = setup();
    const exact = authMiddleware({
      auth,
      protect: (p) => p === "/account",
      signInPath: "/sign-in",
    });
    for (const raw of ["/%61ccount", "/%61ccount.data?_routes=account"]) {
      const a = { ...args(new Request(`${BASE}${raw}`)), url: new URL(`${BASE}/%61ccount`) };
      let ran = false;
      const res = (await exact(a, async () => {
        ran = true;
        return new Response("page");
      })) as Response;
      expect(ran).toBe(false);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
    }
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
