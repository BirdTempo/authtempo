import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { bodyCapOf } from "@authtempo/core/bindings";
import type { APIContext } from "astro";
import { describe, expect, it } from "vitest";
import { authMiddleware, authRoute } from "../src/index.js";

const BASE = "https://app.example.com";
const DAY = 24 * 60 * 60 * 1000;

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
  // The real session call of core, with a count of the calls of the gate.
  const counter = { reads: 0 };
  const session = auth.session.bind(auth);
  auth.session = (request, options) => {
    counter.reads++;
    return session(request, options);
  };
  const route = authRoute(auth);
  /**
   * The fields of APIContext that the binding reads, built as Astro 7.3.8
   * builds them (dist/core/fetch/fetch-state.js). `routed` is the text that
   * Astro's router matched. Astro writes it into `url` with the pathname
   * setter, which parses it again, and keeps it in `originPathname` with a "/"
   * appended (trailing slash "ignore", build format "directory"). The real
   * pipeline of Astro runs in the example's proof.
   */
  const context = (request: Request, routed: string = new URL(request.url).pathname) => {
    const url = new URL(request.url);
    url.pathname = routed;
    const originPathname = routed.endsWith("/") ? routed : `${routed}/`;
    return { request, url, originPathname, locals: {} } as unknown as APIContext;
  };
  async function signIn(): Promise<string> {
    const post = (path: string, body: unknown) =>
      route(
        context(
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
    const line = res.headers.getSetCookie().find((l) => l.startsWith("__Host-tempo_session="));
    return (line ?? "").split(";")[0] ?? "";
  }
  const middleware = authMiddleware({
    auth,
    protect: (p) => p.startsWith("/account"),
    signInPath: "/sign-in",
  });
  return {
    auth,
    prefix,
    counter,
    route,
    context,
    signIn,
    middleware,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("@authtempo/astro (plan 11d2)", () => {
  it("serves the routes of core from one endpoint", async () => {
    const { signIn } = setup();
    expect((await signIn()).startsWith("__Host-tempo_session=ts_")).toBe(true);
  });

  // In Astro the middleware runs for the endpoint of core too. A read of the
  // session there would add a renewed cookie after core's clear line of a
  // sign-out, and the browser would keep the cookie.
  async function signOutAfterRefresh(core: { basePath?: string }) {
    const { prefix, counter, route, context, signIn, middleware, advance } = setup(core);
    const cookie = await signIn();
    advance(8 * DAY);
    const before = counter.reads;
    const ctx = context(
      new Request(`${BASE}${prefix}/sign-out`, {
        method: "POST",
        headers: { cookie, origin: BASE },
      }),
    );
    const res = (await middleware(ctx, async () => route(ctx))) as Response;
    expect(res.status).toBe(200);
    expect(counter.reads - before).toBe(0);
    const lines = res.headers.getSetCookie();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("__Host-tempo_session=;")).toBe(true);
    expect(lines[0]).toContain("Max-Age=0");
    // The count works: a page request reads the session once.
    await middleware(context(new Request(`${BASE}/`)), async () => new Response("page"));
    expect(counter.reads - before).toBe(1);
  }

  it("reads no session for a path of core", async () => {
    await signOutAfterRefresh({});
  });

  it("reads no session for a path of core on the base path of the auth object", async () => {
    await signOutAfterRefresh({ basePath: "/api/auth" });
  });

  it("puts the session in locals, and runs the page", async () => {
    const { signIn, context, middleware } = setup();
    const cookie = await signIn();
    const ctx = context(new Request(`${BASE}/`, { headers: { cookie } }));
    const res = await middleware(ctx, async () => new Response("page"));
    expect(await (res as Response).text()).toBe("page");
    expect(ctx.locals.session?.user.email).toBe("ada@example.com");
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { context, middleware } = setup();
    let ran = false;
    const res = (await middleware(context(new Request(`${BASE}/account`)), async () => {
      ran = true;
      return new Response("page");
    })) as Response;
    expect(ran).toBe(false);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
  });

  // Astro decodes the path until it stops changing and merges duplicate
  // slashes before its router matches (plan 11d2 path probe). The gate must
  // judge that routed URL, not the raw request.url.
  for (const raw of ["/%61ccount", "//account"]) {
    it(`judges the routed URL, not the raw path ${raw}`, async () => {
      const { auth, context } = setup();
      const exact = authMiddleware({
        auth,
        protect: (p) => p === "/account",
        signInPath: "/sign-in",
      });
      let runs = 0;
      const res = (await exact(context(new Request(`${BASE}${raw}`), "/account"), async () => {
        runs++;
        return new Response("page");
      })) as Response;
      expect(runs).toBe(0);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
    });
  }

  // Astro routes the raw "/caf%25C3%25A9" as "/café", and the rule gets that
  // text. next comes from context.url, whose pathname is "/caf%C3%A9".
  it("gives protect the decoded text that Astro routed", async () => {
    const { auth, context } = setup();
    const exact = authMiddleware({
      auth,
      protect: (p) => p === "/café",
      signInPath: "/sign-in",
    });
    let runs = 0;
    const res = (await exact(context(new Request(`${BASE}/caf%25C3%25A9`), "/café"), async () => {
      runs++;
      return new Response("page");
    })) as Response;
    expect(runs).toBe(0);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Fcaf%25C3%25A9`);
  });

  // Astro resolves dot segments before its router matches, and the gate
  // judges context.url. A dotted path is judged as the path it resolves to.
  it("judges /account/.. as the path / that Astro routed", async () => {
    const { auth, context, counter } = setup();
    const prefix = authMiddleware({
      auth,
      protect: (p) => p.startsWith("/account"),
      signInPath: "/sign-in",
    });
    let runs = 0;
    const res = (await prefix(context(new Request(`${BASE}/account/..`), "/"), async () => {
      runs++;
      return new Response("home");
    })) as Response;
    expect(runs).toBe(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("home");
    expect(counter.reads).toBe(1);
  });

  it("passes /account/../auth/session to core as /auth/session", async () => {
    const { auth, route, context, counter } = setup();
    const prefix = authMiddleware({
      auth,
      protect: (p) => p.startsWith("/account"),
      signInPath: "/sign-in",
    });
    const ctx = context(new Request(`${BASE}/account/../auth/session`), "/auth/session");
    const res = (await prefix(ctx, async () => route(ctx))) as Response;
    // Core's own answer for no session, and no read by the gate on a path of core.
    expect(res.status).toBe(401);
    expect(counter.reads).toBe(0);
  });

  // The second path probe of plan 11d2: on a splat route /account/[...rest],
  // Astro routes the decoded text, and context.url parses that text again
  // ("/account/../x" becomes "/x"). The rule must get the routed text.
  for (const [raw, routed] of [
    ["/account/%252e%252e/x", "/account/../x"],
    ["/account/x%5C..%5C..%5Cauth%5Cy", "/account/x\\..\\..\\auth\\y"],
    ["/account/%09../auth/x", "/account/\t../auth/x"],
    ["/account/%252e%252e", "/account/.."],
  ] as const) {
    it(`protects the splat route at ${raw}, judged as Astro routed it`, async () => {
      const { auth, context } = setup();
      const seen: string[] = [];
      const prefix = authMiddleware({
        auth,
        protect: (p) => {
          seen.push(p);
          return p.startsWith("/account");
        },
        signInPath: "/sign-in",
      });
      let runs = 0;
      const res = (await prefix(context(new Request(`${BASE}${raw}`), routed), async () => {
        runs++;
        return new Response("SPLAT-RAN");
      })) as Response;
      expect(seen).toEqual([routed]);
      expect(runs).toBe(0);
      expect(res.status).toBe(307);
    });
  }

  // Plan-wide P1 (the SvelteKit review): a path that the router decodes to a
  // path of core must never run a page. Astro decodes "/%61uth/session" to
  // "/auth/session" before its match, so pages/auth/[...path].ts wins over a
  // catch-all page. With core 12f6eed the gate skips such a path and core,
  // which matches the raw path, answers 404. Since core round 10 (3aa2d84) the
  // gate skips only when the raw and the routed path are both of core, so it
  // answers 307 first. No page runs either way: pin the set, not one status.
  for (const [raw, routed] of [
    ["/%61uth/session", "/auth/session"],
    ["/%61uth/x", "/auth/x"],
  ] as const) {
    it(`runs no page for ${raw}, which Astro routes to core`, async () => {
      const { auth, route, context } = setup();
      const seen: string[] = [];
      const all = authMiddleware({
        auth,
        protect: (p) => {
          seen.push(p);
          return p !== "/";
        },
        signInPath: "/sign-in",
      });
      let runs = 0;
      const page = async () => {
        runs++;
        return new Response("PAGE RAN");
      };
      const ctx = context(new Request(`${BASE}${raw}`), routed);
      // Astro's router: the auth endpoint matches the routed text before a catch-all page.
      const astro = async () => (routed.startsWith("/auth/") ? route(ctx) : page());
      const res = (await all(ctx, astro)) as Response;
      expect([307, 401, 404]).toContain(res.status);
      expect(runs).toBe(0);
      // The rule gets Astro's matched path, once (core round 10, 3aa2d84).
      expect(seen).toEqual([routed]);
    });
  }

  it("renews the session cookie on the page's answer", async () => {
    const { signIn, context, middleware, advance } = setup();
    const cookie = await signIn();
    advance(8 * DAY);
    const res = (await middleware(
      context(new Request(`${BASE}/account`, { headers: { cookie } })),
      async () => new Response("page"),
    )) as Response;
    expect(res.headers.getSetCookie().some((l) => l.startsWith("__Host-tempo_session=ts_"))).toBe(
      true,
    );
  });

  it("refuses protect without signInPath at construction", () => {
    const { auth } = setup();
    expect(() => authMiddleware({ auth, protect: () => true })).toThrow(/signInPath/);
  });
});

/**
 * A stand-in for core whose `handle` gives one promise to the `waitUntil`
 * it gets (ruling 29 of plan 12i). `got` holds "none" for a call with no
 * options. `Ctx` throws on an unbound call, as the ExecutionContext of Workers does.
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

class Ctx {
  held: Promise<unknown>[] = [];
  props = {};
  waitUntil(promise: Promise<unknown>): void {
    if (!(this instanceof Ctx)) throw new TypeError("Illegal invocation");
    this.held.push(promise);
  }
  passThroughOnException(): void {}
}

describe("the waitUntil of handle (ruling 29 of plan 12i)", () => {
  const at = (locals: object) =>
    ({ request: new Request(`${BASE}/auth/x`), locals }) as unknown as APIContext;

  it("passes locals.cfContext of Workers, the option in its place, or none", async () => {
    const s = waitSpy();
    const ctx = new Ctx();
    await authRoute(s.auth)(at({ cfContext: ctx }));
    expect(ctx.held).toEqual([s.work]);
    // With no Cloudflare adapter, locals holds no cfContext: handle gets no options.
    await authRoute(s.auth)(at({}));
    expect(s.got).toEqual(["options", "none"]);
    const seen: [Promise<unknown>, unknown][] = [];
    const unused = new Ctx();
    const context = at({ cfContext: unused });
    await authRoute(s.auth, { waitUntil: (p, c) => void seen.push([p, c]) })(context);
    expect(seen).toEqual([[s.work, context]]);
    expect(unused.held).toEqual([]);
  });
});

/** A JSON POST of `bytes` bytes to the magic link request: the address, then spaces. */
const capBody = (bytes: number) => {
  const json = JSON.stringify({ email: "ada@example.com" });
  return json + " ".repeat(bytes - json.length);
};
/** The cap of the route of the test below: core's floor. */
const CAP = bodyCapOf("POST /magic-link/request");

describe("the body cap through the binding (ruling 46 of the 12j lane)", () => {
  it("answers core's 413 body_too_large one byte past the cap of the route", async () => {
    const { route, context } = setup();
    const send = (bytes: number) =>
      route(
        context(
          new Request(`${BASE}/auth/magic-link/request`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: BASE },
            body: capBody(bytes),
          }),
        ),
      );
    const at = await send(CAP);
    expect(at.status).toBe(200);
    const over = await send(CAP + 1);
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "body_too_large" });
  });
});
