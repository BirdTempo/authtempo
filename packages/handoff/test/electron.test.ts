import { describe, expect, it } from "vitest";
import { createTokenStore, electronOpener, TokenStoreError } from "../src/electron.js";

type Listener = (event: unknown, url: string) => void;

function fakeApp() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    on(_e: "open-url", l: Listener) {
      listeners.add(l);
    },
    removeListener(_e: "open-url", l: Listener) {
      listeners.delete(l);
    },
    emit(url: string) {
      for (const l of listeners) l({}, url);
    },
  };
}

describe("electronOpener", () => {
  it("opens the start URL externally and resolves on the open-url event for the redirect", async () => {
    const app = fakeApp();
    const opened: string[] = [];
    const opener = electronOpener({
      shell: { openExternal: async (u) => void opened.push(u) },
      app,
    });
    const p = opener.open("https://api/start", "consumera://auth");
    expect(opened).toEqual(["https://api/start"]);
    app.emit("consumera://other?code=1");
    app.emit("consumera://auth?code=hc_1");
    expect(await p).toBe("consumera://auth?code=hc_1");
    expect(app.listeners.size).toBe(0);
  });
  it("resolves through receive() for a second-instance argument", async () => {
    const app = fakeApp();
    const opener = electronOpener({ shell: { openExternal: async () => {} }, app });
    const p = opener.open("https://api/start", "consumera://auth");
    opener.receive("consumera://auth?code=hc_2");
    expect(await p).toBe("consumera://auth?code=hc_2");
  });
  it("ignores a URL while nothing is pending, and a second open cancels the first (Review Focus 5)", async () => {
    const app = fakeApp();
    const opener = electronOpener({ shell: { openExternal: async () => {} }, app });
    expect(() => opener.receive("consumera://auth?code=stale")).not.toThrow();
    app.emit("consumera://auth?code=stale");
    const first = opener.open("https://api/start", "consumera://auth");
    const second = opener.open("https://api/start", "consumera://auth");
    expect(await first).toBeNull();
    app.emit("consumera://auth?code=hc_3");
    expect(await second).toBe("consumera://auth?code=hc_3");
  });
  it("resolves null at the timeout", async () => {
    const app = fakeApp();
    const opener = electronOpener({ shell: { openExternal: async () => {} }, app, timeoutMs: 20 });
    expect(await opener.open("https://api/start", "consumera://auth")).toBeNull();
    expect(app.listeners.size).toBe(0);
  });
});

describe("createTokenStore", () => {
  function fakeSafeStorage(available = true) {
    return {
      isEncryptionAvailable: () => available,
      encryptString: (s: string) => new TextEncoder().encode(`enc:${s}`),
      decryptString: (b: Uint8Array) => new TextDecoder().decode(b).replace(/^enc:/, ""),
    };
  }
  function fakeFile() {
    let bytes: Uint8Array | null = null;
    return {
      read: async () => bytes,
      write: async (b: Uint8Array) => {
        bytes = b;
      },
      remove: async () => {
        bytes = null;
      },
      current: () => bytes,
    };
  }
  it("stores the token encrypted and reads it back; clear removes it", async () => {
    const file = fakeFile();
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), ...file });
    expect(await store.get()).toBeNull();
    await store.set("ts_secret");
    expect(new TextDecoder().decode(file.current() ?? new Uint8Array())).toBe("enc:ts_secret");
    expect(await store.get()).toBe("ts_secret");
    await store.clear();
    expect(await store.get()).toBeNull();
  });
  it("refuses to write when encryption is unavailable, and never writes plaintext", async () => {
    const file = fakeFile();
    const store = createTokenStore({ safeStorage: fakeSafeStorage(false), ...file });
    await expect(store.set("ts_secret")).rejects.toBeInstanceOf(TokenStoreError);
    expect(file.current()).toBeNull();
  });
  it("answers null and removes the file when the bytes do not decrypt", async () => {
    const file = fakeFile();
    await file.write(new TextEncoder().encode("garbage"));
    const store = createTokenStore({
      safeStorage: {
        ...fakeSafeStorage(),
        decryptString: () => {
          throw new Error("bad");
        },
      },
      ...file,
    });
    expect(await store.get()).toBeNull();
    expect(file.current()).toBeNull();
  });
});
