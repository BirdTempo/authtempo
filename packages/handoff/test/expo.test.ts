import { describe, expect, it } from "vitest";
import { expoCrypto, expoOpener } from "../src/expo.js";
import { base64Url, makePkce } from "../src/pkce.js";

describe("expoOpener", () => {
  it("opens the auth session with the redirect, never ephemeral, and maps the result", async () => {
    const calls: unknown[] = [];
    const WebBrowser = {
      async openAuthSessionAsync(
        url: string,
        redirectUrl: string,
        options?: { preferEphemeralSession?: boolean },
      ) {
        calls.push([url, redirectUrl, options]);
        return { type: "success", url: `${redirectUrl}?code=hc_1` };
      },
    };
    const opener = expoOpener(WebBrowser);
    expect(await opener.open("https://api/auth/handoff/start?x", "app://auth")).toBe(
      "app://auth?code=hc_1",
    );
    expect(calls[0]).toEqual([
      "https://api/auth/handoff/start?x",
      "app://auth",
      { preferEphemeralSession: false },
    ]);
  });
  it("answers null for cancel, dismiss, and a success with no url", async () => {
    for (const result of [
      { type: "cancel" },
      { type: "dismiss" },
      { type: "success" },
      { type: "locked" },
    ]) {
      const opener = expoOpener({ openAuthSessionAsync: async () => result });
      expect(await opener.open("https://api", "app://auth")).toBeNull();
    }
  });
});

describe("expoCrypto", () => {
  it("builds the handoff crypto on expo-crypto's two functions", async () => {
    const Crypto = {
      getRandomBytes: (n: number) => new Uint8Array(n).fill(1),
      CryptoDigestAlgorithm: { SHA256: "SHA-256" as const },
      digest: async (_a: "SHA-256", data: Uint8Array) =>
        new Uint8Array(32).fill(data.length).buffer,
    };
    const p = await makePkce(expoCrypto(Crypto));
    expect(p.verifier).toBe(base64Url(new Uint8Array(32).fill(1)));
    expect(p.challenge).toBe(base64Url(new Uint8Array(32).fill(43)));
  });
});
