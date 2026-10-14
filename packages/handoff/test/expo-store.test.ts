import { describe, expect, it } from "vitest";
import { expoTokenStore, type SecureStoreLike } from "../src/expo.js";

function fakeSecureStore(failRead = false) {
  const m = new Map<string, string>();
  const store: SecureStoreLike = {
    getItemAsync: async (k) => {
      if (failRead) throw new Error("the keystore entry is gone");
      return m.get(k) ?? null;
    },
    setItemAsync: async (k, v) => {
      m.set(k, v);
    },
    deleteItemAsync: async (k) => {
      m.delete(k);
    },
  };
  return { store, map: m };
}

describe("expoTokenStore (plan 11d)", () => {
  it("keeps the token under its key, reads it back, and clears it", async () => {
    const { store, map } = fakeSecureStore();
    const tokens = expoTokenStore(store);
    expect(await tokens.get()).toBeNull();
    await tokens.set("ts_secret");
    expect(map.get("authtempo.session")).toBe("ts_secret");
    expect(await tokens.get()).toBe("ts_secret");
    await tokens.clear();
    expect(await tokens.get()).toBeNull();
  });

  it("answers null and keeps the entry when the read throws, as a locked keychain does (O1)", async () => {
    const { store, map } = fakeSecureStore(true);
    map.set("app.token", "ts_old");
    expect(await expoTokenStore(store, { key: "app.token" }).get()).toBeNull();
    expect(map.get("app.token")).toBe("ts_old");
  });

  it("answers null and deletes an entry that is present but empty (O1)", async () => {
    const { store, map } = fakeSecureStore();
    map.set("authtempo.session", "");
    expect(await expoTokenStore(store).get()).toBeNull();
    expect(map.has("authtempo.session")).toBe(false);
  });

  it("passes the SecureStore options to each call (L2)", async () => {
    const seen: unknown[] = [];
    const store: SecureStoreLike = {
      getItemAsync: async (_k, o) => {
        seen.push(o);
        return "ts_x";
      },
      setItemAsync: async (_k, _v, o) => {
        seen.push(o);
      },
      deleteItemAsync: async (_k, o) => {
        seen.push(o);
      },
    };
    const options = { keychainService: "consumera", keychainAccessible: 0 };
    const tokens = expoTokenStore(store, { secureStoreOptions: options });
    await tokens.get();
    await tokens.set("ts_y");
    await tokens.clear();
    expect(seen).toEqual([options, options, options]);
  });

  it("refuses a key that expo-secure-store refuses, at construction", () => {
    expect(() => expoTokenStore(fakeSecureStore().store, { key: "a key" })).toThrow(/key/);
    expect(() => expoTokenStore(fakeSecureStore().store, { key: "" })).toThrow(/key/);
  });
});
