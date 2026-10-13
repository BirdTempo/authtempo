import { afterEach, describe, expect, it, vi } from "vitest";
import { openSealed, seal } from "../src/primitives/aead.js";
import { constantTimeEqual, fromBase64Url, toBase64Url } from "../src/primitives/crypto.js";
import {
  BACKUP_CODE_ALPHABET,
  base32Decode,
  base32Encode,
  hotp,
  normalizeBackupCode,
  otpauthUri,
  randomBackupCode,
  totpCode,
  totpStep,
  verifyTotp,
} from "../src/primitives/totp.js";
import * as testing from "../src/testing/soft-authenticator.js";

// The real compare, wrapped so a test counts its calls (the no-early-return check of `verifyTotp`).
vi.mock("../src/primitives/crypto.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/primitives/crypto.js")>();
  return { ...real, constantTimeEqual: vi.fn(real.constantTimeEqual) };
});

const enc = new TextEncoder();
/** The SHA-1 seed of RFC 4226 Appendix D and RFC 6238 Appendix B: the ASCII bytes of "12345678901234567890". */
const SEED = enc.encode("12345678901234567890");

describe("base32 (plan 9f)", () => {
  it("encodes the RFC 4648 section 10 vectors with no padding, and decodes them back", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, coded] of vectors) {
      expect(base32Encode(enc.encode(plain))).toBe(coded);
      expect(new TextDecoder().decode(base32Decode(coded))).toBe(plain);
    }
    expect(base32Encode(SEED)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("decodes lower case, spaces, and padding, and refuses a character outside the alphabet", () => {
    expect(base32Decode("gezd gnbv")).toEqual(base32Decode("GEZDGNBV"));
    expect(base32Decode("MZXW6YQ=")).toEqual(enc.encode("foob"));
    expect(() => base32Decode("GEZD1")).toThrow("not base32");
  });

  it("checks the characters before the upper-casing, takes `=` at the end only, and refuses a length with no whole byte", () => {
    // "ß" upper-cases to "SS" and "ſ" to "S": both are outside the alphabet as typed.
    expect(() => base32Decode("MZXWß")).toThrow("not base32");
    expect(() => base32Decode("MZXWſ")).toThrow("not base32");
    expect(() => base32Decode("MZ=XW6YQ")).toThrow("not base32");
    // One character holds 5 bits, no byte; three and six end on no byte either.
    expect(() => base32Decode("M")).toThrow("not base32");
    expect(() => base32Decode("MZX")).toThrow("not base32");
    expect(() => base32Decode("MZXW6Y")).toThrow("not base32");
    // Padding pads to a multiple of 8.
    expect(() => base32Decode("MZXW6YQ==")).toThrow("not base32");
    expect(base32Decode("MY======")).toEqual(enc.encode("f"));
  });
});

describe("HOTP and TOTP (plan 9f)", () => {
  it("matches the ten HOTP values of RFC 4226 Appendix D", async () => {
    // RFC 4226 Appendix D, the 6-digit HOTP values for counts 0 to 9. Written into the plan on
    // 2026-10-13 from the RFC's published table; check against the RFC text before you change one.
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    for (const [count, code] of expected.entries()) expect(await hotp(SEED, count)).toBe(code);
  });

  it("matches the SHA-1 vectors of RFC 6238 Appendix B, in 8 digits and cut to 6", async () => {
    // RFC 6238 Appendix B, the SHA-1 rows, written into the plan on 2026-10-13; check against
    // the RFC text before you change one. The 6-digit code is the 8-digit value modulo 10^6,
    // that is, its last six digits: section 5.3 of RFC 4226.
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, eight] of vectors) {
      const at = new Date(seconds * 1000);
      expect(await hotp(SEED, totpStep(at), 8)).toBe(eight);
      expect(await totpCode(SEED, at)).toBe(eight.slice(2));
    }
  });

  it("counts 30-second steps from the epoch", () => {
    expect(totpStep(new Date(0))).toBe(0);
    expect(totpStep(new Date(29_999))).toBe(0);
    expect(totpStep(new Date(30_000))).toBe(1);
    expect(totpStep(new Date(1111111109 * 1000))).toBe(37037036);
  });

  it("writes the high word of the counter", async () => {
    // Counter 2^32 differs from counter 0 only in the high 4 bytes of the 8-byte message.
    expect(await hotp(SEED, 2 ** 32)).not.toBe(await hotp(SEED, 0));
  });

  it("is in the testing entry, so a test computes the code an authenticator shows", () => {
    expect(testing.totpCode).toBe(totpCode);
    expect(testing.base32Decode).toBe(base32Decode);
  });
});

describe("verifyTotp (plan 9f)", () => {
  // 59 seconds is step 1. The RFC 4226 Appendix D values of counts 0, 1, 2, and 3.
  const NOW = new Date(59_000);
  const AT = { 0: "755224", 1: "287082", 2: "359152", 3: "969429" };

  it("answers the matched step for a code of each step in the window, and null outside it", async () => {
    expect(await verifyTotp(SEED, AT[0], NOW, 1)).toBe(0);
    expect(await verifyTotp(SEED, AT[1], NOW, 1)).toBe(1);
    expect(await verifyTotp(SEED, AT[2], NOW, 1)).toBe(2);
    expect(await verifyTotp(SEED, AT[3], NOW, 1)).toBeNull();
    expect(await verifyTotp(SEED, "000000", NOW, 1)).toBeNull();
    expect(await verifyTotp(SEED, AT[0], NOW, 0)).toBeNull();
    expect(await verifyTotp(SEED, AT[1], NOW, 0)).toBe(1);
  });

  it("runs the constant-time compare on every step of the window, also after a match", async () => {
    const compare = vi.mocked(constantTimeEqual);
    for (const [code, window, calls] of [
      [AT[0], 1, 3],
      [AT[1], 1, 3],
      [AT[2], 1, 3],
      ["000000", 1, 3],
      [AT[1], 2, 5],
    ] as const) {
      compare.mockClear();
      await verifyTotp(SEED, code, NOW, window);
      expect(compare).toHaveBeenCalledTimes(calls);
    }
  });
});

describe("the key URI (plan 9f)", () => {
  it("names the issuer, the account, and the RFC 6238 parameters, each encoded", () => {
    expect(otpauthUri({ secret: SEED, issuer: "Acme Co", account: "ada@example.com" })).toBe(
      "otpauth://totp/Acme%20Co:ada%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Acme%20Co&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("backup codes (plan 9f)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses 31 characters with no look-alike: no 0, 1, i, l, or o", () => {
    expect(BACKUP_CODE_ALPHABET).toHaveLength(31);
    expect(new Set(BACKUP_CODE_ALPHABET).size).toBe(31);
    for (const c of "01ilo") expect(BACKUP_CODE_ALPHABET).not.toContain(c);
    expect(randomBackupCode(8)).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);
    expect(randomBackupCode(12)).toHaveLength(12);
  });

  it("draws again for a byte of 248 or more, so no character is more likely", () => {
    const bytes = [248, 255, 0, 30, 31, 61, 247, 100];
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) array[i] = bytes[i % bytes.length] ?? 0;
      return array;
    }) as typeof crypto.getRandomValues);
    // 248 and 255 are drawn again. 0, 30, 31, 61, 247, and 100 are a, 9, a, 9, 9, and h;
    // the buffer of 16 bytes wraps the list, so 0 and 30 give a and 9 again.
    expect(randomBackupCode(8)).toBe("a9a99ha9");
  });

  it("reads a typed code in lower case with no space and no dash", () => {
    expect(normalizeBackupCode(" A9A9-9HA9 ")).toBe("a9a99ha9");
  });
});

describe("seal and openSealed (plan 9f)", () => {
  const A = "0123456789abcdef0123456789abcdef";
  const B = "another secret of 32 characters!";
  const INFO = "tempo-auth totp";

  it("round-trips 20 bytes with a fresh IV each time, as 64 base64url characters", async () => {
    const one = await seal(A, INFO, SEED, "u1");
    const two = await seal(A, INFO, SEED, "u1");
    // 12 bytes of IV, 20 of ciphertext, and 16 of tag: 48 bytes, 64 characters.
    expect(one).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(one).not.toBe(two);
    expect(await openSealed(A, INFO, one, "u1")).toEqual(SEED);
  });

  it("gives nothing for another app secret, another info, another user, or a changed byte (Review Focus 5)", async () => {
    const sealed = await seal(A, INFO, SEED, "u1");
    expect(await openSealed(B, INFO, sealed, "u1")).toBeNull();
    expect(await openSealed(A, "authtempo other", sealed, "u1")).toBeNull();
    expect(await openSealed(A, INFO, sealed, "u2")).toBeNull();
    const last = sealed.at(-2) === "A" ? "B" : "A";
    const changed = `${sealed.slice(0, -2)}${last}${sealed.at(-1) ?? ""}`;
    expect(await openSealed(A, INFO, changed, "u1")).toBeNull();
    expect(await openSealed(A, INFO, "not base64url!", "u1")).toBeNull();
    expect(await openSealed(A, INFO, "", "u1")).toBeNull();
  });

  it("gives nothing for a changed IV or a value under the 28-byte floor, and round-trips a zero-length plaintext", async () => {
    const sealed = fromBase64Url(await seal(A, INFO, SEED, "u1"));
    const iv = sealed.slice();
    iv[0] = (iv[0] ?? 0) ^ 1;
    expect(await openSealed(A, INFO, toBase64Url(iv), "u1")).toBeNull();
    // 12 bytes of IV and 15 of tag: one byte under the floor.
    expect(await openSealed(A, INFO, toBase64Url(sealed.slice(0, 27)), "u1")).toBeNull();
    // A zero-length plaintext seals to exactly the floor: the IV and the tag.
    const empty = await seal(A, INFO, new Uint8Array(0), "u1");
    expect(fromBase64Url(empty).length).toBe(28);
    expect(await openSealed(A, INFO, empty, "u1")).toEqual(new Uint8Array(0));
    expect(await openSealed(A, INFO, empty, "u2")).toBeNull();
  });
});
