import type { AddressInfo } from "node:net";
import { createClient } from "@authtempo/client";
import type { MailMessage } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("the Express example (plan 11d2)", () => {
  it("signs a person in with the client over HTTP, and protects /account", async () => {
    const sent: MailMessage[] = [];
    let base = "";
    const app = createApp({
      baseURL: () => base,
      AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      mail: {
        async send(m) {
          sent.push(m);
        },
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      let cookie = "";
      const jarFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("origin", base);
        if (cookie) headers.set("cookie", cookie);
        const res = await fetch(input, { ...init, headers });
        const set = res.headers.get("set-cookie");
        if (set) cookie = set.includes("Max-Age=0") ? "" : (set.split(";")[0] ?? "");
        return res;
      }) as typeof globalThis.fetch;
      const client = createClient({ baseURL: base, fetch: jarFetch, credentials: "omit" });
      const away = await fetch(`${base}/account`, { redirect: "manual" });
      expect(away.headers.get("location")).toBe(`${base}/sign-in?next=%2Faccount`);
      expect((await client.magicLink.request({ email: "ada@example.com" })).ok).toBe(true);
      const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
      expect((await client.magicLink.verify({ token })).ok).toBe(true);
      const account = await fetch(`${base}/account`, { headers: { cookie } });
      expect(await account.json()).toEqual({ email: "ada@example.com" });
    } finally {
      server.close();
    }
  });
});
