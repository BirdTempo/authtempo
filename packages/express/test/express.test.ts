import type { AddressInfo } from "node:net";
import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { authHandler, authSession, getSession } from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** An Express app on a port of the test. The auth instance is made after the port is known. */
async function serve(
  parser?: "json" | "form",
  opts: { sessionFirst?: boolean; pref?: boolean } = {},
) {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const mail: MailMessage[] = [];
  let auth: Auth | null = null;
  const getAuth = (): Auth => {
    if (!auth) throw new Error("no auth yet");
    return auth;
  };
  const app = express();
  if (parser === "json") app.use(express.json());
  if (parser === "form") app.use(express.urlencoded({ extended: false }));
  const mountSession = () =>
    app.use(
      authSession({
        auth: getAuth,
        protect: (p) => p.startsWith("/account"),
        signInPath: "/sign-in",
      }),
    );
  // A cookie of the app, set before the routes of core.
  if (opts.pref)
    app.use((_req, res, next) => {
      res.cookie("pref", "1");
      next();
    });
  if (opts.sessionFirst) mountSession();
  app.use("/auth", authHandler(getAuth));
  if (!opts.sessionFirst) mountSession();
  app.get("/", (_req, res) => {
    res.send(getSession(res)?.user.email ?? "signed out");
  });
  app.get("/account", (_req, res) => {
    res.send(`account of ${getSession(res)?.user.email}`);
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  stops.push(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  auth = createAuth({
    baseURL: base,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [base],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock: { now: () => now },
  });
  // The real session call of core, with a count of the calls of the gate.
  const counter = { reads: 0 };
  const session = auth.session.bind(auth);
  auth.session = (request, options) => {
    counter.reads++;
    return session(request, options);
  };
  async function signIn(verifyAs: "json" | "form" = "json"): Promise<string> {
    await fetch(`${base}/auth/magic-link/request`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: "ada@example.com" }),
    });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    const res = await fetch(`${base}/auth/magic-link/verify`, {
      method: "POST",
      redirect: "manual",
      headers:
        verifyAs === "json"
          ? { "content-type": "application/json", origin: base }
          : { "content-type": "application/x-www-form-urlencoded", origin: base },
      body:
        verifyAs === "json" ? JSON.stringify({ token }) : new URLSearchParams({ token }).toString(),
    });
    lastLines = res.headers.getSetCookie();
    const line = lastLines.find((l) => l.startsWith("__Host-tempo_session=")) ?? "";
    return line.split(";")[0] ?? "";
  }
  let lastLines: string[] = [];
  return {
    base,
    counter,
    signIn,
    lines: () => lastLines,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe("@authtempo/express (plan 11d2)", () => {
  it("serves the routes of core under /auth, with the session cookie", async () => {
    const { base, signIn } = await serve();
    expect((await fetch(`${base}/auth/session`)).status).toBe(401);
    const cookie = await signIn();
    expect(cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);
    const me = await fetch(`${base}/auth/session`, { headers: { cookie } });
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("ada@example.com");
  });

  it("keeps a Set-Cookie line of an earlier middleware on the answer of core", async () => {
    const { signIn, lines } = await serve(undefined, { pref: true });
    const cookie = await signIn();
    expect(cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);
    expect(lines().some((l) => l.startsWith("pref=1"))).toBe(true);
  });

  // A read of the session on a route of core would add a renewed cookie after
  // core's clear line of a sign-out, and the browser would keep the cookie.
  it("reads no session for a path of core, with authSession mounted first", async () => {
    const { base, counter, signIn, advance } = await serve(undefined, { sessionFirst: true });
    const cookie = await signIn();
    advance(8 * DAY);
    const before = counter.reads;
    const res = await fetch(`${base}/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin: base },
    });
    expect(res.status).toBe(200);
    expect(counter.reads - before).toBe(0);
    const lines = res.headers.getSetCookie();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("__Host-tempo_session=;")).toBe(true);
    expect(lines[0]).toContain("Max-Age=0");
    // The count works: a page request reads the session once.
    await fetch(`${base}/`);
    expect(counter.reads - before).toBe(1);
  });

  it("reads a body that express.json() parsed", async () => {
    const { signIn } = await serve("json");
    expect((await signIn("json")).startsWith("__Host-tempo_session=ts_")).toBe(true);
  });

  it("reads a form body that express.urlencoded() parsed", async () => {
    const { signIn } = await serve("form");
    expect((await signIn("form")).startsWith("__Host-tempo_session=ts_")).toBe(true);
  });

  it("gives the session to a route in res.locals", async () => {
    const { base, signIn } = await serve();
    expect(await (await fetch(`${base}/`)).text()).toBe("signed out");
    const cookie = await signIn();
    expect(await (await fetch(`${base}/`, { headers: { cookie } })).text()).toBe("ada@example.com");
  });

  it("sends a person with no session on a protected path to the sign-in page", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/account?tab=2`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${base}/sign-in?next=%2Faccount%3Ftab%3D2`);
  });

  it("renews the session cookie on the page's answer", async () => {
    const { base, signIn, advance } = await serve();
    const cookie = await signIn();
    advance(8 * DAY);
    const res = await fetch(`${base}/account`, { headers: { cookie } });
    expect(await res.text()).toBe("account of ada@example.com");
    expect(res.headers.getSetCookie().some((l) => l.startsWith("__Host-tempo_session=ts_"))).toBe(
      true,
    );
  });
});
