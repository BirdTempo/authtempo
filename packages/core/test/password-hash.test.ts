import { describe, expect, it, vi } from "vitest";
import * as cryptoModule from "../src/primitives/crypto.js";
import {
  createPbkdf2PasswordHash,
  PBKDF2_ITERATIONS,
  pbkdf2Sha256,
} from "../src/seams/password-hash.js";

vi.mock("../src/primitives/crypto.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/primitives/crypto.js")>();
  return { ...m, constantTimeEqual: vi.fn(m.constantTimeEqual) };
});

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => new TextEncoder().encode(s);
const FORMAT_1000 = /^pbkdf2-sha256\$1000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

describe("pbkdf2Sha256", () => {
  // RFC 7914 section 11 (first 32 bytes), and the 4096-iteration vector, both checked with node:crypto pbkdf2Sync on 2026-10-10.
  it("answers the known PBKDF2-HMAC-SHA256 vectors", async () => {
    expect(hex(await pbkdf2Sha256("passwd", utf8("salt"), 1))).toBe(
      "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc",
    );
    expect(hex(await pbkdf2Sha256("password", utf8("salt"), 4096))).toBe(
      "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a",
    );
  });
});

describe("createPbkdf2PasswordHash", () => {
  const seam = createPbkdf2PasswordHash({ iterations: 1000 });

  it("writes the stored format with a fresh salt each time", async () => {
    const a = await seam.hash("correct horse");
    const b = await seam.hash("correct horse");
    expect(a).toMatch(FORMAT_1000);
    expect(b).toMatch(FORMAT_1000);
    expect(a).not.toBe(b);
  });

  it("uses 100000 iterations by default", async () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(await createPbkdf2PasswordHash().hash("x")).toMatch(/^pbkdf2-sha256\$100000\$/);
  });

  it("verifies the right password and refuses a wrong one", async () => {
    const stored = await seam.hash("correct horse");
    expect(await seam.verify("correct horse", stored)).toEqual({ ok: true, rehash: false });
    expect(await seam.verify("correct horsf", stored)).toEqual({ ok: false, rehash: false });
  });

  it("asks for a rehash only on a match with a lower stored cost", async () => {
    const stored = await seam.hash("correct horse");
    const stronger = createPbkdf2PasswordHash({ iterations: 2000 });
    expect(await stronger.verify("correct horse", stored)).toEqual({ ok: true, rehash: true });
    expect(await seam.verify("correct horse", stored)).toEqual({ ok: true, rehash: false });
    expect(await stronger.verify("wrong", stored)).toEqual({ ok: false, rehash: false });
    const higher = await stronger.hash("correct horse");
    expect(await seam.verify("correct horse", higher)).toEqual({ ok: true, rehash: false });
  });

  it("answers ok false for an unknown or malformed header, and never throws", async () => {
    const good = await seam.hash("pw");
    const parts = good.split("$");
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    for (const stored of [
      "",
      "argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
      `pbkdf2-sha1$1000$${parts[2]}$${parts[3]}`,
      `pbkdf2-sha256$01000$${parts[2]}$${parts[3]}`,
      `pbkdf2-sha256$12345678$${parts[2]}$${parts[3]}`,
      `pbkdf2-sha256$1000$${parts[2]}$${parts[3]}=`,
      `pbkdf2-sha256$1000$${parts[2]}`,
      `pbkdf2-sha256$10000000$${parts[2]}$${parts[3]}`,
      `pbkdf2-sha256$1000$${(parts[2] ?? "").slice(0, 21)}+$${parts[3]}`,
    ]) {
      expect(await seam.verify("pw", stored)).toEqual({ ok: false, rehash: false });
    }
    expect(derive).not.toHaveBeenCalled();
    derive.mockRestore();
  });

  it("refuses a stored cost above maxIterations before any derive", async () => {
    const good = await seam.hash("pw");
    const parts = good.split("$");
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    const defaults = createPbkdf2PasswordHash();
    for (const cost of ["100001", "9999999"]) {
      const stored = `pbkdf2-sha256$${cost}$${parts[2]}$${parts[3]}`;
      expect(await defaults.verify("pw", stored)).toEqual({ ok: false, rehash: false });
    }
    expect(derive).not.toHaveBeenCalled();
    derive.mockRestore();
  });

  it("answers ok false when the derive rejects", async () => {
    const stored = await seam.hash("pw");
    const derive = vi
      .spyOn(crypto.subtle, "deriveBits")
      .mockRejectedValueOnce(new Error("refused"));
    expect(await seam.verify("pw", stored)).toEqual({ ok: false, rehash: false });
    derive.mockRestore();
    expect(await seam.verify("pw", stored)).toEqual({ ok: true, rehash: false });
  });

  it("compares through constantTimeEqual", async () => {
    const spy = vi.mocked(cryptoModule.constantTimeEqual);
    const stored = await seam.hash("pw");
    spy.mockClear();
    await seam.verify("pw", stored);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBe(stored.split("$")[3]);
  });

  it("refuses an iteration option that is not an integer from 1 to maxIterations", () => {
    for (const iterations of [0, 1.5, 10_000_000, 600_000, 100_001]) {
      expect(() => createPbkdf2PasswordHash({ iterations })).toThrow(/iterations/);
    }
    expect(() =>
      createPbkdf2PasswordHash({ iterations: 600_000, maxIterations: 600_000 }),
    ).not.toThrow();
  });
});
