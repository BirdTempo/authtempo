import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../src/primitives/crypto.js";
import {
  type DecodedJws,
  decodeJws,
  generateSigningKey,
  isPublicJwk,
  openPrivateKey,
  type PublicJwk,
  sealPrivateKey,
  signJws,
  tokenHashClaim,
  verifyJws,
} from "../src/primitives/jwk.js";
import { RFC7515_A2_HEADER, RFC7515_A2_JWS, RFC7515_A2_KEY } from "./fixtures/rfc7515-a2.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
const enc = new TextEncoder();

describe("RS256 keys (plan 12e, owner decision 1)", () => {
  it("generates an RS256 key of 2048 bits with e AQAB", async () => {
    const g = await generateSigningKey("RS256", "k1");
    expect(g.publicJwk).toEqual({
      kty: "RSA",
      n: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      e: "AQAB",
      kid: "k1",
      alg: "RS256",
      use: "sig",
    });
    const n = g.publicJwk.kty === "RSA" ? g.publicJwk.n : "";
    expect(fromBase64Url(n).length).toBe(256);
    for (const member of PRIVATE_MEMBERS) expect(Object.keys(g.publicJwk)).not.toContain(member);
  });

  it("signs and verifies RS256 through the seal", async () => {
    const g = await generateSigningKey("RS256", "k1");
    const sealed = await sealPrivateKey(SECRET, "k1", g.pkcs8);
    const key = await openPrivateKey(SECRET, "k1", sealed, "RS256");
    if (!key) throw new Error("the sealed key did not open");
    const token = await signJws({
      alg: "RS256",
      kid: "k1",
      typ: "JWT",
      key,
      payload: { sub: "u1" },
    });
    const decoded = decodeJws(token);
    if (!decoded) throw new Error("the token did not decode");
    expect(decoded.header).toEqual({ alg: "RS256", kid: "k1", typ: "JWT" });
    // An RSA signature of a 2048-bit key is 256 bytes; an ECDSA P-256 signature is 64.
    expect(decoded.signature.length).toBe(256);
    expect(await verifyJws(decoded, g.publicJwk)).toBe(true);
    // One changed byte of the signature.
    const signature = new Uint8Array(decoded.signature);
    signature[0] = (signature[0] ?? 0) ^ 1;
    expect(await verifyJws({ ...decoded, signature }, g.publicJwk)).toBe(false);
    // An EdDSA key of the same kid: the header names RS256, so the alg compare refuses it.
    const ed = await generateSigningKey("EdDSA", "k1");
    expect(await verifyJws(decoded, ed.publicJwk)).toBe(false);
  });

  it("verifies an RS256 JWS of a known vector", async () => {
    // The RFC header has no kid, and decodeJws needs one, so the test splits the JWS itself.
    const [h = "", p = "", s = ""] = RFC7515_A2_JWS.split(".");
    expect(h).toBe(RFC7515_A2_HEADER);
    const jwk: PublicJwk = { ...RFC7515_A2_KEY, kid: "rfc7515-a2", alg: "RS256", use: "sig" };
    const decoded: DecodedJws = {
      header: { alg: "RS256", kid: "rfc7515-a2", typ: null },
      payload: {},
      signingInput: `${h}.${p}`,
      signature: fromBase64Url(s) as Uint8Array<ArrayBuffer>,
    };
    expect(await verifyJws(decoded, jwk)).toBe(true);
    const changed = { ...decoded, signingInput: `${h}.${p}A` };
    expect(await verifyJws(changed, jwk)).toBe(false);
  });

  it("hashes at_hash with SHA-256 for RS256", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("at_abc")));
    const left = toBase64Url(digest.slice(0, 16));
    expect(left).toHaveLength(22);
    expect(await tokenHashClaim("RS256", "at_abc")).toBe(left);
  });

  it("refuses an RSA key with a private member or another alg", async () => {
    const rs = (await generateSigningKey("RS256", "k1")).publicJwk;
    const ed = (await generateSigningKey("EdDSA", "k2")).publicJwk;
    const es = (await generateSigningKey("ES256", "k3")).publicJwk;
    // The three public keys of core pass, so each refusal below is the rule, not the shape.
    for (const k of [rs, ed, es])
      expect({ alg: k.alg, ok: isPublicJwk(k) }).toEqual({
        alg: k.alg,
        ok: true,
      });
    for (const member of PRIVATE_MEMBERS)
      expect({ member, ok: isPublicJwk({ ...rs, [member]: "AQAB" }) }).toEqual({
        member,
        ok: false,
      });
    expect(isPublicJwk({ ...ed, d: "AQAB" })).toBe(false);
    expect(isPublicJwk({ ...es, d: "AQAB" })).toBe(false);
    expect(isPublicJwk({ ...rs, alg: "RS512" })).toBe(false);
    expect(isPublicJwk({ ...rs, alg: "EdDSA" })).toBe(false);
    expect(isPublicJwk({ ...ed, alg: "RS256" })).toBe(false);
    expect(isPublicJwk({ ...rs, use: "enc" })).toBe(false);
    expect(isPublicJwk({ ...rs, kid: 7 })).toBe(false);
    // RFC 7518 section 3.3: a key of 2048 bits or larger. 2040 bits is one byte short.
    const short = toBase64Url(fromBase64Url(rs.kty === "RSA" ? rs.n : "").slice(1));
    expect(isPublicJwk({ ...rs, n: short })).toBe(false);
    expect(isPublicJwk({ ...rs, e: "AQ+B" })).toBe(false);
  });

  it("answers false, with no throw, for a key member that is not base64url", async () => {
    const rs = (await generateSigningKey("RS256", "k1")).publicJwk;
    const ed = (await generateSigningKey("EdDSA", "k2")).publicJwk;
    // A length of 1 mod 4 passes the alphabet, and no base64 text has that length.
    const bad = [
      { ...rs, n: "A".repeat(345) },
      { ...rs, e: "A" },
      { ...rs, n: `${"A".repeat(340)}==` },
      { ...rs, n: 7 },
      { ...ed, x: "AAAAA" },
    ];
    for (const key of bad) {
      const member = JSON.stringify(key).slice(0, 40);
      expect({ member, ok: isPublicJwk(key) }).toEqual({ member, ok: false });
    }
  });
});
