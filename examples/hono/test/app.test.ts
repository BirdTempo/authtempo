import { createClient } from "@authtempo/client";
import type { MailMessage } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const BASE = "http://localhost:8787";

describe("the Hono example (plan 11d2)", () => {
  it("signs a person in with the client, shows the session, and protects /account", async () => {
    const sent: MailMessage[] = [];
    const app = createApp({
      BASE_URL: BASE,
      AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      mail: {
        async send(m) {
          sent.push(m);
        },
      },
    });
    // The browser: same origin, one cookie jar, through Hono's own request.
    let cookie = "";
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const headers = new Headers(req.headers);
      headers.set("origin", BASE);
      if (cookie) headers.set("cookie", cookie);
      const res = await app.request(new Request(req, { headers }));
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.includes("Max-Age=0") ? "" : (set.split(";")[0] ?? "");
      return res;
    }) as typeof globalThis.fetch;
    const client = createClient({ baseURL: BASE, fetch, credentials: "omit" });
    expect((await app.request(`${BASE}/account`)).headers.get("location")).toBe(
      `${BASE}/sign-in?next=%2Faccount`,
    );
    expect((await client.magicLink.request({ email: "ada@example.com" })).ok).toBe(true);
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect((await client.magicLink.verify({ token })).ok).toBe(true);
    const account = await app.request(`${BASE}/account`, { headers: { cookie } });
    expect(await account.json()).toEqual({ email: "ada@example.com" });
  });
});
