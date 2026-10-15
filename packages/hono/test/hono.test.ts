import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type AuthEnv, authHandler, authSession, getSession } from "../src/index.js";

const BASE = "https://app.example.com";
const DAY = 24 * 60 * 60 * 1000;

function makeApp(core: { basePath?: string } = {}) {
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
  const app = new Hono<AuthEnv>();
  app.use(
    "*",
    authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" }),
  );
  app.on(["GET", "POST", "OPTIONS"], `${prefix}/*`, authHandler(auth));
  app.get("/", (c) => c.text(getSession(c)?.user.email ?? "signed out"));
  app.get("/account", (c) => c.text(`account of ${getSession(c)?.user.email}`));
  async function signIn(
    sent: Record<string, string> = {},
  ): Promise<{ cookie: string; lines: string[] }> {
    const post = (path: string, body: unknown) =>
      app.request(`${BASE}${prefix}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...sent },
        body: JSON.stringify(body),
      });
    await post("/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const res = await post("/magic-link/verify", { token });
    const lines = res.headers.getSetCookie();
    const line = lines.find((l) => l.startsWith("__Host-tempo_session=")) ?? "";
    return { cookie: line.split(";")[0] ?? "", lines };
  }
  return {
    app,
    auth,
    prefix,
    counter,
    signIn,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("@authtempo/hono (plan 11d2)", () => {
  it("serves the routes of core, and passes every Set-Cookie line of core", async () => {
    const { app, signIn } = makeApp();
    expect((await app.request(`${BASE}/auth/session`)).status).toBe(401);
    // The old cookie name (plan 12b): core answers the session line and the clear of the old name.
    const { cookie, lines } = await signIn({ cookie: "tempo_session=ts_old" });
    expect(lines).toHaveLength(2);
    expect(cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);
    expect(lines.some((l) => l.startsWith("tempo_session=;") && l.includes("Max-Age=0"))).toBe(
      true,
    );
  });

  // A read of the session on a route of core would add a renewed cookie after
  // core's clear line of a sign-out, and the browser would keep the cookie.
  async function signOutAfterRefresh(core: { basePath?: string }) {
    const { app, prefix, counter, signIn, advance } = makeApp(core);
    const { cookie } = await signIn();
    advance(8 * DAY);
    const before = counter.reads;
    const res = await app.request(`${BASE}${prefix}/sign-out`, {
      method: "POST",
      headers: { cookie, origin: BASE },
    });
    expect(res.status).toBe(200);
    expect(counter.reads - before).toBe(0);
    const lines = res.headers.getSetCookie();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("__Host-tempo_session=;")).toBe(true);
    expect(lines[0]).toContain("Max-Age=0");
    // The count works: a page request reads the session once.
    await app.request(`${BASE}/`);
    expect(counter.reads - before).toBe(1);
  }

  it("reads no session for a path of core", async () => {
    await signOutAfterRefresh({});
  });

  it("reads no session for a path of core on the base path of the auth object", async () => {
    await signOutAfterRefresh({ basePath: "/api/auth" });
  });

  it("gives the session to a route", async () => {
    const { app, signIn } = makeApp();
    expect(await (await app.request(`${BASE}/`)).text()).toBe("signed out");
    const { cookie } = await signIn();
    expect(await (await app.request(`${BASE}/`, { headers: { cookie } })).text()).toBe(
      "ada@example.com",
    );
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { app } = makeApp();
    const res = await app.request(`${BASE}/account?tab=2`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount%3Ftab%3D2`);
  });

  it("renews the session cookie on the page's answer", async () => {
    const { app, signIn, advance } = makeApp();
    const { cookie } = await signIn();
    advance(8 * DAY);
    const res = await app.request(`${BASE}/account`, { headers: { cookie } });
    expect(await res.text()).toBe("account of ada@example.com");
    expect(res.headers.getSetCookie().some((l) => l.startsWith("__Host-tempo_session=ts_"))).toBe(
      true,
    );
  });

  it("takes a function of the context that makes the auth instance", async () => {
    const { auth } = makeApp();
    let made = 0;
    const app = new Hono();
    app.on(
      ["GET", "POST"],
      "/auth/*",
      authHandler(() => {
        made++;
        return auth;
      }),
    );
    await app.request(`${BASE}/auth/session`);
    expect(made).toBe(1);
  });

  it("refuses protect without signInPath at construction", () => {
    const { auth } = makeApp();
    expect(() => authSession({ auth, protect: () => true })).toThrow(/signInPath/);
  });
});
