import { createClient } from "@authtempo/client";
import type { MailMessage } from "@authtempo/core";
import { describe, expect, it, vi } from "vitest";
import { type AppEnv, createApp } from "../src/app.js";

const BASE = "http://localhost:3000";

function setup() {
  const sent: MailMessage[] = [];
  const rule: string[] = [];
  const pages: string[] = [];
  const env: AppEnv = {
    BASE_URL: BASE,
    AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    mail: {
      async send(m) {
        sent.push(m);
      },
    },
    trace: (event, text) => (event === "rule" ? rule : pages).push(text),
  };
  return { app: createApp(env), sent, rule, pages };
}

describe("the Elysia example (plan 11d2)", () => {
  it("signs a person in with the plain client, reads the session, and verifies the caller of /files", async () => {
    const { app, sent } = setup();
    let cookie = "";
    let lines: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const headers = new Headers(req.headers);
      headers.set("origin", BASE);
      if (cookie) headers.set("cookie", cookie);
      const res = await app.handle(new Request(req, { headers }));
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.includes("Max-Age=0") ? "" : (set.split(";")[0] ?? "");
      lines = res.headers.getSetCookie();
      return res;
    }) as typeof globalThis.fetch;
    const client = createClient({ baseURL: BASE, fetch, credentials: "omit" });
    expect((await app.handle(new Request(`${BASE}/files`))).status).toBe(401);
    // A POST to core: the sign-in works only if Elysia left the body for core.
    expect((await client.magicLink.request({ email: "ada@example.com" })).ok).toBe(true);
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect((await client.magicLink.verify({ token })).ok).toBe(true);
    // The Set-Cookie line of core passes unchanged: one line, the session cookie.
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("__Host-tempo_session=ts_")).toBe(true);
    const account = await app.handle(new Request(`${BASE}/account`, { headers: { cookie } }));
    expect(await account.json()).toEqual({ email: "ada@example.com" });
    // The verifier reads the Authorization header only: the cookie is no credential at /files.
    expect((await app.handle(new Request(`${BASE}/files`, { headers: { cookie } }))).status).toBe(
      401,
    );
    const bearer = `Bearer ${cookie.slice(cookie.indexOf("=") + 1)}`;
    const files = await app.handle(
      new Request(`${BASE}/files`, { headers: { authorization: bearer } }),
    );
    expect(await files.json()).toEqual({ owner: "ada@example.com" });
  });

  it("renews the session cookie on the page's answer, and passes core's one clear line at the sign-out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { app, sent } = setup();
      const json = { "content-type": "application/json", origin: BASE };
      const post = (path: string, body: unknown, cookie = "") =>
        app.handle(
          new Request(`${BASE}${path}`, {
            method: "POST",
            headers: { ...json, cookie },
            body: JSON.stringify(body),
          }),
        );
      await post("/auth/magic-link/request", { email: "ada@example.com" });
      const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
      const verified = await post("/auth/magic-link/verify", { token });
      const cookie = verified.headers.getSetCookie()[0]?.split(";")[0] ?? "";
      // Past the sliding refresh: the gate renews the session, and the page's answer carries the cookie.
      vi.setSystemTime(Date.now() + 8 * 86_400_000);
      const page = await app.handle(new Request(`${BASE}/account`, { headers: { cookie } }));
      expect(page.status).toBe(200);
      const lines = page.headers.getSetCookie();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.startsWith("__Host-tempo_session=ts_")).toBe(true);
      const out = await post("/auth/sign-out", {}, cookie);
      expect(out.headers.getSetCookie()).toHaveLength(1);
      expect(out.headers.getSetCookie()[0]).toContain("Max-Age=0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a person with no session on /account to the sign-in page, and runs no page", async () => {
    const { app, pages } = setup();
    const res = await app.handle(new Request(`${BASE}/account?tab=keys`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount%3Ftab%3Dkeys`);
    expect(pages).toEqual([]);
  });

  // Elysia matches the raw path with case: "/%61ccount" and "/ACCOUNT" match no route (404).
  // It runs "/account" for "/account/", and the gate tests the path with the slash cut (307).
  it.each([
    ["/%61ccount", 404],
    ["/ACCOUNT", 404],
    ["/account/", 307],
    // Elysia removes one trailing slash only.
    ["/account//", 404],
    // Bun and the URL parser resolve dot segments before the router: "/account/." is "/account/".
    ["/account/.", 307],
    ["/account/..", 404],
    ["/auth/../account", 307],
  ])(
    "answers %s with no cookie under an exact rule with %i, and runs no page",
    async (path, status) => {
      const { app, pages } = setup();
      const res = await app.handle(new Request(`${BASE}${path}`));
      expect(res.status).toBe(status);
      expect(pages).toEqual([]);
    },
  );

  it("answers /%61uth/session with 404: no route of core and no page runs, and the rule gets no text", async () => {
    const { app, rule, pages } = setup();
    const res = await app.handle(new Request(`${BASE}/%61uth/session`));
    expect([307, 401, 404]).toContain(res.status);
    expect(res.status).toBe(404);
    expect(pages).toEqual([]);
    expect(rule).toEqual([]);
  });

  it("gives the rule the path as the router matched it, and the path with its trailing slashes removed", async () => {
    const { app, rule } = setup();
    await app.handle(new Request(`${BASE}/account/`));
    expect(rule).toEqual(["/account/", "/account"]);
  });

  it("gives no 500 for a Host header that does not parse", async () => {
    const { app } = setup();
    const page = await app.handle(new Request(`${BASE}/account`, { headers: { host: "a b" } }));
    expect(page.status).toBe(307);
    const core = await app.handle(
      new Request(`${BASE}/auth/session`, { headers: { host: "a b" } }),
    );
    expect(core.status).toBe(401);
  });
});
