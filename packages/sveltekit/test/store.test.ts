import { createClient } from "@authtempo/client";
import { createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { derived, get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { authError, sessionStore } from "../src/store.js";

// This file runs in the "browser" project of vitest.config.ts: a DOM with a window.
const API = "https://api.example.com";
const APP = "https://app.example.com";

function setup() {
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
  // A test has no other tabs and no page visibility.
  const client = createClient({ baseURL: API, fetch, broadcast: false, refetchOnVisible: false });
  const token = () => /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
  return { client, token };
}

describe("@authtempo/sveltekit/store (plan 11d2)", () => {
  it("keeps the store contract of Svelte: get reads the value at once", () => {
    const { client } = setup();
    expect(get(sessionStore(client)).isPending).toBe(true);
  });

  it("follows the session through a sign-in and a sign-out, also through derived", async () => {
    const { client, token } = setup();
    const session = sessionStore(client);
    const email = derived(session, (s) => s.data?.user.email ?? null);
    const seen: (string | null)[] = [];
    const stop = email.subscribe((e) => seen.push(e));
    await vi.waitFor(() => expect(get(session).isPending).toBe(false));
    await client.magicLink.request({ email: "ada@example.com" });
    await client.magicLink.verify({ token: token() });
    await vi.waitFor(() => expect(seen.at(-1)).toBe("ada@example.com"));
    await client.signOut();
    await vi.waitFor(() => expect(seen.at(-1)).toBeNull());
    stop();
  });

  it("stops listening at the unsubscribe", async () => {
    const { client } = setup();
    let runs = 0;
    const stop = sessionStore(client).subscribe(() => {
      runs++;
    });
    await vi.waitFor(() => expect(client.store.get().isPending).toBe(false));
    const before = runs;
    stop();
    await client.store.refetch();
    expect(runs).toBe(before);
  });

  it("reads the redirect error of a URL", () => {
    const { client } = setup();
    expect(authError(client, "https://app.example.com/?auth_error=oauth_denied")).toBe(
      "oauth_denied",
    );
    expect(authError(client, "https://app.example.com/home")).toBeNull();
  });
});
