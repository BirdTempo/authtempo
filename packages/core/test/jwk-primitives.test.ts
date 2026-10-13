import { importJWK, jwtVerify, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { toBase64Url } from "../src/primitives/crypto.js";
import {
  decodeJws,
  generateSigningKey,
  type JwsAlg,
  openPrivateKey,
  sealPrivateKey,
  signJws,
  tokenHashClaim,
  verifyJws,
} from "../src/primitives/jwk.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const OTHER = "another secret of 32 characters!";
const ALGS: JwsAlg[] = ["EdDSA", "ES256"];
const enc = new TextEncoder();
const part = (v: unknown) => toBase64Url(enc.encode(JSON.stringify(v)));
const B64 = /^[A-Za-z0-9_-]{43}$/;

/** A key pair whose private half went through the seal and the open, as core stores it. */
async function keyFor(alg: JwsAlg, kid = `k-${alg}`) {
  const g = await generateSigningKey(alg, kid);
  const sealed = await sealPrivateKey(SECRET, kid, g.pkcs8);
  const key = await openPrivateKey(SECRET, kid, sealed, alg);
  if (!key) throw new Error("the sealed key did not open");
  return { ...g, key, kid };
}

describe("signing keys (plan 9g)", () => {
  it("generates an EdDSA and an ES256 key pair whose public JWK names kid, alg, and use, and holds no private member", async () => {
    const ed = await generateSigningKey("EdDSA", "k1");
    expect(ed.publicJwk).toEqual({
      kty: "OKP",
      crv: "Ed25519",
      x: expect.stringMatching(B64),
      kid: "k1",
      alg: "EdDSA",
      use: "sig",
    });
    const es = await generateSigningKey("ES256", "k2");
    expect(es.publicJwk).toEqual({
      kty: "EC",
      crv: "P-256",
      x: expect.stringMatching(B64),
      y: expect.stringMatching(B64),
      kid: "k2",
      alg: "ES256",
      use: "sig",
    });
    for (const k of [ed, es]) {
      expect(Object.keys(k.publicJwk)).not.toContain("d");
      expect(k.pkcs8.length).toBeGreaterThan(32);
    }
  });

  it("signs a compact JWS that jose verifies, for both algorithms", async () => {
    for (const alg of ALGS) {
      const k = await keyFor(alg);
      const token = await signJws({
        alg,
        kid: k.kid,
        typ: "JWT",
        key: k.key,
        payload: { sub: "u1", n: 1 },
      });
      const { payload, protectedHeader } = await jwtVerify(
        token,
        await importJWK(k.publicJwk, alg),
      );
      expect({ alg, payload, protectedHeader }).toEqual({
        alg,
        payload: { sub: "u1", n: 1 },
        protectedHeader: { alg, kid: k.kid, typ: "JWT" },
      });
    }
  });

  it("verifies a token that jose signed, and refuses a changed payload, another key, another kid, and alg none", async () => {
    for (const alg of ALGS) {
      const k = await keyFor(alg);
      // The same kid on another key pair: only the signature tells them apart.
      const other = await keyFor(alg, k.kid);
      const signed = await new SignJWT({ sub: "u1" })
        .setProtectedHeader({ alg, kid: k.kid, typ: "JWT" })
        .sign(k.key);
      const decoded = decodeJws(signed);
      if (!decoded) throw new Error("the jose token did not decode");
      expect({ alg, ok: await verifyJws(decoded, k.publicJwk) }).toEqual({ alg, ok: true });
      expect({ alg, ok: await verifyJws(decoded, other.publicJwk) }).toEqual({ alg, ok: false });
      expect({ alg, ok: await verifyJws(decoded, { ...k.publicJwk, kid: "another" }) }).toEqual({
        alg,
        ok: false,
      });
      const [h, p, s] = signed.split(".");
      // A key of the other algorithm under the same kid.
      const cross = await keyFor(alg === "EdDSA" ? "ES256" : "EdDSA", k.kid);
      expect({ alg, ok: await verifyJws(decoded, { ...cross.publicJwk, alg }) }).toEqual({
        alg,
        ok: false,
      });
      // The alg guard alone (final fix wave): the header names the other alg,
      // and the key's own algorithm signs the input, so the signature itself
      // verifies under this key. Only the compare of the header alg refuses it.
      const otherAlg = alg === "EdDSA" ? "ES256" : "EdDSA";
      const input = `${part({ alg: otherAlg, kid: k.kid, typ: "JWT" })}.${part({ sub: "u1" })}`;
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" },
          k.key,
          new TextEncoder().encode(input),
        ),
      );
      const forged = decodeJws(`${input}.${toBase64Url(sig)}`);
      expect(forged?.header.alg).toBe(otherAlg);
      expect(forged ? await verifyJws(forged, k.publicJwk) : "no decode").toBe(false);
      const header = decodeJws(`${part({ alg, kid: k.kid, typ: "at+jwt" })}.${p}.${s}`);
      expect(header ? await verifyJws(header, k.publicJwk) : "no decode").toBe(false);
      const changed = decodeJws(`${h}.${part({ sub: "u2" })}.${s}`);
      expect(changed ? await verifyJws(changed, k.publicJwk) : "no decode").toBe(false);
      const none = decodeJws(`${part({ alg: "none", kid: k.kid })}.${part({ sub: "u1" })}.${s}`);
      expect(none ? await verifyJws(none, k.publicJwk) : "no decode").toBe(false);
    }
  });

  it("seals the private key under the app secret and the kid: another secret, another kid, or another alg opens nothing", async () => {
    const g = await generateSigningKey("EdDSA", "k1");
    const sealed = await sealPrivateKey(SECRET, "k1", g.pkcs8);
    expect(sealed).not.toContain(toBase64Url(g.pkcs8).slice(0, 24));
    expect(await openPrivateKey(OTHER, "k1", sealed, "EdDSA")).toBeNull();
    expect(await openPrivateKey(SECRET, "k2", sealed, "EdDSA")).toBeNull();
    expect(await openPrivateKey(SECRET, "k1", sealed, "ES256")).toBeNull();
    expect(await openPrivateKey(SECRET, "k1", sealed, "EdDSA")).not.toBeNull();
  });

  it("decodes three base64url parts with a JSON object header that names alg and kid, and no crit", () => {
    const good = `${part({ alg: "EdDSA", kid: "k1", typ: "at+jwt" })}.${part({ sub: "u1" })}.c2ln`;
    expect(decodeJws(good)).toMatchObject({
      header: { alg: "EdDSA", kid: "k1", typ: "at+jwt" },
      payload: { sub: "u1" },
    });
    expect(
      decodeJws(`${part({ alg: "EdDSA", kid: "k1" })}.${part({})}.c2ln`)?.header.typ,
    ).toBeNull();
    const bad = [
      "a.b",
      "a.b.c.d",
      `${part({ alg: "EdDSA" })}.${part({})}.c2ln`,
      `${part({ alg: "EdDSA", kid: "k1", crit: ["exp"] })}.${part({})}.c2ln`,
      `${part([1])}.${part({})}.c2ln`,
      `${part({ alg: "EdDSA", kid: "k1" })}.${part("text")}.c2ln`,
      `${part({ alg: "EdDSA", kid: "k1" })}.${part({})}.c2l=`,
      "x".repeat(9000),
    ];
    for (const token of bad)
      expect({ token: token.slice(0, 40), decoded: decodeJws(token) }).toEqual({
        token: token.slice(0, 40),
        decoded: null,
      });
  });

  it("computes at_hash as the left half of SHA-256 for ES256 and of SHA-512 for EdDSA", async () => {
    // OpenID Connect Core 1.0 incorporating errata set 2, Appendix A.3: this access token has
    // the at_hash below under RS256, that is under SHA-256. Read from the appendix and
    // computed again on Node on 2026-10-13.
    expect(await tokenHashClaim("ES256", "jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y")).toBe(
      "77QmUPtjPfzWtF2AnpK9RQ",
    );
    const half = async (hash: "SHA-256" | "SHA-512") => {
      const d = new Uint8Array(await crypto.subtle.digest(hash, enc.encode("at_abc")));
      return toBase64Url(d.slice(0, d.length / 2));
    };
    expect(await tokenHashClaim("ES256", "at_abc")).toBe(await half("SHA-256"));
    expect(await tokenHashClaim("EdDSA", "at_abc")).toBe(await half("SHA-512"));
    expect(await tokenHashClaim("ES256", "at_abc")).toHaveLength(22);
    expect(await tokenHashClaim("EdDSA", "at_abc")).toHaveLength(43);
  });
});
