import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type AuthEnv, authHandler, authSession, getSession } from "../src/index.js";

const BASE = "https://app.example.com";
const DAY = 24 * 60 * 60 * 1000;

function makeApp() {
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
  });
  const app = new Hono<AuthEnv>();
  app.use(
    "*",
    authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" }),
  );
  app.on(["GET", "POST", "OPTIONS"], "/auth/*", authHandler(auth));
  app.get("/", (c) => c.text(getSession(c)?.user.email ?? "signed out"));
  app.get("/account", (c) => c.text(`account of ${getSession(c)?.user.email}`));
  async function signIn(): Promise<{ cookie: string; lines: string[] }> {
    const post = (path: string, body: unknown) =>
      app.request(`${BASE}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify(body),
      });
    await post("/magic-link/request", { email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const res = await post("/magic-link/verify", { token });
    const lines = res.headers.getSetCookie();
    return { cookie: (lines[0] ?? "").split(";")[0] ?? "", lines };
  }
  return { app, auth, signIn, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("@authtempo/hono (plan 11d2)", () => {
  it("serves the routes of core, and passes every Set-Cookie line of core", async () => {
    const { app, signIn } = makeApp();
    expect((await app.request(`${BASE}/auth/session`)).status).toBe(401);
    const { cookie, lines } = await signIn();
    expect(lines.length).toBeGreaterThan(0);
    expect(cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);
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
