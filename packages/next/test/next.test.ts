import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import {
  DEFAULT_COOKIE_NAME,
  LEGACY_COOKIE_NAME,
  SESSION_TOKEN_PREFIX,
} from "@authtempo/core/credentials";
import { describe, expect, it } from "vitest";
import { authProxy, authRouteHandlers, authSession } from "../src/index.js";

const BASE = "https://app.example.com";

const DAY = 86_400_000;

function makeAuth() {
  const mail: MailMessage[] = [];
  let now = new Date("2026-01-01T00:00:00.000Z");
  const clock = {
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
  const auth = createAuth({
    clock,
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [BASE],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
  });
  return { auth, mail, clock };
}

/** Signs ada in through the route handlers; answers the cookie pair and the whole Set-Cookie line. */
async function signIn(auth: Auth, mail: MailMessage[]) {
  const { POST } = authRouteHandlers(auth);
  const json = (path: string, body: unknown) =>
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    });
  await POST(json("/auth/magic-link/request", { email: "ada@example.com" }));
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
  const verify = await POST(json("/auth/magic-link/verify", { token }));
  const line = verify.headers.get("set-cookie") ?? "";
  return { cookie: line.split(";")[0] ?? "", line };
}

async function signedIn(auth: Auth, mail: MailMessage[]) {
  return (await signIn(auth, mail)).cookie;
}

describe("@authtempo/next (plan 11d)", () => {
  it("serves the routes of core through GET, POST, and OPTIONS", async () => {
    const { auth, mail } = makeAuth();
    const { GET, OPTIONS } = authRouteHandlers(auth);
    expect((await GET(new Request(`${BASE}/auth/session`))).status).toBe(401);
    const { cookie, line } = await signIn(auth, mail);
    // The cookie rule (plan 12b): the name comes from core, never a literal.
    expect(cookie.startsWith(`${DEFAULT_COOKIE_NAME}=ts_`)).toBe(true);
    // The handlers pass core's Set-Cookie through whole: a __Host- cookie without one of these is dropped.
    const attributes = line.split(";").map((a) => a.trim());
    for (const a of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"])
      expect(attributes).toContain(a);
    const me = await GET(new Request(`${BASE}/auth/session`, { headers: { cookie } }));
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("ada@example.com");
    const pre = await OPTIONS(
      new Request(`${BASE}/auth/session`, { method: "OPTIONS", headers: { origin: BASE } }),
    );
    expect(pre.status).toBe(204);
  });

  it("takes a function that makes the auth instance at the first request", async () => {
    const { auth } = makeAuth();
    let made = 0;
    const { GET } = authRouteHandlers(() => {
      made++;
      return auth;
    });
    expect(made).toBe(0);
    await GET(new Request(`${BASE}/auth/session`));
    expect(made).toBe(1);
  });

  it("reads the session of a server component from its headers", async () => {
    const { auth, mail } = makeAuth();
    expect(await authSession(auth, new Headers())).toBeNull();
    const cookie = await signedIn(auth, mail);
    const s = await authSession(() => auth, new Headers({ cookie }));
    expect(s?.user.email).toBe("ada@example.com");
  });

  it("sends a request with no session cookie on a protected path to the sign-in page, with next", async () => {
    const proxy = authProxy({ protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" });
    expect(await proxy(new Request(`${BASE}/`))).toBeUndefined();
    const out = await proxy(new Request(`${BASE}/account/billing?tab=2`));
    expect(out?.status).toBe(307);
    expect(out?.headers.get("location")).toBe(
      `${BASE}/sign-in?next=%2Faccount%2Fbilling%3Ftab%3D2`,
    );
    const withCookie = await proxy(
      new Request(`${BASE}/account`, { headers: { cookie: `${DEFAULT_COOKIE_NAME}=ts_any` } }),
    );
    expect(withCookie).toBeUndefined();
    // The name before plan 12b counts for one release, as core reads it.
    const legacy = await proxy(
      new Request(`${BASE}/account`, { headers: { cookie: `${LEGACY_COOKIE_NAME}=ts_any` } }),
    );
    expect(legacy).toBeUndefined();
    // A custom cookie name reads no old name.
    const custom = authProxy({ protect: () => true, signInPath: "/sign-in", cookieName: "app_s" });
    expect(
      (
        await custom(
          new Request(`${BASE}/account`, { headers: { cookie: `${LEGACY_COOKIE_NAME}=ts_any` } }),
        )
      )?.status,
    ).toBe(307);
  });

  it("asks core for the session when the proxy has the auth instance", async () => {
    const { auth, mail } = makeAuth();
    const cookie = await signedIn(auth, mail);
    const proxy = authProxy({ protect: () => true, signInPath: "/sign-in", auth });
    expect(await proxy(new Request(`${BASE}/account`, { headers: { cookie } }))).toBeUndefined();
    const dead = await proxy(
      new Request(`${BASE}/account`, { headers: { cookie: `${DEFAULT_COOKIE_NAME}=ts_dead` } }),
    );
    expect(dead?.status).toBe(307);
  });

  it("leaves the sliding refresh to the browser: a server read 8 days on, then GET /auth/session renews the cookie", async () => {
    const { auth, mail, clock } = makeAuth();
    const { GET } = authRouteHandlers(auth);
    const cookie = await signedIn(auth, mail);
    clock.advance(8 * DAY);
    // A page load renders the server component first.
    expect((await authSession(auth, new Headers({ cookie })))?.user.email).toBe("ada@example.com");
    const store = await GET(new Request(`${BASE}/auth/session`, { headers: { cookie } }));
    expect(store.status).toBe(200);
    expect(store.headers.get("set-cookie") ?? "").toContain(`${DEFAULT_COOKIE_NAME}=ts_`);
  });

  it("leaves the sliding refresh to the browser after a proxy with the auth instance too", async () => {
    const { auth, mail, clock } = makeAuth();
    const { GET } = authRouteHandlers(auth);
    const cookie = await signedIn(auth, mail);
    clock.advance(8 * DAY);
    const proxy = authProxy({ protect: () => true, signInPath: "/sign-in", auth });
    expect(await proxy(new Request(`${BASE}/account`, { headers: { cookie } }))).toBeUndefined();
    const store = await GET(new Request(`${BASE}/auth/session`, { headers: { cookie } }));
    expect(store.headers.get("set-cookie") ?? "").toContain(`${DEFAULT_COOKIE_NAME}=ts_`);
  });

  it("counts a bearer as a session only with core's session token prefix, when the proxy has no auth", async () => {
    const proxy = authProxy({ protect: () => true, signInPath: "/sign-in" });
    const with_ = (authorization: string) =>
      proxy(new Request(`${BASE}/account`, { headers: { authorization } }));
    expect((await with_("Bearer x"))?.status).toBe(307);
    expect((await with_("Bearer tk_apitoken"))?.status).toBe(307);
    expect(await with_(`Bearer ${SESSION_TOKEN_PREFIX}abc`)).toBeUndefined();
  });

  it("puts only a path of this origin in next, encoded whole", async () => {
    const proxy = authProxy({ protect: () => true, signInPath: "/sign-in" });
    const out = await proxy(new Request(`${BASE}//evil.example/account?q=1`));
    expect(out?.headers.get("location")).toBe(
      `${BASE}/sign-in?next=${encodeURIComponent("/evil.example/account?q=1")}`,
    );
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
  it("passes the option with the request, or none", async () => {
    const s = waitSpy();
    const request = new Request(`${BASE}/auth/x`, { method: "POST" });
    const seen: [Promise<unknown>, unknown][] = [];
    await authRouteHandlers(s.auth, { waitUntil: (p, r) => void seen.push([p, r]) }).POST(request);
    expect(seen).toEqual([[s.work, request]]);
    await authRouteHandlers(s.auth).GET(request);
    expect(s.got).toEqual(["options", "none"]);
  });
});
