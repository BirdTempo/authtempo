import { createClient, errorText } from "@authtempo/client";
import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { DEFAULT_COOKIE_NAME } from "@authtempo/core/credentials";
import { authRouteHandlers } from "@authtempo/next";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Providers } from "../app/providers";
import SignIn from "../app/sign-in/page";

const BASE = "http://localhost:3000";
const DAY = 86_400_000;

/** Core on a fake clock, and a browser fetch to its route handlers with one cookie jar. */
function app() {
  const mail: MailMessage[] = [];
  let now = new Date("2026-01-01T00:00:00.000Z");
  const auth: Auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [BASE],
    storage: createMemoryAdapter(),
    mail: {
      async send(m) {
        mail.push(m);
      },
    },
    clock: { now: () => now },
  });
  const { GET, POST } = authRouteHandlers(auth);
  let cookie = "";
  const sessionReads: { renewed: boolean }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set("origin", BASE);
    if (cookie) headers.set("cookie", cookie);
    const res = await (req.method === "GET" ? GET : POST)(new Request(req, { headers }));
    const set = res.headers.get("set-cookie");
    if (new URL(req.url).pathname === "/auth/session")
      sessionReads.push({ renewed: set?.startsWith(`${DEFAULT_COOKIE_NAME}=ts_`) ?? false });
    if (set) cookie = set.includes("Max-Age=0") ? "" : (set.split(";")[0] ?? "");
    return res;
  }) as typeof globalThis.fetch;
  return {
    fetch,
    mail,
    sessionReads,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

function mount(node: ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  root.render(node);
  return { el, unmount: () => root.unmount() };
}

describe("the Next example in the browser (plan 11d final review)", () => {
  it("reads GET /auth/session from the layout on every page, so the browser gets the renewed cookie", async () => {
    const a = app();
    const signIn = createClient({ baseURL: BASE, fetch: a.fetch, broadcast: false });
    await signIn.magicLink.request({ email: "ada@example.com" });
    const token = /token=([A-Za-z0-9_-]+)/.exec(a.mail.at(-1)?.text ?? "")?.[1] ?? "";
    expect((await signIn.magicLink.verify({ token })).ok).toBe(true);
    // Eight days on, the server pages read with no write; the browser's read takes the refresh.
    a.advance(8 * DAY);
    const page = createClient({ baseURL: BASE, fetch: a.fetch, broadcast: false });
    const view = mount(
      <Providers client={page}>
        <p>home</p>
      </Providers>,
    );
    await vi.waitFor(() => expect(a.sessionReads).toEqual([{ renewed: true }]));
    view.unmount();
  });

  it("shows the text of the redirect error on the sign-in page", async () => {
    const a = app();
    history.replaceState(null, "", "/sign-in?auth_error=oauth_denied");
    const client = createClient({ baseURL: BASE, fetch: a.fetch, broadcast: false });
    const view = mount(
      <Providers client={client}>
        <SignIn />
      </Providers>,
    );
    try {
      await vi.waitFor(() =>
        expect(view.el.querySelector('[role="alert"]')?.textContent).toBe(
          errorText("oauth_denied"),
        ),
      );
    } finally {
      history.replaceState(null, "", "/");
      view.unmount();
    }
  });
});
