import { createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import type { HandoffOpener } from "../src/handoff.js";

export const BASE_URL = "https://api.example.com";

export function makeServer() {
  const mail: MailMessage[] = [];
  let current = new Date("2026-01-01T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const storage = createMemoryAdapter();
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock,
    handoff: { schemes: ["consumera://"], devRedirectPattern: /^http:\/\/127\.0\.0\.1:\d+\/auth/ },
  });
  /** The app's fetch: in-process, no cookies, as a native app has none. */
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    auth.handle(new Request(input, init))) as typeof globalThis.fetch;
  return { auth, storage, mail, clock, fetch };
}

/**
 * Plays the system browser: opens the start URL, asks for a magic link from
 * the page, verifies it as a form post, follows to the confirm page, presses
 * the button, and returns the location the API redirected to.
 */
export function scriptedOpener(
  server: ReturnType<typeof makeServer>,
  email = "ada@example.com",
): HandoffOpener & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async open(url) {
      opened.push(url);
      const start = await server.auth.handle(new Request(url));
      if (start.status !== 200) return null;
      const cont = /data-continue="([^"]+)"/.exec(await start.text())?.[1];
      if (!cont) throw new Error("no continue path on the page");
      await server.auth.handle(
        new Request(`${BASE_URL}/auth/magic-link/request`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify({ email, next: cont }),
        }),
      );
      const token = /token=([A-Za-z0-9_-]+)/.exec(server.mail.at(-1)?.text ?? "")?.[1] ?? "";
      const verify = await server.auth.handle(
        new Request(`${BASE_URL}/auth/magic-link/verify`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
          body: new URLSearchParams({ token }).toString(),
        }),
      );
      const cookie = verify.headers.get("set-cookie")?.split(";")[0] ?? "";
      const h = /h=([A-Za-z0-9_-]+)/.exec(cont)?.[1] ?? "";
      const pressed = await server.auth.handle(
        new Request(`${BASE_URL}/auth/handoff/continue`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: BASE_URL,
            cookie,
          },
          body: new URLSearchParams({ h }).toString(),
        }),
      );
      return pressed.headers.get("location");
    },
  };
}
