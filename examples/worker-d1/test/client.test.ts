import { env } from "cloudflare:test";
import { createClient } from "@authtempo/client";
import type { MailMessage } from "@authtempo/core";
import { expect, it } from "vitest";
import { createWorker } from "../src/index";

const BASE = "https://example.test";

it("signs a person in with @authtempo/client on D1 and reads the session", async () => {
  const sent: MailMessage[] = [];
  const app = createWorker({
    async send(m) {
      sent.push(m);
    },
  });
  // The test plays the browser: it keeps the session cookie between calls.
  let cookie = "";
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("cookie", cookie);
    // Method, headers, and body only: the Request of workerd needs no credentials field.
    const res = await app.fetch(
      new Request(input, {
        method: init?.method ?? "GET",
        headers,
        ...(init?.body !== undefined ? { body: init.body } : {}),
      }),
      env,
    );
    const set = res.headers.get("set-cookie")?.split(";")[0];
    if (set?.includes("=")) cookie = set;
    return res;
  }) as typeof globalThis.fetch;
  // A test of the server side: the cookie rides in the jar above, not in the runtime's own.
  const client = createClient({ baseURL: BASE, fetch, credentials: "omit" });
  expect(await client.session()).toEqual({ ok: true, value: null });
  expect(await client.magicLink.request({ email: "ada@example.com" })).toEqual({
    ok: true,
    value: { sent: true },
  });
  const link = /https:\/\/\S+/.exec(sent.at(-1)?.text ?? "")?.[0] ?? "";
  const verified = await client.magicLink.verify({
    token: new URL(link).searchParams.get("token") ?? "",
  });
  expect(verified.ok && "user" in verified.value && verified.value.user.email).toBe(
    "ada@example.com",
  );
  const s = await client.session();
  expect(s.ok && s.value?.user.email).toBe("ada@example.com");
});
