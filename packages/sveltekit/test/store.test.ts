import { type Client, createClient } from "@authtempo/client";
import { createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { derived, get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { authError, sessionStore } from "../src/store.js";

// This file runs in the "browser" project of vitest.config.ts: a DOM with a window.
const API = "https://api.example.com";
const APP = "https://app.example.com";

/** `gate` holds every read of core until it settles. */
function setup(gate: Promise<void> = Promise.resolve()) {
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
    await gate;
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

  it("stops listening at an unsubscribe while a session read runs", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    // The first read waits until the test lets it go, so the unsubscribe falls inside it.
    const { client: base } = setup(gate);
    let live = 0;
    const client: Client = {
      ...base,
      store: {
        ...base.store,
        subscribe(listener) {
          live++;
          const stop = base.store.subscribe(listener);
          return () => {
            live--;
            stop();
          };
        },
      },
    };
    const seen: boolean[] = [];
    const stop = sessionStore(client).subscribe((s) => seen.push(s.isPending));
    expect(seen).toEqual([true]);
    stop();
    expect(live).toBe(0);
    release();
    await vi.waitFor(() => expect(base.store.get().isPending).toBe(false));
    expect(seen).toEqual([true]);
  });

  it("gives the refetch of the client store, and a refetch reads the session again", async () => {
    const { client, token } = setup();
    const session = sessionStore(client);
    expect(session.refetch).toBe(client.store.refetch);
    const stop = session.subscribe(() => {});
    await vi.waitFor(() => expect(get(session).isPending).toBe(false));
    await client.magicLink.request({ email: "ada@example.com" });
    await client.magicLink.verify({ token: token() });
    await session.refetch();
    expect(get(session).data?.user.email).toBe("ada@example.com");
    stop();
  });

  it("reads the redirect error of a URL", () => {
    const { client } = setup();
    expect(authError(client, "https://app.example.com/?auth_error=oauth_denied")).toBe(
      "oauth_denied",
    );
    expect(authError(client, "https://app.example.com/home")).toBeNull();
  });
});
