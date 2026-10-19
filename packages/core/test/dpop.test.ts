import { describe, expect, it } from "vitest";
import { checkDpopProof, DPOP_TYP, type DpopCheckInput } from "../src/primitives/dpop.js";
import { type DpopKey, dpopKey, type ProofInput } from "./support/dpop-key.js";

/**
 * The checks of RFC 9449 section 4.3 (read 2026-10-20), one test each. Each
 * proof is the good one with one change. The nonce check (item 10) has no
 * test: core gives no nonce, so no proof needs one.
 */

const URL_ = "https://api.example.com/auth/oauth/token";
const NOW = 1_800_000_000;
const ALL = ["EdDSA", "Ed25519", "ES256", "RS256", "PS256"] as const;
const TOKEN = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiIxIn0.c2ln";

let shared: Promise<DpopKey> | null = null;
const key = () => {
  shared ??= dpopKey("ES256");
  return shared;
};

function input(proof: string, extra: Partial<DpopCheckInput> = {}): DpopCheckInput {
  return {
    proof,
    method: "POST",
    url: URL_,
    algs: ALL,
    windowSeconds: 60,
    nowSeconds: NOW,
    ...extra,
  };
}

async function check(change: Partial<ProofInput> = {}, extra: Partial<DpopCheckInput> = {}) {
  const k = await key();
  return checkDpopProof(input(await k.proof({ htu: URL_, iat: NOW, ...change }), extra));
}

const refused = (reason: string) => ({ ok: false, reason });

describe("checkDpopProof (RFC 9449 section 4.3)", () => {
  it("passes a good proof and answers its thumbprint", async () => {
    const k = await key();
    expect(DPOP_TYP).toBe("dpop+jwt");
    const proof = await k.proof({ htu: URL_, iat: NOW, jti: "jti-1" });
    expect(await checkDpopProof(input(proof))).toEqual({
      ok: true,
      jkt: k.jkt,
      jti: "jti-1",
      iat: NOW,
    });
    // Each alg of the list, also the two names of Ed25519 (RFC 9864).
    for (const alg of ["EdDSA", "Ed25519", "RS256", "PS256"] as const) {
      const other = await dpopKey(alg);
      const r = await checkDpopProof(input(await other.proof({ htu: URL_, iat: NOW })));
      expect({ alg, r }).toMatchObject({ alg, r: { ok: true, jkt: other.jkt } });
    }
  });

  it("refuses two DPoP headers", async () => {
    const k = await key();
    const a = await k.proof({ htu: URL_, iat: NOW });
    const b = await k.proof({ htu: URL_, iat: NOW });
    // Headers.get joins two fields of one name with a comma and a space.
    expect(await checkDpopProof(input(`${a}, ${b}`))).toEqual(refused("two DPoP headers"));
    expect(await checkDpopProof(input(`${a},${b}`))).toEqual(refused("two DPoP headers"));
  });

  it("refuses a proof that is not one compact JWS", async () => {
    const good = await (await key()).proof({ htu: URL_, iat: NOW });
    for (const proof of [
      "",
      "abc",
      good.split(".").slice(0, 2).join("."),
      `${good}.e30`,
      `${good} `,
    ])
      expect({ proof, r: await checkDpopProof(input(proof)) }).toEqual({
        proof,
        r: refused("not one compact JWS"),
      });
  });

  it("refuses a typ other than dpop+jwt", async () => {
    for (const typ of [undefined, "JWT", "at+jwt", "DPOP+JWT", 7])
      expect({ typ, r: await check({ header: { typ } }) }).toEqual({
        typ,
        r: refused("typ is not dpop+jwt"),
      });
  });

  it("refuses an alg outside the list, none, and a MAC", async () => {
    expect(await check({}, { algs: ["EdDSA", "RS256"] })).toEqual(refused("alg is not accepted"));
    for (const alg of ["none", "HS256", "ES384", "es256"])
      expect({ alg, r: await check({ header: { alg } }) }).toEqual({
        alg,
        r: refused("alg is not accepted"),
      });
  });

  it("refuses a jwk with a private member", async () => {
    const k = await key();
    for (const jwk of [{ ...k.jwk, d: "AAAA" }, { kty: "oct", k: "AAAA" }, undefined, "not a key"])
      expect({ jwk, r: await check({ header: { jwk } }) }).toEqual({
        jwk,
        r: refused("jwk is not a public key"),
      });
  });

  it("refuses a bad signature", async () => {
    const other = await dpopKey("ES256");
    // Signed by the shared key, with the public key of another.
    expect(await check({ header: { jwk: other.jwk } })).toEqual(
      refused("signature does not verify"),
    );
    // A key that does not fit the alg.
    const ed = await dpopKey("EdDSA");
    expect(await check({ header: { jwk: ed.jwk } })).toEqual(refused("signature does not verify"));
  });

  it("refuses a missing or long jti", async () => {
    for (const jti of [undefined, "", 7, "j".repeat(257)])
      expect({ jti, r: await check({ claims: { jti } }) }).toEqual({
        jti,
        r: refused("jti is missing or too long"),
      });
    expect(await check({ jti: "j".repeat(256) })).toMatchObject({ ok: true });
  });

  it("refuses htm other than the method", async () => {
    for (const htm of [undefined, "GET", "post", ""])
      expect({ htm, r: await check({ claims: { htm } }) }).toEqual({
        htm,
        r: refused("htm is not the method"),
      });
    expect(await check({ htm: "GET" }, { method: "GET" })).toMatchObject({ ok: true });
  });

  it("refuses htu other than the URL with no query and no fragment", async () => {
    for (const htu of [
      undefined,
      "",
      "not a url",
      "https://api.example.com/auth/oauth/token/x",
      "https://api.example.com/auth/oauth",
      "http://api.example.com/auth/oauth/token",
      "https://other.example.com/auth/oauth/token",
      "https://api.example.com:8443/auth/oauth/token",
    ])
      expect({ htu, r: await check({ claims: { htu } }) }).toEqual({
        htu,
        r: refused("htu is not the URL"),
      });
    // The query and the fragment of both sides do not count, and the URL is normalized.
    for (const [htu, url] of [
      ["https://api.example.com/auth/oauth/token?a=1#f", URL_],
      [URL_, `${URL_}?b=2`],
      ["HTTPS://API.example.com:443/auth/oauth/token", URL_],
    ] as const)
      expect({ htu, url, r: await check({ htu }, { url }) }).toMatchObject({
        htu,
        url,
        r: { ok: true },
      });
  });

  it("refuses an iat outside the window", async () => {
    for (const iat of [NOW - 61, NOW + 61, "1800000000", undefined, Number.NaN])
      expect({ iat, r: await check({ claims: { iat } }) }).toEqual({
        iat,
        r: refused("iat is outside the window"),
      });
    for (const iat of [NOW - 60, NOW + 60, NOW + 0.5])
      expect({ iat, r: await check({ iat }) }).toMatchObject({ iat, r: { ok: true } });
    expect(await check({ iat: NOW - 200 }, { windowSeconds: 300 })).toMatchObject({ ok: true });
  });

  it("refuses a missing or wrong ath with an access token", async () => {
    expect(await check({}, { accessToken: TOKEN })).toEqual(refused("ath is not the token hash"));
    expect(await check({ accessToken: `${TOKEN}x` }, { accessToken: TOKEN })).toEqual(
      refused("ath is not the token hash"),
    );
    expect(await check({ accessToken: TOKEN }, { accessToken: TOKEN })).toMatchObject({ ok: true });
    // The token endpoint passes no token, so an ath there is not read.
    expect(await check({ accessToken: TOKEN })).toMatchObject({ ok: true });
  });

  it("refuses a key whose thumbprint is not the token's cnf.jkt", async () => {
    const k = await key();
    const other = await dpopKey("ES256");
    const at = { accessToken: TOKEN };
    expect(await check(at, { ...at, jkt: other.jkt })).toEqual(refused("key is not the token key"));
    expect(await check(at, { ...at, jkt: k.jkt })).toMatchObject({ ok: true, jkt: k.jkt });
  });
});
