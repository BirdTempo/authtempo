import { describe, expect, it, vi } from "vitest";
import { createTokenStore, type TokenCipher } from "../src/electron.js";
import { createHandoff } from "../src/handoff.js";
import { createNativeClient } from "../src/native-client.js";
import type { TokenStore } from "../src/token-store.js";
import { BASE_URL, makeServer, scriptedOpener } from "./harness.js";

const REDIRECT = "consumera://auth";

function memoryStore(): TokenStore & { value: () => string | null } {
  let token: string | null = null;
  return {
    get: async () => token,
    set: async (t) => {
      token = t;
    },
    clear: async () => {
      token = null;
    },
    value: () => token,
  };
}

function native(server: ReturnType<typeof makeServer>, store: TokenStore) {
  const handoff = createHandoff({
    baseURL: BASE_URL,
    redirect: REDIRECT,
    opener: scriptedOpener(server),
    fetch: server.fetch,
  });
  return createNativeClient({ baseURL: BASE_URL, handoff, store, fetch: server.fetch });
}

describe("createNativeClient (plan 11d)", () => {
  it("signs in through the browser, keeps the token, and the session store reads it", async () => {
    const server = makeServer();
    const store = memoryStore();
    const app = native(server, store);
    const stop = app.store.subscribe(() => {});
    await vi.waitFor(() => expect(app.store.get().isPending).toBe(false));
    const r = await app.signInWithBrowser();
    expect(r.ok && r.value.user.email).toBe("ada@example.com");
    expect(store.value()).toMatch(/^ts_/);
    await vi.waitFor(() => expect(app.store.get().data?.user.email).toBe("ada@example.com"));
    stop();
  });

  it("clears the token when the session answers null", async () => {
    const server = makeServer();
    const store = memoryStore();
    const app = native(server, store);
    await app.signInWithBrowser();
    // The server ends every session: each row goes by its id.
    for (const row of await server.storage.findMany("session", []))
      await server.storage.delete("session", [{ field: "id", op: "eq", value: row.id }]);
    expect(await app.session()).toEqual({ ok: true, value: null });
    expect(store.value()).toBeNull();
  });

  it("clears the token at the sign-out", async () => {
    const server = makeServer();
    const store = memoryStore();
    const app = native(server, store);
    await app.signInWithBrowser();
    expect(await app.signOut()).toEqual({ ok: true, value: { ok: true } });
    expect(store.value()).toBeNull();
  });

  it("answers unexpected, never a throw, when the store cannot write", async () => {
    const server = makeServer();
    const store: TokenStore = {
      get: async () => null,
      set: async () => {
        throw new Error("no keychain");
      },
      clear: async () => {},
    };
    expect(await native(server, store).signInWithBrowser()).toEqual({
      ok: false,
      code: "unexpected",
      status: 0,
    });
  });

  it("passes a cancelled handoff through and writes nothing", async () => {
    const server = makeServer();
    const store = memoryStore();
    const handoff = createHandoff({
      baseURL: BASE_URL,
      redirect: REDIRECT,
      opener: { open: async () => null },
      fetch: server.fetch,
    });
    const app = createNativeClient({ baseURL: BASE_URL, handoff, store, fetch: server.fetch });
    expect(await app.signInWithBrowser()).toEqual({ ok: false, code: "cancelled", status: 0 });
    expect(store.value()).toBeNull();
  });

  it("sends the stored token as the bearer and no cookie, and no token when the store read throws", async () => {
    const server = makeServer();
    const sent: { credentials: RequestCredentials; authorization: string | null }[] = [];
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname.endsWith("/session"))
        sent.push({
          credentials: req.credentials,
          authorization: req.headers.get("authorization"),
        });
      return server.fetch(req);
    }) as typeof fetch;
    const store = memoryStore();
    const handoff = createHandoff({
      baseURL: BASE_URL,
      redirect: REDIRECT,
      opener: scriptedOpener(server),
      fetch: server.fetch,
    });
    const app = createNativeClient({ baseURL: BASE_URL, handoff, store, fetch: recording });
    await app.signInWithBrowser();
    const live = await app.session();
    expect(live.ok && live.value?.user.email).toBe("ada@example.com");
    expect(sent[0]).toEqual({ credentials: "omit", authorization: `Bearer ${store.value()}` });
    const broken = createNativeClient({
      baseURL: BASE_URL,
      handoff,
      fetch: recording,
      store: {
        get: async () => {
          throw new Error("the keychain is locked");
        },
        set: async () => {},
        clear: async () => {},
      },
    });
    expect(await broken.session()).toEqual({ ok: true, value: null });
    expect(sent[1]?.authorization).toBeNull();
  });

  it("works with the Electron token store", async () => {
    const server = makeServer();
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const cipher: TokenCipher = {
      available: () => true,
      encrypt: async (plain) => enc.encode(`enc:${plain}`),
      decrypt: async (bytes) => ({ plain: dec.decode(bytes).slice(4), reEncrypt: false }),
    };
    let bytes: Uint8Array | null = null;
    const store = createTokenStore({
      cipher,
      read: async () => bytes,
      write: async (b) => {
        bytes = b;
      },
      remove: async () => {
        bytes = null;
      },
    });
    const app = native(server, store);
    await app.signInWithBrowser();
    expect(dec.decode(bytes ?? new Uint8Array()).startsWith("enc:ts_")).toBe(true);
    const s = await app.session();
    expect(s.ok && s.value?.user.email).toBe("ada@example.com");
  });
});

/** A memory store that counts its clears. */
function countingStore() {
  const store = memoryStore();
  let clears = 0;
  return {
    store: {
      ...store,
      clear: async () => {
        clears++;
        await store.clear();
      },
    } satisfies TokenStore,
    value: store.value,
    clears: () => clears,
  };
}

/** The server's fetch, where a test can hold the /session answers or answer the sign-out itself. */
function controlledFetch(server: ReturnType<typeof makeServer>) {
  let gate: Promise<void> | null = null;
  let release = () => {};
  let signOut: (() => Promise<Response>) | null = null;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    if (path.endsWith("/sign-out") && signOut) return signOut();
    const res = await server.fetch(req);
    if (path.endsWith("/session") && gate) await gate;
    return res;
  }) as typeof globalThis.fetch;
  return {
    fetch,
    hold() {
      gate = new Promise<void>((r) => {
        release = r;
      });
    },
    release() {
      gate = null;
      release();
    },
    answerSignOut(f: () => Promise<Response>) {
      signOut = f;
    },
  };
}

function nativeOver(
  server: ReturnType<typeof makeServer>,
  store: TokenStore,
  fetch: typeof globalThis.fetch,
) {
  const handoff = createHandoff({
    baseURL: BASE_URL,
    redirect: REDIRECT,
    opener: scriptedOpener(server),
    fetch: server.fetch,
  });
  return createNativeClient({ baseURL: BASE_URL, handoff, store, fetch });
}

describe("createNativeClient fix round (plan 11d Task 12 review)", () => {
  it("keeps the new token when a late 401 of the old token comes after a new sign-in (J1)", async () => {
    const server = makeServer();
    const counted = countingStore();
    const control = controlledFetch(server);
    const app = nativeOver(server, counted.store, control.fetch);
    const stop = app.store.subscribe(() => {});
    await app.signInWithBrowser();
    await vi.waitFor(() => expect(app.store.get().data?.user.email).toBe("ada@example.com"));
    const old = counted.value();
    // The server ends the old session; a read with the old token is held on its way back.
    for (const row of await server.storage.findMany("session", []))
      await server.storage.delete("session", [{ field: "id", op: "eq", value: row.id }]);
    control.hold();
    void app.store.refetch();
    await new Promise((r) => setTimeout(r, 10));
    const again = await app.signInWithBrowser();
    if (!again.ok) throw new Error(again.code);
    expect(counted.value()).not.toBe(old);
    control.release();
    await vi.waitFor(() => expect(app.store.get().isRefetching).toBe(false));
    await vi.waitFor(() => expect(app.store.get().data?.user.email).toBe("ada@example.com"));
    expect(counted.value()).toBe(again.value.token);
    expect(counted.clears()).toBe(0);
    stop();
  });

  it("clears the token exactly once at a sign-out with a subscribed store (J1)", async () => {
    const server = makeServer();
    const counted = countingStore();
    const app = nativeOver(server, counted.store, server.fetch);
    const stop = app.store.subscribe(() => {});
    await app.signInWithBrowser();
    await vi.waitFor(() => expect(app.store.get().data?.user.email).toBe("ada@example.com"));
    await app.signOut();
    await vi.waitFor(() => expect(app.store.get().data).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(counted.value()).toBeNull();
    expect(counted.clears()).toBe(1);
    stop();
  });

  it("answers unexpected, never a throw, when the opener throws (M1)", async () => {
    const server = makeServer();
    const store = memoryStore();
    const handoff = createHandoff({
      baseURL: BASE_URL,
      redirect: REDIRECT,
      opener: {
        open: async () => {
          throw new Error("the browser session failed");
        },
      },
      fetch: server.fetch,
    });
    const app = createNativeClient({ baseURL: BASE_URL, handoff, store, fetch: server.fetch });
    expect(await app.signInWithBrowser()).toEqual({ ok: false, code: "unexpected", status: 0 });
    expect(store.value()).toBeNull();
  });

  it("keeps the token when the sign-out does not reach the server, and clears it on a 401 (M2)", async () => {
    for (const [answer, kept] of [
      [async () => Promise.reject(new TypeError("offline")), true],
      [async () => Response.json({ error: "unauthorized" }, { status: 401 }), false],
    ] as const) {
      const server = makeServer();
      const store = memoryStore();
      const control = controlledFetch(server);
      const app = nativeOver(server, store, control.fetch);
      await app.signInWithBrowser();
      const token = store.value();
      control.answerSignOut(answer);
      await app.signOut();
      expect(store.value()).toBe(kept ? token : null);
    }
  });

  it("signs the new session out when the store cannot keep its token (L1)", async () => {
    const server = makeServer();
    let redeemed = "";
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const res = await server.fetch(req);
      if (new URL(req.url).pathname.endsWith("/handoff/redeem"))
        redeemed = ((await res.clone().json()) as { token?: string }).token ?? "";
      return res;
    }) as typeof globalThis.fetch;
    const handoff = createHandoff({
      baseURL: BASE_URL,
      redirect: REDIRECT,
      opener: scriptedOpener(server),
      fetch: recording,
    });
    const store: TokenStore = {
      get: async () => null,
      set: async () => {
        throw new Error("no keychain");
      },
      clear: async () => {},
    };
    const app = createNativeClient({ baseURL: BASE_URL, handoff, store, fetch: server.fetch });
    expect(await app.signInWithBrowser()).toEqual({ ok: false, code: "unexpected", status: 0 });
    expect(redeemed).toMatch(/^ts_/);
    const probe = createNativeClient({
      baseURL: BASE_URL,
      handoff,
      fetch: server.fetch,
      store: { get: async () => redeemed, set: async () => {}, clear: async () => {} },
    });
    expect(await probe.session()).toEqual({ ok: true, value: null });
  });
});
