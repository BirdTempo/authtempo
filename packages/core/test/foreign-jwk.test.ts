import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64Url, toBase64Url } from "../src/primitives/crypto.js";
import {
  decodeForeignJws,
  type ForeignAlg,
  importForeignKey,
  jwkThumbprint,
  keyFitsAlg,
  publicMembersOnly,
  verifyForeign,
} from "../src/primitives/foreign-jwk.js";

const enc = new TextEncoder();
const ALL: readonly ForeignAlg[] = ["EdDSA", "Ed25519", "ES256", "RS256", "PS256"];

/** The generate, sign, and import parameters of each alg, typed here as literals. */
const PARAMS: Record<ForeignAlg, { gen: unknown; sign: unknown }> = {
  EdDSA: { gen: { name: "Ed25519" }, sign: { name: "Ed25519" } },
  Ed25519: { gen: { name: "Ed25519" }, sign: { name: "Ed25519" } },
  ES256: {
    gen: { name: "ECDSA", namedCurve: "P-256" },
    sign: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    gen: {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    sign: { name: "RSASSA-PKCS1-v1_5" },
  },
  PS256: {
    gen: {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    sign: { name: "RSA-PSS", saltLength: 32 },
  },
};

/** A generated key pair of `alg`, its public JWK, and a signer of compact JWS. `rsa` sets the modulus bits and e. */
async function keyOf(alg: ForeignAlg, rsa: { bits: number; e: number[] } | null = null) {
  const p = PARAMS[alg];
  const gen = rsa
    ? { ...(p.gen as object), modulusLength: rsa.bits, publicExponent: new Uint8Array(rsa.e) }
    : p.gen;
  const pair = (await crypto.subtle.generateKey(gen as Algorithm, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  const sign = async (header: Record<string, unknown>, payload: Record<string, unknown>) => {
    const input = `${toBase64Url(enc.encode(JSON.stringify(header)))}.${toBase64Url(enc.encode(JSON.stringify(payload)))}`;
    const sig = await crypto.subtle.sign(p.sign as Algorithm, pair.privateKey, enc.encode(input));
    return `${input}.${toBase64Url(new Uint8Array(sig))}`;
  };
  return { jwk, sign };
}

/** The same compact JWS with one byte of the signature changed. */
function flipped(token: string): string {
  const [h, p, s = ""] = token.split(".");
  const c = s[5] === "A" ? "B" : "A";
  return `${h}.${p}.${s.slice(0, 5)}${c}${s.slice(6)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("foreign keys (plan 12e Task 5)", () => {
  it("verifies each of the five algs under a generated key", async () => {
    for (const alg of ALL) {
      const { jwk, sign } = await keyOf(alg);
      const token = await sign({ alg, kid: "k1" }, { sub: "x" });
      const decoded = decodeForeignJws(token);
      if (!decoded) throw new Error(`${alg}: no decode`);
      expect({ alg, ok: await verifyForeign(decoded, jwk, ALL) }).toEqual({ alg, ok: true });
      const bad = decodeForeignJws(flipped(token));
      if (!bad) throw new Error(`${alg}: no decode of the changed token`);
      expect({ alg, ok: await verifyForeign(bad, jwk, ALL) }).toEqual({ alg, ok: false });
    }
  });

  it("matches EdDSA and Ed25519 to each other and refuses an Ed448 key (RFC 9864)", async () => {
    const { jwk, sign } = await keyOf("Ed25519");
    // WebCrypto exports an Ed25519 key with alg Ed25519 (Node 26.10.0, read 2026-10-19).
    expect(jwk.alg).toBe("Ed25519");
    for (const alg of ["EdDSA", "Ed25519"]) {
      const decoded = decodeForeignJws(await sign({ alg }, { sub: "x" }));
      if (!decoded) throw new Error("no decode");
      expect({ alg, ok: await verifyForeign(decoded, jwk, ALL) }).toEqual({ alg, ok: true });
      expect(
        await verifyForeign(decoded, { ...jwk, alg: alg === "EdDSA" ? "Ed25519" : "EdDSA" }, ALL),
      ).toBe(true);
    }
    // A key of another alg does not verify a token of this one.
    const decoded = decodeForeignJws(await sign({ alg: "EdDSA" }, { sub: "x" }));
    if (!decoded) throw new Error("no decode");
    expect(await verifyForeign(decoded, { ...jwk, alg: "ES256" }, ALL)).toBe(false);
    // An Ed448 key: the same kty, another curve.
    expect(await importForeignKey({ ...jwk, crv: "Ed448" }, "Ed25519")).toBeNull();
    expect(await importForeignKey({ ...jwk, crv: "Ed448", alg: "Ed448" }, "EdDSA")).toBeNull();
    expect(await verifyForeign(decoded, { ...jwk, crv: "Ed448" }, ALL)).toBe(false);
  });

  it("refuses none, a MAC, and an alg outside the list", async () => {
    const { jwk, sign } = await keyOf("ES256");
    const spy = vi.spyOn(crypto.subtle, "importKey");
    for (const alg of ["none", "HS256", "ES384"]) {
      const decoded = decodeForeignJws(await sign({ alg }, { sub: "x" }));
      if (!decoded) throw new Error(`${alg}: no decode`);
      expect({ alg, ok: await verifyForeign(decoded, jwk, ALL) }).toEqual({ alg, ok: false });
    }
    // An alg of the four that the caller's list leaves out.
    const es = decodeForeignJws(await sign({ alg: "ES256" }, { sub: "x" }));
    if (!es) throw new Error("no decode");
    expect(await verifyForeign(es, jwk, ["EdDSA", "RS256"])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a key with a private member", async () => {
    const pubs = await Promise.all(["EdDSA", "ES256", "RS256"].map((a) => keyOf(a as ForeignAlg)));
    for (const { jwk } of pubs) {
      expect({ kty: jwk.kty, ok: publicMembersOnly(jwk) }).toEqual({ kty: jwk.kty, ok: true });
      expect({ kty: jwk.kty, ok: publicMembersOnly({ ...jwk, d: "AAAA" }) }).toEqual({
        kty: jwk.kty,
        ok: false,
      });
    }
    expect(publicMembersOnly({ kty: "oct", k: "AAAA" })).toBe(false);
    expect(publicMembersOnly({ kty: "oct" })).toBe(false);
    expect(publicMembersOnly(null)).toBe(false);
    expect(publicMembersOnly([])).toBe(false);
  });

  it("refuses an RSA key under 2048 bits, with a leading zero byte, or with a weak e", async () => {
    for (const alg of ["RS256", "PS256"] as const) {
      const verifies = async (k: Awaited<ReturnType<typeof keyOf>>, jwk = k.jwk) => {
        const decoded = decodeForeignJws(await k.sign({ alg }, { sub: "x" }));
        if (!decoded) throw new Error("no decode");
        return verifyForeign(decoded, jwk, ALL);
      };
      const k2048 = await keyOf(alg);
      expect({ alg, bits: 2048, ok: await verifies(k2048) }).toEqual({ alg, bits: 2048, ok: true });
      const k2047 = await keyOf(alg, { bits: 2047, e: [1, 0, 1] });
      expect(fromBase64Url(String(k2047.jwk.n)).length).toBe(256);
      expect({ alg, bits: 2047, ok: await verifies(k2047) }).toEqual({
        alg,
        bits: 2047,
        ok: false,
      });
      expect(keyFitsAlg(k2047.jwk, alg)).toBe(false);
      // A short key with zero bytes in front of n, to 256 bytes. PS256 needs 1024 bits:
      // its salt and its hash do not fit in a 512-bit key.
      const bits = alg === "PS256" ? 1024 : 512;
      const short = await keyOf(alg, { bits, e: [1, 0, 1] });
      const n = new Uint8Array([
        ...new Uint8Array(256 - bits / 8),
        ...fromBase64Url(String(short.jwk.n)),
      ]);
      const padded = { ...short.jwk, n: toBase64Url(n) };
      expect({ alg, bits, ok: await verifies(short, padded) }).toEqual({ alg, bits, ok: false });
      // e = 3: WebCrypto makes and imports the key, and core refuses it.
      const k3 = await keyOf(alg, { bits: 2048, e: [3] });
      expect(k3.jwk.e).toBe("Aw");
      expect({ alg, e: 3, ok: await verifies(k3) }).toEqual({ alg, e: 3, ok: false });
      expect(keyFitsAlg({ ...k2048.jwk, e: "AQ" }, alg)).toBe(false);
    }
  });

  it("computes the RFC 7638 thumbprint of its example", async () => {
    // RFC 7638 section 3.1, read 2026-10-19.
    const key = {
      kty: "RSA",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      e: "AQAB",
      alg: "RS256",
      kid: "2011-04-29",
    };
    expect(await jwkThumbprint(key)).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
    // RFC 8037 Appendix A.3: the OKP example.
    expect(
      await jwkThumbprint({
        kty: "OKP",
        crv: "Ed25519",
        x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
      }),
    ).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
    // A missing required member, and a key type with no rule.
    expect(await jwkThumbprint({ kty: "RSA", n: key.n })).toBeNull();
    expect(await jwkThumbprint({ kty: "oct", k: "AAAA" })).toBeNull();
  });

  it("ignores extra members in the thumbprint", async () => {
    const { jwk } = await keyOf("ES256");
    const bare = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const want = await jwkThumbprint(bare);
    expect(want).not.toBeNull();
    expect(await jwkThumbprint({ ...bare, kid: "k1", alg: "ES256", use: "sig" })).toBe(want);
  });

  it("decodes a header with no kid and refuses crit", async () => {
    const { sign } = await keyOf("ES256");
    const none = decodeForeignJws(await sign({ alg: "ES256" }, { sub: "x" }));
    expect(none?.header).toEqual({ alg: "ES256", kid: null, typ: null, jwk: null });
    const typed = decodeForeignJws(
      await sign({ alg: "ES256", kid: "k1", typ: "client-authentication+jwt" }, { sub: "x" }),
    );
    expect(typed?.header).toMatchObject({ kid: "k1", typ: "client-authentication+jwt" });
    expect(decodeForeignJws(await sign({ alg: "ES256", crit: ["x"] }, { sub: "x" }))).toBeNull();
    expect(decodeForeignJws(await sign({ alg: "ES256", kid: 7 }, { sub: "x" }))).toBeNull();
    expect(decodeForeignJws("a.b")).toBeNull();
  });
});
