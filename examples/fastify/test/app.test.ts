import type { AddressInfo } from "node:net";
import { createClient } from "@authtempo/client";
import type { MailMessage } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("the Fastify example (plan 11d2)", () => {
  it("signs a person in with the client over HTTP, and protects /account", async () => {
    const sent: MailMessage[] = [];
    let base = "";
    const app = await createApp({
      baseURL: () => base,
      AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      mail: {
        async send(m) {
          sent.push(m);
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      let cookie = "";
      const jarFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("origin", base);
        if (cookie) headers.set("cookie", cookie);
        const res = await fetch(input, { ...init, headers });
        // The session line by its name: core may send a second line.
        const line = res.headers.getSetCookie().find((l) => l.startsWith("__Host-tempo_session="));
        if (line) cookie = line.includes("Max-Age=0") ? "" : (line.split(";")[0] ?? "");
        return res;
      }) as typeof globalThis.fetch;
      const client = createClient({ baseURL: base, fetch: jarFetch, credentials: "omit" });
      const away = await fetch(`${base}/account`, { redirect: "manual" });
      expect(away.status).toBe(307);
      expect(away.headers.get("location")).toBe(`${base}/sign-in?next=%2Faccount`);
      expect((await client.magicLink.request({ email: "ada@example.com" })).ok).toBe(true);
      const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
      expect((await client.magicLink.verify({ token })).ok).toBe(true);
      expect(cookie.startsWith("__Host-tempo_session=ts_")).toBe(true);
      const account = await fetch(`${base}/account`, { headers: { cookie } });
      expect(await account.json()).toEqual({ email: "ada@example.com" });
    } finally {
      await app.close();
    }
  });
});
