import { describe, expect, it } from "vitest";
import { sha256HexSync } from "../src/sha256.js";

async function webCrypto(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("the sync SHA-256 of the refused-proof record (plan 12e ruling 37)", () => {
  it("answers the FIPS 180-4 test vectors", () => {
    expect(sha256HexSync("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256HexSync("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256HexSync("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("equals crypto.subtle.digest at each length from 0 to 700, and for text that is not ASCII", async () => {
    for (let n = 0; n <= 700; n++) {
      const text = "s".repeat(n);
      expect(sha256HexSync(text), String(n)).toBe(await webCrypto(text));
    }
    for (const text of ["é", "日本語", "a\u0000b", "🔑".repeat(40)])
      expect(sha256HexSync(text)).toBe(await webCrypto(text));
  });
});
