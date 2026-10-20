import { createAuth, createMemoryAdapter, createPbkdf2PasswordHash } from "@authtempo/core";
import { describe, expect, it, vi } from "vitest";
import { betterAuthPasswordHash, nobleScrypt, SCRYPT } from "../src/hash.js";

// Produced on 2026-10-10 by @better-auth/utils 0.4.2 dist/password.node.mjs
// (hashPassword), the file better-auth 1.7.2 runs on Node and on workerd,
// under Node 26.10.0. verifyPassword answered true for the right password
// and false for "correct horse batterz".
const VECTOR = {
  password: "correct horse battery",
  hash: "8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3",
};
// Same source. Hashed from "Ångström pass" (U+212B ANGSTROM SIGN). verifyPassword
// answered true for "Ångström pass" (U+00C5), because both NFKC-normalize to U+00C5.
const NFKC_VECTOR = {
  hashedFrom: "Ångström pass",
  verifiedWith: "Ångström pass",
  hash: "8035e0b72d4e9e1dbde9672966b75154:5b46cb96f3e2047e54bf118e4e86b4d9d5b66f256204d0dd291eae7ccd116e18a698c05e08d71b615d483c09c13abe8cbdc506a83b5c4c14f498160e678cd57e",
};

// Same algorithm, derived on 2026-10-10 with node:crypto scryptSync (the call
// under @better-auth/utils password.node.mjs) from the NFKC form of
// "\uFB01nd the horse" (the U+FB01 ligature). NFKC gives "find the horse";
// NFC keeps the ligature, so an NFC normalize derives another key.
const LIGATURE_VECTOR = {
  hashedFrom: "\uFB01nd the horse",
  verifiedWith: "find the horse",
  hash: "0123456789abcdef0123456789abcdef:156d837a0848a752d0626f4b497aa9b7e495bdda79f95a3d1967eaf9c72dc0cc5562a66d0abbb41c83b807e6054d9b6e1e4109587c8b35d1ebc2effd50288643",
};

const fast = createPbkdf2PasswordHash({ iterations: 1000 });

describe("betterAuthPasswordHash", () => {
  it("uses Better Auth's scrypt parameters", () => {
    expect(SCRYPT).toEqual({ N: 16384, r: 16, p: 1, dkLen: 64 });
  });

  it("verifies a real Better Auth hash and asks for a rehash", async () => {
    const seam = betterAuthPasswordHash({ pbkdf2: fast });
    expect(await seam.verify(VECTOR.password, VECTOR.hash)).toEqual({ ok: true, rehash: true });
    expect(await seam.verify("correct horse batterz", VECTOR.hash)).toEqual({
      ok: false,
      rehash: false,
    });
  });

  it("normalizes the password with NFKC before the derive, as Better Auth does", async () => {
    const seam = betterAuthPasswordHash({ pbkdf2: fast });
    expect(await seam.verify(NFKC_VECTOR.verifiedWith, NFKC_VECTOR.hash)).toEqual({
      ok: true,
      rehash: true,
    });
    expect(await seam.verify(NFKC_VECTOR.hashedFrom, NFKC_VECTOR.hash)).toEqual({
      ok: true,
      rehash: true,
    });
  });

  it("uses NFKC, not NFC: a compatibility ligature folds to its letters", async () => {
    const seam = betterAuthPasswordHash({ pbkdf2: fast });
    expect(await seam.verify(LIGATURE_VECTOR.verifiedWith, LIGATURE_VECTOR.hash)).toEqual({
      ok: true,
      rehash: true,
    });
    expect(await seam.verify(LIGATURE_VECTOR.hashedFrom, LIGATURE_VECTOR.hash)).toEqual({
      ok: true,
      rehash: true,
    });
  });

  it("runs at most two derives at once and finishes the rest in order", async () => {
    const started: number[] = [];
    const finish: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const scrypt = vi.fn((_pw: Uint8Array, _salt: Uint8Array) => {
      const id = started.length;
      started.push(id);
      active++;
      peak = Math.max(peak, active);
      return new Promise<Uint8Array>((resolve) => {
        finish[id] = () => {
          active--;
          resolve(new Uint8Array(64));
        };
      });
    });
    const seam = betterAuthPasswordHash({ pbkdf2: fast, scrypt });
    const done: number[] = [];
    const runs = [0, 1, 2, 3, 4, 5].map((i) =>
      seam.verify("pw", VECTOR.hash).then(() => done.push(i)),
    );
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(peak).toBe(2);
    for (let i = 0; i < 6; i++) {
      await vi.waitFor(() => expect(started.length).toBeGreaterThan(i));
      finish[i]?.();
      await vi.waitFor(() => expect(done).toHaveLength(i + 1));
      expect(peak).toBeLessThanOrEqual(2);
    }
    await Promise.all(runs);
    expect(done).toEqual([0, 1, 2, 3, 4, 5]);
    expect(scrypt).toHaveBeenCalledTimes(6);
  });

  it("frees the gate slot of a derive that throws, so a later verify still runs (final review L-4)", async () => {
    const finish: Array<() => void> = [];
    let calls = 0;
    const scrypt = vi.fn((_pw: Uint8Array, _salt: Uint8Array) => {
      const id = calls++;
      // Derives 0 and 1 fill the gate. Derive 2 throws. Derive 3 answers at once.
      if (id === 2) return Promise.reject(new Error("out of memory"));
      if (id === 3) return Promise.resolve(new Uint8Array(64));
      return new Promise<Uint8Array>((resolve) => {
        finish[id] = () => resolve(new Uint8Array(64));
      });
    });
    const seam = betterAuthPasswordHash({ pbkdf2: fast, scrypt });
    const held = [seam.verify("pw", VECTOR.hash), seam.verify("pw", VECTOR.hash)];
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    const thrown = seam.verify("pw", VECTOR.hash);
    // Derive 0 ends and hands its slot to derive 2, which throws.
    finish[0]?.();
    expect(await thrown).toEqual({ ok: false, rehash: false });
    // Derive 1 still holds one slot. The slot of derive 2 must be free.
    let completed = false;
    const later = seam.verify("pw", VECTOR.hash).then((r) => {
      completed = true;
      return r;
    });
    await vi.waitFor(() => expect(completed).toBe(true));
    expect(await later).toEqual({ ok: false, rehash: false });
    finish[1]?.();
    await Promise.all(held);
    expect(scrypt).toHaveBeenCalledTimes(4);
  });

  it("answers ok false with no derive for a pending$ row, also with a real PBKDF2 string after the prefix (final review L-1)", async () => {
    const scrypt = vi.fn(nobleScrypt);
    const seam = betterAuthPasswordHash({ pbkdf2: fast, scrypt });
    const stored = await fast.hash("x");
    expect(await seam.verify("x", stored)).toEqual({ ok: true, rehash: false });
    expect(await seam.verify("x", `pending$${stored}`)).toEqual({ ok: false, rehash: false });
    expect(scrypt).toHaveBeenCalledTimes(0);
  });

  it("hashes and verifies new passwords through the PBKDF2 seam", async () => {
    const seam = betterAuthPasswordHash({ pbkdf2: fast });
    const stored = await seam.hash("new horse battery");
    expect(stored).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(await seam.verify("new horse battery", stored)).toEqual({ ok: true, rehash: false });
    expect(await seam.dummy()).toBe(await fast.dummy());
  });

  it("answers ok false with no scrypt run for a malformed Better Auth hash (Review Focus 3)", async () => {
    const scrypt = vi.fn(nobleScrypt);
    const seam = betterAuthPasswordHash({ pbkdf2: fast, scrypt });
    const [salt, key] = VECTOR.hash.split(":") as [string, string];
    for (const stored of [
      `${salt}:${key.slice(0, 126)}`, // a 63-byte key
      `${salt}:${key}ab`, // a 65-byte key
      `${salt}:${key.toUpperCase()}`, // Better Auth writes lowercase hex only
      `${salt.slice(1)}:${key}`, // a 31-character salt
      `${salt}0:${key}`, // a 33-character salt
      `${salt}${key}`, // no separator
      `${salt}:${key}:${key}`, // two separators
      "",
    ]) {
      expect(await seam.verify(VECTOR.password, stored)).toEqual({ ok: false, rehash: false });
    }
    expect(await seam.verify("", VECTOR.hash)).toEqual({ ok: false, rehash: false });
    expect(scrypt).not.toHaveBeenCalled();
  });

  it("answers ok false when the scrypt throws, and never throws itself", async () => {
    const seam = betterAuthPasswordHash({
      pbkdf2: fast,
      scrypt: async () => {
        throw new Error("out of memory");
      },
    });
    expect(await seam.verify(VECTOR.password, VECTOR.hash)).toEqual({ ok: false, rehash: false });
  });
});

describe("the rehash on sign-in (plan 8)", () => {
  it("writes a PBKDF2 hash over the Better Auth hash on the first right sign-in", async () => {
    const storage = createMemoryAdapter();
    const at = new Date("2026-10-10T00:00:00.000Z");
    await storage.create("user", {
      id: "u1",
      email: "pat@example.com",
      emailVerified: true,
      name: "Pat",
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      createdAt: at,
      updatedAt: at,
    });
    await storage.create("password", {
      id: "p1",
      userId: "u1",
      hash: VECTOR.hash,
      createdAt: at,
      updatedAt: at,
    });
    const auth = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage,
      mail: { send: async () => {} },
      password: { hash: betterAuthPasswordHash({ pbkdf2: fast }) },
    });
    const pw = auth.api.password;
    if (!pw) throw new Error("the password api is missing");
    const first = await pw.signIn({
      email: "pat@example.com",
      password: VECTOR.password,
      ip: null,
      userAgent: null,
    });
    expect(first.ok).toBe(true);
    const row = await storage.findOne("password", [{ field: "id", op: "eq", value: "p1" }]);
    expect(row?.hash).toMatch(/^pbkdf2-sha256\$1000\$/);
    const second = await pw.signIn({
      email: "pat@example.com",
      password: VECTOR.password,
      ip: null,
      userAgent: null,
    });
    expect(second.ok).toBe(true);
    const wrong = await pw.signIn({
      email: "pat@example.com",
      password: "wrong horse battery",
      ip: null,
      userAgent: null,
    });
    expect(wrong).toMatchObject({ ok: false, code: "invalid_credentials" });
  });
});
