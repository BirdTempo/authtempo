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
