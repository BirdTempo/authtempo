import { afterEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "../src/primitives/clock.js";
import {
  constantTimeEqual,
  fromBase64Url,
  hmacSha256Hex,
  randomBase64Url,
  randomDigits,
  randomToken,
  sha256Base64Url,
  sha256Hex,
  toBase64Url,
} from "../src/primitives/crypto.js";
import { newId } from "../src/primitives/ids.js";

describe("randomToken", () => {
  it("prefixes and encodes 32 bytes as base64url", () => {
    const t = randomToken("ts_");
    expect(t.startsWith("ts_")).toBe(true);
    expect(t.slice(3)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => randomToken("x_")));
    expect(seen.size).toBe(1000);
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("constantTimeEqual", () => {
  it("is true for equal strings and false otherwise", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("newId", () => {
  it("is a 26 char Crockford ULID that sorts by time", () => {
    const a = newId(new Date("2026-01-01T00:00:00Z"));
    const b = newId(new Date("2026-01-01T00:00:01Z"));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});

describe("systemClock", () => {
  it("returns a Date near now", () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});

describe("base64url helpers", () => {
  it("randomBase64Url is 43 chars of the base64url alphabet for 32 bytes", () => {
    const a = randomBase64Url();
    const b = randomBase64Url();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(randomBase64Url(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it("sha256Base64Url matches the PKCE S256 example from RFC 7636 appendix B", async () => {
    expect(await sha256Base64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("base64url round trip", () => {
  it("encodes and decodes bytes with no padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = toBase64Url(bytes);
    expect(text).toBe("AAEC-vv8_f7_");
    expect(Array.from(fromBase64Url(text))).toEqual(Array.from(bytes));
    expect(Array.from(fromBase64Url(""))).toEqual([]);
  });
  it("rejects a character outside the alphabet", () => {
    expect(() => fromBase64Url("ab+/")).toThrow();
    expect(() => fromBase64Url("ab=")).toThrow();
  });
});

describe("hmacSha256Hex (plan 9e)", () => {
  it("matches RFC 4231 test case 2", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("changes with the key", async () => {
    expect(await hmacSha256Hex("key-a", "text")).not.toBe(await hmacSha256Hex("key-b", "text"));
  });
});

describe("randomDigits (plan 9e)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers 6 or 8 decimal digits", () => {
    expect(randomDigits(6)).toMatch(/^\d{6}$/);
    expect(randomDigits(8)).toMatch(/^\d{8}$/);
  });

  it("draws again for a byte of 250 or more, so no digit is more likely", () => {
    const bytes = [250, 255, 3, 251, 14, 249, 0, 129];
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) array[i] = bytes[i % bytes.length] ?? 0;
      return array;
    }) as typeof crypto.getRandomValues);
    // 250, 255, and 251 are drawn again. 3, 14, 249, 0, 129, then 3 again (the
    // buffer of 12 bytes wraps the list) give 3, 4, 9, 0, 9, 3.
    expect(randomDigits(6)).toBe("349093");
  });
});
