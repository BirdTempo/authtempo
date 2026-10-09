import { describe, expect, it } from "vitest";
import {
  type AsyncSafeStorageLike,
  asyncSafeStorageCipher,
  createTokenStore,
  electronOpener,
  safeStorageCipher,
  type TokenCipher,
  TokenStoreError,
} from "../src/electron.js";

type Listener = (event: unknown, url: string) => void;

function fakeApp() {
  const listeners: Listener[] = [];
  return {
    listeners,
    on(_e: "open-url", l: Listener) {
      listeners.push(l);
    },
    removeListener(_e: "open-url", l: Listener) {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
    emit(url: string) {
      for (const l of [...listeners]) l({}, url);
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
    expect(app.listeners.length).toBe(0);
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
    expect(app.listeners.length).toBe(1);
    app.emit("consumera://auth?code=hc_3");
    expect(await second).toBe("consumera://auth?code=hc_3");
    expect(app.listeners.length).toBe(0);
  });
  it("calls preventDefault on an accepted open-url, and not on a dropped one (M-3)", async () => {
    const app = fakeApp();
    const opener = electronOpener({ shell: { openExternal: async () => {} }, app });
    const p = opener.open("https://api/start", "consumera://auth");
    let prevented = 0;
    const event = { preventDefault: () => void prevented++ };
    app.listeners[0]?.(event, "consumera://other?code=1");
    expect(prevented).toBe(0);
    app.listeners[0]?.(event, "consumera://auth?code=hc_4");
    expect(prevented).toBe(1);
    expect(await p).toBe("consumera://auth?code=hc_4");
  });
  it("resolves null and drops the listener when the browser cannot open", async () => {
    const app = fakeApp();
    const opener = electronOpener({
      shell: {
        openExternal: async () => {
          throw new Error("no browser");
        },
      },
      app,
    });
    expect(await opener.open("https://api/start", "consumera://auth")).toBeNull();
    expect(app.listeners.length).toBe(0);
  });
  it("resolves null at the timeout", async () => {
    const app = fakeApp();
    const opener = electronOpener({ shell: { openExternal: async () => {} }, app, timeoutMs: 20 });
    expect(await opener.open("https://api/start", "consumera://auth")).toBeNull();
    expect(app.listeners.length).toBe(0);
  });
});

describe("createTokenStore", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  function fakeSafeStorage(available = true) {
    return {
      isEncryptionAvailable: () => available,
      encryptString: (s: string) => enc.encode(`enc:${s}`),
      decryptString: (b: Uint8Array) => dec.decode(b).replace(/^enc:/, ""),
    };
  }
  function fakeAsyncSafeStorage(available = true, shouldReEncrypt = false) {
    const calls: string[] = [];
    const storage: AsyncSafeStorageLike = {
      isAsyncEncryptionAvailable: async () => {
        calls.push("available");
        return available;
      },
      encryptStringAsync: async (s) => {
        calls.push("encrypt");
        return enc.encode(`aenc:${s}`);
      },
      decryptStringAsync: async (b) => {
        calls.push("decrypt");
        return { result: dec.decode(b).replace(/^a?enc:/, ""), shouldReEncrypt };
      },
    };
    return { storage, calls };
  }
  function fakeFile() {
    let bytes: Uint8Array | null = null;
    let writes = 0;
    return {
      read: async () => bytes,
      write: async (b: Uint8Array) => {
        writes++;
        bytes = b;
      },
      remove: async () => {
        bytes = null;
      },
      current: () => bytes,
      writes: () => writes,
    };
  }
  it("stores the token encrypted and reads it back; clear removes it", async () => {
    const file = fakeFile();
    const store = createTokenStore({ cipher: safeStorageCipher(fakeSafeStorage()), ...file });
    expect(await store.get()).toBeNull();
    await store.set("ts_secret");
    expect(dec.decode(file.current() ?? new Uint8Array())).toBe("enc:ts_secret");
    expect(await store.get()).toBe("ts_secret");
    await store.clear();
    expect(await store.get()).toBeNull();
  });
  it("refuses to write when encryption is unavailable, and never writes plaintext", async () => {
    const file = fakeFile();
    const store = createTokenStore({ cipher: safeStorageCipher(fakeSafeStorage(false)), ...file });
    await expect(store.set("ts_secret")).rejects.toBeInstanceOf(TokenStoreError);
    expect(file.current()).toBeNull();
  });
  it("refuses to write on the basic_text or unknown backend in both helpers, and writes nothing (I-4)", async () => {
    for (const backend of ["basic_text", "unknown"]) {
      const syncFile = fakeFile();
      const syncStore = createTokenStore({
        cipher: safeStorageCipher({
          ...fakeSafeStorage(),
          getSelectedStorageBackend: () => backend,
        }),
        ...syncFile,
      });
      await expect(syncStore.set("ts_secret")).rejects.toBeInstanceOf(TokenStoreError);
      expect(syncFile.current()).toBeNull();
      const asyncFile = fakeFile();
      const asyncStore = createTokenStore({
        cipher: asyncSafeStorageCipher({
          ...fakeAsyncSafeStorage().storage,
          getSelectedStorageBackend: () => backend,
        }),
        ...asyncFile,
      });
      await expect(asyncStore.set("ts_secret")).rejects.toBeInstanceOf(TokenStoreError);
      expect(asyncFile.current()).toBeNull();
    }
    const file = fakeFile();
    const store = createTokenStore({
      cipher: safeStorageCipher({
        ...fakeSafeStorage(),
        getSelectedStorageBackend: () => "gnome_libsecret",
      }),
      ...file,
    });
    await store.set("ts_secret");
    expect(await store.get()).toBe("ts_secret");
  });
  it("answers null even when removing the unreadable file fails", async () => {
    const file = fakeFile();
    await file.write(enc.encode("garbage"));
    const store = createTokenStore({
      cipher: safeStorageCipher({
        ...fakeSafeStorage(),
        decryptString: () => {
          throw new Error("bad");
        },
      }),
      ...file,
      remove: async () => {
        throw new Error("disk");
      },
    });
    expect(await store.get()).toBeNull();
  });
  it("answers null and removes the file when the bytes do not decrypt", async () => {
    const file = fakeFile();
    await file.write(enc.encode("garbage"));
    const store = createTokenStore({
      cipher: safeStorageCipher({
        ...fakeSafeStorage(),
        decryptString: () => {
          throw new Error("bad");
        },
      }),
      ...file,
    });
    expect(await store.get()).toBeNull();
    expect(file.current()).toBeNull();
  });
  it("the async cipher calls the three async functions", async () => {
    const { storage, calls } = fakeAsyncSafeStorage();
    const file = fakeFile();
    const store = createTokenStore({ cipher: asyncSafeStorageCipher(storage), ...file });
    await store.set("ts_secret");
    expect(calls).toEqual(["available", "encrypt"]);
    expect(dec.decode(file.current() ?? new Uint8Array())).toBe("aenc:ts_secret");
    expect(await store.get()).toBe("ts_secret");
    expect(calls).toEqual(["available", "encrypt", "decrypt"]);
  });
  it("refuses to write when the async cipher is unavailable", async () => {
    const file = fakeFile();
    const store = createTokenStore({
      cipher: asyncSafeStorageCipher(fakeAsyncSafeStorage(false).storage),
      ...file,
    });
    await expect(store.set("ts_secret")).rejects.toBeInstanceOf(TokenStoreError);
    expect(file.writes()).toBe(0);
  });
  it("works with an available() that answers a Promise", async () => {
    const file = fakeFile();
    const cipher: TokenCipher = {
      ...safeStorageCipher(fakeSafeStorage()),
      available: () => Promise.resolve(true),
    };
    const store = createTokenStore({ cipher, ...file });
    await store.set("ts_secret");
    expect(await store.get()).toBe("ts_secret");
    const closed = createTokenStore({
      cipher: { ...cipher, available: async () => false },
      ...file,
    });
    await expect(closed.set("x")).rejects.toBeInstanceOf(TokenStoreError);
  });
  it("writes the token again once when decrypt says reEncrypt, and answers the plain (Review Focus 3)", async () => {
    const { storage } = fakeAsyncSafeStorage(true, true);
    const file = fakeFile();
    await file.write(enc.encode("enc:ts_old"));
    const store = createTokenStore({ cipher: asyncSafeStorageCipher(storage), ...file });
    expect(await store.get()).toBe("ts_old");
    expect(file.writes()).toBe(2);
    expect(dec.decode(file.current() ?? new Uint8Array())).toBe("aenc:ts_old");
  });
  it("does not write on get when decrypt says no re-encrypt", async () => {
    const { storage } = fakeAsyncSafeStorage(true, false);
    const file = fakeFile();
    await file.write(enc.encode("aenc:ts_now"));
    const store = createTokenStore({ cipher: asyncSafeStorageCipher(storage), ...file });
    expect(await store.get()).toBe("ts_now");
    expect(file.writes()).toBe(1);
  });
});
