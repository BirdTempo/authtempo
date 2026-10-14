import { createClient } from "@authtempo/client";
import type { MailMessage } from "@authtempo/core";
import { authRouteHandlers, authSession } from "@authtempo/next";
import { describe, expect, it } from "vitest";
import { createAppAuth } from "../lib/auth";
import { proxy } from "../proxy";

const BASE = "http://localhost:3000";

describe("the Next.js example (plan 11d)", () => {
  it("signs a person in through the route handlers, and the server component reads the session", async () => {
    const sent: MailMessage[] = [];
    const auth = createAppAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      mail: {
        async send(m) {
          sent.push(m);
        },
      },
    });
    const { GET, POST } = authRouteHandlers(auth);
    // The browser: same origin, one cookie jar, through the app's route handlers.
    let cookie = "";
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const headers = new Headers(req.headers);
      headers.set("origin", BASE);
      if (cookie) headers.set("cookie", cookie);
      const res = await (req.method === "GET" ? GET : POST)(new Request(req, { headers }));
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.includes("Max-Age=0") ? "" : (set.split(";")[0] ?? "");
      return res;
    }) as typeof globalThis.fetch;
    const client = createClient({ baseURL: BASE, fetch });
    expect(
      (await client.magicLink.request({ email: "ada@example.com", next: "/account" })).ok,
    ).toBe(true);
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect((await client.magicLink.verify({ token })).ok).toBe(true);
    const session = await authSession(auth, new Headers({ cookie }));
    expect(session?.user.email).toBe("ada@example.com");
    // The proxy lets the request with the cookie go on, and sends one without it to the sign-in page.
    expect(await proxy(new Request(`${BASE}/account`, { headers: { cookie } }))).toBeUndefined();
    const away = await proxy(new Request(`${BASE}/account`));
    expect(away?.headers.get("location")).toBe(`${BASE}/sign-in?next=%2Faccount`);
  });
});
