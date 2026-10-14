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

  it("answers null and deletes the entry when the read throws", async () => {
    const { store, map } = fakeSecureStore(true);
    map.set("app.token", "ts_old");
    expect(await expoTokenStore(store, { key: "app.token" }).get()).toBeNull();
    expect(map.has("app.token")).toBe(false);
  });

  it("refuses a key that expo-secure-store refuses, at construction", () => {
    expect(() => expoTokenStore(fakeSecureStore().store, { key: "a key" })).toThrow(/key/);
    expect(() => expoTokenStore(fakeSecureStore().store, { key: "" })).toThrow(/key/);
  });
});
