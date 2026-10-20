import {
  createAuth,
  createMemoryAdapter,
  createPbkdf2PasswordHash,
  deriveGate,
  type PasswordHashSeam,
} from "@authtempo/core";
import { argon2id } from "@noble/hashes/argon2.js";
import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";
import { type Derives, NOBLE_DERIVES } from "../src/derive.js";
import {
  encodeBase64,
  firescryptParamsValid,
  LEGACY_FORMATS,
  type LegacyFormat,
  parseLegacyHash,
} from "../src/grammar.js";
import { BCRYPT_MAX_PASSWORD_BYTES, createLegacyPasswordHash } from "../src/seam.js";
import { FIREBASE, VECTORS } from "./vectors.js";

const fast = createPbkdf2PasswordHash({ iterations: 1000 });

/** The derives with a counter on each, so a test sees whether a legacy derive ran. */
function counting(): { derives: Derives; calls: () => number } {
  const spies = {
    bcrypt: vi.fn(NOBLE_DERIVES.bcrypt),
    argon2id: vi.fn(NOBLE_DERIVES.argon2id),
    pbkdf2: vi.fn(NOBLE_DERIVES.pbkdf2),
    scrypt: vi.fn(NOBLE_DERIVES.scrypt),
  };
  return {
    derives: spies,
    calls: () => Object.values(spies).reduce((n, s) => n + s.mock.calls.length, 0),
  };
}

/** `next` with a counter on verify, so a test sees the dummy verify and the pass-through. */
function countingNext(): { next: PasswordHashSeam; verify: ReturnType<typeof vi.fn> } {
  const verify = vi.fn((plain: string, stored: string) => fast.verify(plain, stored));
  return { next: { hash: fast.hash, dummy: fast.dummy, verify }, verify };
}

const FORMAT_OF: Record<keyof typeof VECTORS, LegacyFormat> = {
  bcrypt2a: "bcrypt",
  bcrypt2b: "bcrypt",
  argon2id: "argon2id",
  pbkdf2: "pbkdf2-sha256",
  scrypt: "scrypt",
  firescrypt: "firescrypt",
};

const all = (extra: { derives?: Derives; next?: PasswordHashSeam } = {}) =>
  createLegacyPasswordHash({ formats: LEGACY_FORMATS, firebase: FIREBASE, next: fast, ...extra });

describe("the known-answer vectors", () => {
  for (const [name, v] of Object.entries(VECTORS)) {
    it(`verifies ${name} and asks for a rehash; refuses the wrong password`, async () => {
      const seam = all();
      expect(await seam.verify(v.password, v.stored)).toEqual({ ok: true, rehash: true });
      expect(await seam.verify(v.wrong, v.stored)).toEqual({ ok: false, rehash: false });
    });
  }

  it("runs noble's Argon2id on the RFC 9106 section 5.3 vector (the primitive under the argon2id format)", () => {
    const fill = (n: number, b: number) => new Uint8Array(n).fill(b);
    const out = argon2id(fill(32, 1), fill(16, 2), {
      t: 3,
      m: 32,
      p: 4,
      dkLen: 32,
      key: fill(8, 3),
      personalization: fill(12, 4),
    });
    expect(Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
    );
  });
});

describe("one format per string (Review Focus 1)", () => {
  it("parses each vector as its own format only", () => {
    for (const [name, v] of Object.entries(VECTORS)) {
      expect(parseLegacyHash(v.stored)?.format).toBe(FORMAT_OF[name as keyof typeof VECTORS]);
    }
  });

  it("refuses each vector under every other format, with no legacy derive", async () => {
    for (const [name, v] of Object.entries(VECTORS)) {
      for (const other of LEGACY_FORMATS) {
        if (other === FORMAT_OF[name as keyof typeof VECTORS]) continue;
        const { derives, calls } = counting();
        const seam = createLegacyPasswordHash({
          formats: [other],
          firebase: FIREBASE,
          next: fast,
          derives,
        });
        expect(await seam.verify(v.password, v.stored)).toEqual({ ok: false, rehash: false });
        expect(calls()).toBe(0);
      }
    }
  });

  it("passes every string that does not start with $ to next unchanged", async () => {
    const { next, verify } = countingNext();
    const seam = all({ next });
    const pbkdf2 = await fast.hash("correct horse battery");
    expect(await seam.verify("correct horse battery", pbkdf2)).toEqual({ ok: true, rehash: false });
    for (const stored of [
      // Better Auth's scrypt (plan 9), core's pending marker, core's legacy-verify marker.
      "8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3",
      `pending$${pbkdf2}`,
      "legacy-verify$",
    ]) {
      await seam.verify("x", stored);
      expect(verify).toHaveBeenLastCalledWith("x", stored);
    }
  });

  it("answers new hashes and the dummy from next, never in a legacy format", async () => {
    const seam = all();
    expect(await seam.hash("new password here")).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(await seam.dummy()).toBe(await fast.dummy());
  });
});

describe("firescryptParamsValid, the one n and r bound of the grammar", () => {
  it("accepts Firebase's usual n=14, r=8", () => {
    expect(firescryptParamsValid(14, 8)).toBe(true);
  });
  it("refuses r=100, three digits, which the grammar cannot read", () => {
    expect(firescryptParamsValid(1, 100)).toBe(false);
  });
});

describe("a malformed or refused string costs the dummy and no derive (Review Focus 1)", () => {
  const { bcrypt2a, argon2id: a2, pbkdf2: pb, scrypt: sc, firescrypt: fs } = VECTORS;
  // A hash of 65 bytes: one byte above the 16 to 64 byte bound of every format.
  const long = encodeBase64(new Uint8Array(65).fill(7));
  // 32 bytes: in the bound, but not the 64 bytes of the Firebase signer key.
  const short = encodeBase64(new Uint8Array(32).fill(7));
  const cases: [string, string][] = [
    ["bcrypt cost 13", bcrypt2a.stored.replace("$10$", "$13$")],
    ["bcrypt cost 03", bcrypt2a.stored.replace("$10$", "$03$")],
    ["bcrypt $2y$", bcrypt2a.stored.replace("$2a$", "$2y$")],
    ["bcrypt one character short", bcrypt2a.stored.slice(0, -1)],
    ["argon2id v=16", a2.stored.replace("v=19", "v=16")],
    ["argon2id m above the bound", a2.stored.replace("m=19456", "m=65536")],
    ["argon2id m below 8 per lane", a2.stored.replace("m=19456,t=2,p=1", "m=8,t=2,p=4")],
    ["argon2id t=0", a2.stored.replace("t=2", "t=0")],
    ["argon2id t=11, above the bound", a2.stored.replace("t=2", "t=11")],
    ["argon2id a 65-byte hash", a2.stored.replace(/\$[^$]+$/, `$${long}`)],
    ["argon2id p=5", a2.stored.replace("p=1", "p=5")],
    ["argon2id with no salt", a2.stored.replace("$dGVtcG8tYXV0aC1zYWx0IQ", "")],
    // RFC 9106 section 3.1: an Argon2 salt is at least 8 bytes. 7 is one below.
    [
      "argon2id a 7-byte salt",
      a2.stored.replace("$dGVtcG8tYXV0aC1zYWx0IQ", `$${encodeBase64(new Uint8Array(7).fill(9))}`),
    ],
    ["argon2i", a2.stored.replace("$argon2id$", "$argon2i$")],
    ["pbkdf2 i=0", pb.stored.replace("i=80000", "i=0")],
    ["pbkdf2 i above the bound", pb.stored.replace("i=80000", "i=600001")],
    ["pbkdf2 l that does not match the hash", pb.stored.replace("l=64", "l=32")],
    ["pbkdf2-sha512", pb.stored.replace("pbkdf2-sha256", "pbkdf2-sha512")],
    [
      "pbkdf2 a 65-byte hash with l=65",
      pb.stored.replace("l=64", "l=65").replace(/\$[^$]+$/, `$${long}`),
    ],
    ["scrypt N times r above 2^18", sc.stored.replace("n=10,r=8", "n=16,r=8")],
    ["scrypt p=17", sc.stored.replace("p=16", "p=17")],
    ["scrypt Ory's ln", sc.stored.replace("n=10", "ln=1024")],
    ["scrypt a 65-byte hash", sc.stored.replace(/\$[^$]+$/, `$${long}`)],
    ["firescrypt p=2", fs.stored.replace("p=1", "p=2")],
    ["firescrypt with a bad base64 character", fs.stored.replace("42xEC+", "42xEC*")],
    ["firescrypt a hash shorter than the signer key", fs.stored.replace(/\$[^$]+$/, `$${short}`)],
    [
      "Supabase's own fbscrypt tag",
      fs.stored.replace("$firescrypt$n=14,r=8,p=1", "$fbscrypt$v=1,n=14,r=8,p=1"),
    ],
    ["an unknown tag", "$md5$abc$def"],
    ["a bare $", "$"],
  ];
  for (const [label, stored] of cases) {
    it(`refuses ${label}`, async () => {
      const { derives, calls } = counting();
      const { next, verify } = countingNext();
      const seam = createLegacyPasswordHash({
        formats: LEGACY_FORMATS,
        firebase: FIREBASE,
        next,
        derives,
      });
      const dummy = await fast.dummy();
      expect(await seam.verify("allmine", stored)).toEqual({ ok: false, rehash: false });
      expect(calls()).toBe(0);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledWith("allmine", dummy);
    });
  }

  it("refuses an empty password with no derive", async () => {
    const { derives, calls } = counting();
    const seam = all({ derives });
    expect(await seam.verify("", VECTORS.bcrypt2a.stored)).toEqual({ ok: false, rehash: false });
    expect(calls()).toBe(0);
  });

  it("answers ok false when a derive throws, and never throws itself", async () => {
    const seam = all({
      derives: {
        ...NOBLE_DERIVES,
        bcrypt: async () => {
          throw new Error("out of memory");
        },
      },
    });
    expect(await seam.verify(VECTORS.bcrypt2a.password, VECTORS.bcrypt2a.stored)).toEqual({
      ok: false,
      rehash: false,
    });
  });
});

describe("bcrypt's 72-byte limit (bcryptjs truncates)", () => {
  // Cost 4 keeps the test fast and is inside the 4 to 12 bound.
  const seam = createLegacyPasswordHash({ formats: ["bcrypt"], next: fast });

  it("asks for a rehash at 72 bytes, and counts bytes, not characters", async () => {
    expect(BCRYPT_MAX_PASSWORD_BYTES).toBe(72);
    const ascii = "a".repeat(72);
    expect(await seam.verify(ascii, bcrypt.hashSync(ascii, 4))).toEqual({ ok: true, rehash: true });
    // 36 characters of two UTF-8 bytes each: 72 bytes.
    const two = "\u00e9".repeat(36);
    expect(await seam.verify(two, bcrypt.hashSync(two, 4))).toEqual({ ok: true, rehash: true });
  });

  it("matches above 72 bytes with any tail and keeps the bcrypt row", async () => {
    // 37 characters, 74 bytes: above the limit by bytes, under it by characters.
    const two = "\u00e9".repeat(37);
    expect(await seam.verify(two, bcrypt.hashSync(two, 4))).toEqual({ ok: true, rehash: false });
    const typed = `${"b".repeat(72)}the tail the user knows`;
    const stored = bcrypt.hashSync(typed, 4);
    expect(await seam.verify(typed, stored)).toEqual({ ok: true, rehash: false });
    // bcrypt reads only 72 bytes, so a wrong tail matches. This pins bcryptjs's
    // behaviour, so a change in it shows here. No rehash writes the wrong tail.
    expect(await seam.verify(`${"b".repeat(72)}a wrong tail`, stored)).toEqual({
      ok: true,
      rehash: false,
    });
  });
});

describe("construction", () => {
  it("refuses firescrypt without the firebase option, an unknown format, and a bad signer key", () => {
    expect(() => createLegacyPasswordHash({ formats: ["firescrypt"], next: fast })).toThrow(
      /firescrypt format needs the firebase option/,
    );
    expect(() =>
      createLegacyPasswordHash({ formats: ["md5" as LegacyFormat], next: fast }),
    ).toThrow(/unknown format md5/);
    expect(() =>
      createLegacyPasswordHash({
        formats: ["firescrypt"],
        firebase: { signerKey: "short", saltSeparator: "Bw==" },
        next: fast,
      }),
    ).toThrow(/signerKey must be base64/);
  });
});

describe("the seam runs its derives through the gate", () => {
  it("runs at most deriveGate.max of four concurrent Argon2id verifies at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const derives: Derives = {
      ...NOBLE_DERIVES,
      argon2id: async (plain, salt, o) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => release.push(r));
        inFlight--;
        return NOBLE_DERIVES.argon2id(plain, salt, o);
      },
    };
    const seam = createLegacyPasswordHash({ formats: ["argon2id"], next: fast, derives });
    const v = VECTORS.argon2id;
    const answers = Array.from({ length: 4 }, () => seam.verify(v.password, v.stored));
    while (release.length < deriveGate.max) await new Promise((r) => setTimeout(r, 1));
    // Time for a third derive to start if the gate did not hold it.
    await new Promise((r) => setTimeout(r, 20));
    expect(inFlight).toBe(deriveGate.max);
    for (let done = 0; done < 4; done++) {
      while (release.length === 0) await new Promise((r) => setTimeout(r, 1));
      release.shift()?.();
    }
    expect(await Promise.all(answers)).toEqual(
      Array.from({ length: 4 }, () => ({ ok: true, rehash: true })),
    );
    expect(peak).toBe(deriveGate.max);
    expect(deriveGate.running()).toBe(0);
  });
});

describe("the rehash on sign-in (plan 8)", () => {
  it("writes a PBKDF2 hash over a bcrypt hash on the first right sign-in", async () => {
    const storage = createMemoryAdapter();
    const at = new Date("2026-10-11T00:00:00.000Z");
    await storage.create("user", {
      id: "u1",
      email: "ada@example.com",
      emailVerified: true,
      name: null,
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
      hash: VECTORS.bcrypt2a.stored,
      createdAt: at,
      updatedAt: at,
    });
    const auth = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage,
      mail: { send: async () => {} },
      password: { hash: createLegacyPasswordHash({ formats: ["bcrypt"], next: fast }) },
    });
    const pw = auth.api.password;
    if (!pw) throw new Error("the password api is missing");
    const signIn = (password: string) =>
      pw.signIn({ email: "ada@example.com", password, ip: null, userAgent: null });
    expect((await signIn(VECTORS.bcrypt2a.password)).ok).toBe(true);
    const row = await storage.findOne("password", [{ field: "id", op: "eq", value: "p1" }]);
    expect(row?.hash).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect((await signIn(VECTORS.bcrypt2a.password)).ok).toBe(true);
    expect(await signIn(VECTORS.bcrypt2a.wrong)).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
  });
});
