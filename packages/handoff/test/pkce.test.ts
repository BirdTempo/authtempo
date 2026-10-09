import { describe, expect, it } from "vitest";
import { base64Url, makePkce, webCrypto } from "../src/pkce.js";

describe("pkce", () => {
  it("makes a 43 character verifier and its S256 challenge, fresh each time", async () => {
    const a = await makePkce(webCrypto());
    const b = await makePkce(webCrypto());
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(a.verifier)),
    );
    expect(base64Url(digest)).toBe(a.challenge);
  });
  it("uses the injected crypto", async () => {
    const c = {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      sha256: async (d: Uint8Array) => new Uint8Array(32).fill(d[0] ?? 0),
    };
    const p = await makePkce(c);
    expect(p.verifier).toBe(base64Url(new Uint8Array(32).fill(7)));
  });
});
