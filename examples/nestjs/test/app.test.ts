import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "@authtempo/client";
import type { MailMessage } from "@authtempo/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const sent: MailMessage[] = [];
let rule: string[] = [];
let pages: string[] = [];
let base = "";
let app: INestApplication;

/** One request with a raw path and a raw Host header, as a browser or a script sends it. */
function send(path: string, headers: Record<string, string> = {}) {
  const { port } = new URL(base);
  return new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the NestJS example (plan 11d2)", () => {
  beforeAll(async () => {
    app = await createApp({
      baseURL: () => base,
      AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      mail: {
        async send(m) {
          sent.push(m);
        },
      },
      trace: (event, text) => (event === "rule" ? rule : pages).push(text),
    });
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("mounts core with the Express binding, and a guard verifies the caller of /files", async () => {
    let cookie = "";
    let lines: string[] = [];
    const jarFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", base);
      if (cookie) headers.set("cookie", cookie);
      const res = await fetch(input, { ...init, headers });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.includes("Max-Age=0") ? "" : (set.split(";")[0] ?? "");
      lines = res.headers.getSetCookie();
      return res;
    }) as typeof globalThis.fetch;
    const client = createClient({ baseURL: base, fetch: jarFetch, credentials: "omit" });
    expect((await fetch(`${base}/files`)).status).toBe(401);
    // A POST to core: core runs before Nest's body parsers and reads the raw body.
    expect((await client.magicLink.request({ email: "ada@example.com" })).ok).toBe(true);
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect((await client.magicLink.verify({ token })).ok).toBe(true);
    // The Set-Cookie line of core passes unchanged: one line, the session cookie.
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("__Host-tempo_session=ts_")).toBe(true);
    const account = await fetch(`${base}/account`, { headers: { cookie } });
    expect(await account.json()).toEqual({ email: "ada@example.com" });
    // The verifier reads the Authorization header only: the cookie is no credential at /files.
    expect((await fetch(`${base}/files`, { headers: { cookie } })).status).toBe(401);
    const bearer = `Bearer ${cookie.slice(cookie.indexOf("=") + 1)}`;
    const files = await fetch(`${base}/files`, { headers: { authorization: bearer } });
    expect(await files.json()).toEqual({ owner: "ada@example.com" });
  });

  it("sends a person with no session on /account to the sign-in page, and runs no page", async () => {
    pages = [];
    const res = await send("/account?tab=keys");
    expect(res.status).toBe(307);
    expect(res.location).toBe(`${base}/sign-in?next=%2Faccount%3Ftab%3Dkeys`);
    expect(pages).toEqual([]);
  });

  // Express matches the raw path: "/%61ccount" matches no route (404). It matches
  // without case and with a trailing slash, and the middleware tests those forms (307).
  it.each([
    ["/%61ccount", 404],
    ["/ACCOUNT", 307],
    ["/account/", 307],
    // The middleware removes every trailing slash, so it fails closed for "/account//".
    ["/account//", 307],
    // Node and Express do not resolve dot segments: no route matches.
    ["/account/.", 404],
    ["/account/..", 404],
  ])(
    "answers %s with no cookie under an exact rule with %i, and runs no page",
    async (path, status) => {
      pages = [];
      const res = await send(path);
      expect(res.status).toBe(status);
      expect(pages).toEqual([]);
    },
  );

  it("answers /%61uth/session with 404, and the rule gets only the text the router matched", async () => {
    pages = [];
    rule = [];
    const res = await send("/%61uth/session");
    expect([307, 401, 404]).toContain(res.status);
    expect(res.status).toBe(404);
    expect(pages).toEqual([]);
    expect(rule.length).toBeGreaterThan(0);
    // The raw path and its case forms: never the decoded "/auth/session".
    expect(new Set(rule)).toEqual(new Set(["/%61uth/session"]));
  });

  it("gives no 500 for a Host header that does not parse: the origin of baseURL", async () => {
    const page = await send("/account", { host: "a b" });
    expect(page.status).toBe(307);
    expect(page.location).toBe(`${base}/sign-in?next=%2Faccount`);
    expect((await send("/auth/session", { host: "a b" })).status).toBe(401);
    expect((await send("/files", { host: "a b" })).status).toBe(401);
  });

  it("takes the origin of the redirect from Host, not from an absolute-form request line", async () => {
    const res = await send("http://evil.example/account");
    expect(res.status).toBe(307);
    expect(res.location).toBe(`${base}/sign-in?next=%2Faccount`);
  });
});

describe("the NestJS example with a rule that has a capital letter (plan 11d2)", () => {
  it("runs no page of /myAccount for /myaccount or /MYACCOUNT: the router compares case", async () => {
    const runs: string[] = [];
    const caseApp = await createApp({
      baseURL: () => base,
      AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      mail: { async send() {} },
      protect: (p) => p.startsWith("/myAccount"),
    });
    // A route of the app at /myAccount, on the same Express instance.
    caseApp
      .getHttpAdapter()
      .get("/myAccount", (req: { path: string }, res: { json: (v: unknown) => void }) => {
        runs.push(req.path);
        res.json({ page: "myAccount" });
      });
    await caseApp.listen(0, "127.0.0.1");
    const port = (caseApp.getHttpServer().address() as AddressInfo).port;
    try {
      for (const path of ["/myaccount", "/MYACCOUNT"]) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
        expect(res.status, path).toBe(404);
      }
      expect(runs).toEqual([]);
      // The route itself is protected: no session gives the redirect.
      const own = await fetch(`http://127.0.0.1:${port}/myAccount`, { redirect: "manual" });
      expect(own.status).toBe(307);
      expect(runs).toEqual([]);
    } finally {
      await caseApp.close();
    }
  });
});
