/**
 * A DPoP key of a client and the proofs it signs (plan 12e Task 9, RFC
 * 9449 section 4.2). The key comes from `crypto.subtle` in the test, and
 * the thumbprint comes from this file's own code, not from core's.
 */

export type ProofAlg = "ES256" | "EdDSA" | "Ed25519" | "RS256" | "PS256";

const GEN: Record<ProofAlg, unknown> = {
  ES256: { name: "ECDSA", namedCurve: "P-256" },
  EdDSA: { name: "Ed25519" },
  Ed25519: { name: "Ed25519" },
  RS256: {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  PS256: {
    name: "RSA-PSS",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
};
const SIGN: Record<ProofAlg, unknown> = {
  ES256: { name: "ECDSA", hash: "SHA-256" },
  EdDSA: { name: "Ed25519" },
  Ed25519: { name: "Ed25519" },
  RS256: { name: "RSASSA-PKCS1-v1_5" },
  PS256: { name: "RSA-PSS", saltLength: 32 },
};
/** The thumbprint members of RFC 7638 section 3.2, in order. */
const MEMBERS: Record<string, string[]> = {
  EC: ["crv", "kty", "x", "y"],
  OKP: ["crv", "kty", "x"],
  RSA: ["e", "kty", "n"],
};
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const part = (value: unknown) => b64url(enc.encode(JSON.stringify(value)));

async function sha256(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

/** The `ath` of RFC 9449 section 4.2: the base64url SHA-256 of the token. */
export const athOf = (token: string) => sha256(token);

/** A copy of `base` with `changes` applied; a change to `undefined` removes the member. */
function changed(base: Record<string, unknown>, changes: Record<string, unknown> = {}) {
  const out = { ...base, ...changes };
  for (const [k, v] of Object.entries(changes)) if (v === undefined) delete out[k];
  return out;
}

export interface ProofInput {
  htu: string;
  iat: number;
  htm?: string;
  jti?: string;
  /** The access token of a resource request: the proof then carries its `ath`. */
  accessToken?: string;
  /** Changes to the header. */
  header?: Record<string, unknown>;
  /** Changes to the claims. */
  claims?: Record<string, unknown>;
}

export interface DpopKey {
  alg: ProofAlg;
  /** The public JWK: the members of the thumbprint only. */
  jwk: Record<string, unknown>;
  /** The RFC 7638 thumbprint of the key. */
  jkt: string;
  /** A signed proof. The default `htm` is POST and the default `jti` is 16 random bytes. */
  proof(input: ProofInput): Promise<string>;
  /** Signs `header` and `claims` as given. */
  sign(header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string>;
}

export async function dpopKey(alg: ProofAlg = "ES256"): Promise<DpopKey> {
  const pair = (await crypto.subtle.generateKey(GEN[alg] as Algorithm, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<
    string,
    unknown
  >;
  const kty = String(exported.kty);
  // The required members only, in lexicographic order: the JSON of the thumbprint.
  const jwk: Record<string, unknown> = {};
  for (const m of MEMBERS[kty] ?? []) jwk[m] = exported[m];
  const jkt = await sha256(JSON.stringify(jwk));
  const sign = async (header: Record<string, unknown>, claims: Record<string, unknown>) => {
    const input = `${part(header)}.${part(claims)}`;
    const sig = await crypto.subtle.sign(
      SIGN[alg] as Algorithm,
      pair.privateKey,
      enc.encode(input),
    );
    return `${input}.${b64url(new Uint8Array(sig))}`;
  };
  const proof = async (i: ProofInput) => {
    const random = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const header = changed({ typ: "dpop+jwt", alg, jwk }, i.header);
    const claims = changed(
      {
        jti: i.jti ?? random,
        htm: i.htm ?? "POST",
        htu: i.htu,
        iat: i.iat,
        ...(i.accessToken !== undefined ? { ath: await athOf(i.accessToken) } : {}),
      },
      i.claims,
    );
    return sign(header, claims);
  };
  return { alg, jwk, jkt, proof, sign };
}
