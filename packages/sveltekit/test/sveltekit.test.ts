import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import type { RequestEvent } from "@sveltejs/kit";
import { describe, expect, it } from "vitest";
import { authHandle } from "../src/index.js";

const BASE = "https://app.example.com";
const DAY = 24 * 60 * 60 * 1000;

function setup(
  core: { basePath?: string } = {},
  protect: (pathname: string) => boolean = (p) => p.startsWith("/account"),
) {
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
  // The real session call of core, with a count of the calls of the hook.
  const counter = { reads: 0 };
  const session = auth.session.bind(auth);
  auth.session = (request, options) => {
    counter.reads++;
    return session(request, options);
  };
  const handle = authHandle({
    auth,
    protect,
    signInPath: "/sign-in",
  });
  /**
   * The three fields of RequestEvent that the binding reads. The real pipeline
   * of SvelteKit runs in the example's proof; this test holds the binding's rule.
   * `url` is the routed URL; Kit makes it differ from request.url for a data request.
   */
  const event = (request: Request, url: URL) =>
    ({ request, url, locals: {} }) as unknown as RequestEvent;
  let pageRuns = 0;
  const page = async () => {
    pageRuns++;
    return new Response("page");
  };
  async function run(request: Request, url = new URL(request.url)) {
    const e = event(request, url);
    const res = await handle({ event: e, resolve: page });
    return { res, locals: e.locals };
  }
  async function signIn(): Promise<string> {
    const post = (path: string, body: unknown) =>
      run(
        new Request(`${BASE}${prefix}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify(body),
        }),
      );
    await post("/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const { res } = await post("/magic-link/verify", { token });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }
  return {
    auth,
    prefix,
    counter,
    run,
    signIn,
    pageRuns: () => pageRuns,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("@authtempo/sveltekit (plan 11d2)", () => {
  it("answers a route of core in the hook, and the page does not run", async () => {
    const { signIn, pageRuns } = setup();
    expect((await signIn()).startsWith("__Host-tempo_session=ts_")).toBe(true);
    expect(pageRuns()).toBe(0);
  });

  // A read of the session on a route of core would add a renewed cookie after
  // core's clear line of a sign-out, and the browser would keep the cookie.
  async function signOutAfterRefresh(core: { basePath?: string }) {
    const { prefix, counter, signIn, run, advance } = setup(core);
    const cookie = await signIn();
    advance(8 * DAY);
    const before = counter.reads;
    const { res } = await run(
      new Request(`${BASE}${prefix}/sign-out`, {
        method: "POST",
        headers: { cookie, origin: BASE },
      }),
    );
    expect(res.status).toBe(200);
    expect(counter.reads - before).toBe(0);
    const lines = res.headers.getSetCookie();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("__Host-tempo_session=;")).toBe(true);
    expect(lines[0]).toContain("Max-Age=0");
    // The count works: a page request reads the session once.
    await run(new Request(`${BASE}/`));
    expect(counter.reads - before).toBe(1);
  }

  it("reads no session for a path of core", async () => {
    await signOutAfterRefresh({});
  });

  it("reads no session for a path of core on the base path of the auth object", async () => {
    await signOutAfterRefresh({ basePath: "/api/auth" });
  });

  it("puts the session in locals, and runs the page", async () => {
    const { signIn, run } = setup();
    const cookie = await signIn();
    const { res, locals } = await run(new Request(`${BASE}/`, { headers: { cookie } }));
    expect(await res.text()).toBe("page");
    expect(locals.session?.user.email).toBe("ada@example.com");
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { run, pageRuns } = setup();
    const { res } = await run(new Request(`${BASE}/account`));
    expect(pageRuns()).toBe(0);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
  });

  // Kit's shape of a data request: the client sends GET /account/__data.json
  // for a link click to /account, and Kit strips the suffix and its query from
  // event.url only. An exact rule must still see "/account".
  it("gates the routed URL of a data request, not the URL of the request", async () => {
    const { run, pageRuns } = setup({}, (p) => p === "/account");
    const { res } = await run(
      new Request(`${BASE}/account/__data.json?x-sveltekit-invalidated=01`),
      new URL(`${BASE}/account`),
    );
    expect(pageRuns()).toBe(0);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
  });

  // Kit matches the path decoded once, but event.url keeps the escapes. An
  // exact rule must see "/account" for "/%61ccount", in both request forms.
  it("gates the path as Kit matched it, decoded once", async () => {
    const { run, pageRuns } = setup({}, (p) => p === "/account");
    const page = await run(new Request(`${BASE}/%61ccount`));
    const data = await run(
      new Request(`${BASE}/%61ccount/__data.json?x-sveltekit-invalidated=01`),
      new URL(`${BASE}/%61ccount`),
    );
    expect(pageRuns()).toBe(0);
    for (const { res } of [page, data]) {
      expect(res.status).toBe(307);
      // next is the page URL as the browser sent it, not the decoded text.
      expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2F%2561ccount`);
    }
  });

  // The gate judges the path exactly as Kit matched it: a non-ASCII path
  // reaches protect decoded, "/café", in both request forms.
  it("gives protect a non-ASCII path as Kit matched it, decoded", async () => {
    const { run, pageRuns } = setup({}, (p) => p === "/café");
    for (const path of ["/caf%C3%A9", "/café"]) {
      const { res } = await run(new Request(`${BASE}${path}`));
      expect(res.status).toBe(307);
      // next is event.url, the page URL: "/caf%C3%A9" for both forms.
      expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Fcaf%25C3%25A9`);
    }
    expect(pageRuns()).toBe(0);
  });

  it("does not match a rule in the encoded form of a non-ASCII path", async () => {
    const { run, pageRuns } = setup({}, (p) => p === "/caf%C3%A9");
    const { res } = await run(new Request(`${BASE}/caf%C3%A9`));
    expect(res.status).toBe(200);
    expect(pageRuns()).toBe(1);
  });

  // Kit builds event.url with new URL, which resolves "..", and "%2e%2e" too
  // (WHATWG URL reads "%2e" as "." in a dot segment). The rule gets the path
  // after that resolution, the path that Kit matches. In real Kit, "/account/"
  // gets Kit's own 308 to "../account" before the hook; the stub has no such step.
  it("gives protect the path after the dot segments, as Kit matched it", async () => {
    const seen: string[] = [];
    const { run, pageRuns } = setup({}, (p) => {
      seen.push(p);
      return p.startsWith("/account");
    });
    const cases = [
      { path: "/account/..", status: 200, judged: "/" },
      { path: "/account/%2e%2e", status: 200, judged: "/" },
      { path: "/account/../auth/session", status: 401, judged: null },
      { path: "/account/x/..", status: 307, judged: "/account/" },
    ];
    for (const c of cases) {
      seen.length = 0;
      const { res } = await run(new Request(`${BASE}${c.path}`));
      expect(res.status, c.path).toBe(c.status);
      expect(seen, c.path).toEqual(c.judged === null ? [] : [c.judged]);
    }
    // "/" is the public home page: the two runs of it. No protected page runs.
    expect(pageRuns()).toBe(2);
  });

  // An escaped backslash or tab stays one character of a segment after Kit's
  // decode, so no ".." resolves and a splat route under /account stays behind
  // the prefix rule (plan 11d2 path probe 2).
  it("gives protect a backslash and a tab as characters, not as separators", async () => {
    const seen: string[] = [];
    const { run, pageRuns } = setup({}, (p) => {
      seen.push(p);
      return p.startsWith("/account");
    });
    const cases = [
      {
        path: "/account/x%5C..%5C..%5Cauth%5Cy",
        judged: "/account/x\\..\\..\\auth\\y",
        next: "%2Faccount%2Fx%255C..%255C..%255Cauth%255Cy",
      },
      {
        path: "/account/%09../auth/x",
        judged: "/account/\t../auth/x",
        next: "%2Faccount%2F%2509..%2Fauth%2Fx",
      },
    ];
    for (const c of cases) {
      seen.length = 0;
      const { res } = await run(new Request(`${BASE}${c.path}`));
      expect(res.status, c.path).toBe(307);
      expect(res.headers.get("location"), c.path).toBe(`${BASE}/sign-in?next=${c.next}`);
      expect(seen, c.path).toEqual([c.judged]);
    }
    expect(pageRuns()).toBe(0);
  });

  // The query of next comes from event.url, and "%3F" stays escaped, as Kit
  // keeps it: "/account%3F" is not "/account". In real Kit that path gets a
  // 404; the stub page answers 200, and the test pins what protect gets.
  it("keeps the query of the routed URL in next", async () => {
    const { run, pageRuns } = setup({}, (p) => p === "/account");
    const page = await run(new Request(`${BASE}/account?tab=keys`));
    const data = await run(
      new Request(`${BASE}/account/__data.json?tab=keys&x-sveltekit-invalidated=01`),
      new URL(`${BASE}/account?tab=keys`),
    );
    const decoded = await run(new Request(`${BASE}/account%3F`));
    expect(pageRuns()).toBe(1);
    expect(decoded.res.status).toBe(200);
    for (const { res } of [page, data]) {
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount%3Ftab%3Dkeys`);
    }
  });

  // Core matches its routes on the raw path, but Kit matches the decoded one.
  // "/%61uth/x" must go to core (404), not to a catch-all page with no gate.
  it("sends a path that Kit decodes to a path of core to core, not to a page", async () => {
    const { run, pageRuns } = setup({}, (p) => p !== "/sign-in");
    const page = await run(new Request(`${BASE}/%61uth/x`));
    const data = await run(
      new Request(`${BASE}/%61uth/x/__data.json?x-sveltekit-invalidated=01`),
      new URL(`${BASE}/%61uth/x`),
    );
    expect(pageRuns()).toBe(0);
    for (const { res } of [page, data]) expect(res.status).toBe(404);
  });

  it("renews the session cookie on the page's answer", async () => {
    const { signIn, run, advance } = setup();
    const cookie = await signIn();
    advance(8 * DAY);
    const { res } = await run(new Request(`${BASE}/account`, { headers: { cookie } }));
    expect(res.headers.getSetCookie().some((l) => l.startsWith("__Host-tempo_session=ts_"))).toBe(
      true,
    );
  });

  it("refuses protect without signInPath at construction", () => {
    const { auth } = setup();
    expect(() => authHandle({ auth, protect: () => true })).toThrow(/signInPath/);
  });
});
