import { createClient } from "@authtempo/client";
import { createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { AuthProvider } from "@authtempo/solid";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";

const API = "https://api.example.com";
const APP = "https://app.example.com";

describe("the Solid example (plan 11d2)", () => {
  it("shows the person after a sign-in with the app's client", async () => {
    const mail: MailMessage[] = [];
    const auth = createAuth({
      baseURL: API,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP],
      storage: createMemoryAdapter(),
      mail: {
        send: async (m) => {
          mail.push(m);
        },
      },
    });
    // The browser: the app's Origin and one cookie jar, to core in process.
    let cookie = "";
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const headers = new Headers(req.headers);
      headers.set("origin", APP);
      if (cookie) headers.set("cookie", cookie);
      const res = await auth.handle(new Request(req, { headers }));
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.includes("Max-Age=0") ? "" : (set.split(";")[0] ?? "");
      return res;
    }) as typeof globalThis.fetch;
    const client = createClient({ baseURL: API, fetch });
    const el = document.createElement("div");
    const dispose = render(
      () =>
        createComponent(AuthProvider, {
          client,
          get children() {
            return createComponent(App, {});
          },
        }),
      el,
    );
    await vi.waitFor(() => expect(el.textContent).toBe("Signed out"));
    await client.magicLink.request({ email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
    await client.magicLink.verify({ token });
    await vi.waitFor(() => expect(el.textContent).toBe("Signed in as ada@example.com"));
    dispose();
  });
});
