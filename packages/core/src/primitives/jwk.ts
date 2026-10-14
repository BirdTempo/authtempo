import { openSealed, seal } from "./aead.js";
import { fromBase64Url, toBase64Url } from "./crypto.js";

/**
 * Signing keys and compact JWS on `crypto.subtle` (plan 9g, spec 8.12). No
 * supplier is in the signing path: jose stays behind `seams/jwt.ts` for the
 * ID tokens of other issuers. EdDSA is Ed25519 (RFC 8037). ES256 is ECDSA
 * P-256 with SHA-256 and the 64-byte r||s signature (RFC 7518 section 3.4),
 * which is the form `crypto.subtle.sign` answers.
 */

export type JwsAlg = "EdDSA" | "ES256";

/** A retired key verifies this long after its retirement and then goes (the sweep). */
export const RETIRED_KEY_MS = 86_400_000;

/** Three base64url parts: the shape of a compact JWS, and of nothing core issues otherwise. */
export const JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface PublicJwk {
  kty: "OKP" | "EC";
  crv: "Ed25519" | "P-256";
  x: string;
  y?: string;
  kid: string;
  alg: JwsAlg;
  use: "sig";
}

export interface GeneratedKey {
  publicJwk: PublicJwk;
  /** The private key as PKCS#8. Seal it before it leaves the call. */
  pkcs8: Uint8Array<ArrayBuffer>;
}

export interface DecodedJws {
  header: { alg: string; kid: string; typ: string | null };
  payload: Record<string, unknown>;
  /** The first two parts, as signed. */
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

const SEAL_INFO = "tempo-auth jwk";
/** A token core issues is far shorter. The cap bounds the parse of a stranger's bearer. */
const TOKEN_MAX = 8192;
const PART_RE = /^[A-Za-z0-9_-]+$/;
const enc = new TextEncoder();

function keyAlgorithm(alg: JwsAlg): Algorithm | EcKeyImportParams {
  return alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" };
}

function signAlgorithm(alg: JwsAlg): Algorithm | EcdsaParams {
  return alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicJwkOf(jwk: JsonWebKey, alg: JwsAlg, kid: string): PublicJwk {
  if (typeof jwk.x !== "string") throw new Error("authtempo: the public key has no x");
  if (alg === "EdDSA") return { kty: "OKP", crv: "Ed25519", x: jwk.x, kid, alg, use: "sig" };
  if (typeof jwk.y !== "string") throw new Error("authtempo: the public key has no y");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg, use: "sig" };
}

/** A new key pair. The public half as a JWK with `kid`, `alg`, and `use`; the private half as PKCS#8. */
export async function generateSigningKey(alg: JwsAlg, kid: string): Promise<GeneratedKey> {
  const pair = (
    alg === "EdDSA"
      ? await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
      : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
          "sign",
          "verify",
        ])
  ) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  return { publicJwk: publicJwkOf(jwk, alg, kid), pkcs8 };
}

/** The PKCS#8 bytes sealed under the app secret, bound to the `kid`: a value copied to another row does not open. */
export function sealPrivateKey(secret: string, kid: string, pkcs8: Uint8Array): Promise<string> {
  return seal(secret, SEAL_INFO, pkcs8, kid);
}

/** The PKCS#8 bytes, or null: another secret, another kid, or a changed byte. The engine reseals them (plan 12b). */
export function openPrivateKeyBytes(
  secret: string,
  kid: string,
  sealed: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  return openSealed(secret, SEAL_INFO, sealed, kid);
}

/** A signing key of `alg` from PKCS#8 bytes, or null when the bytes are another alg. */
export async function importPrivateKey(
  pkcs8: Uint8Array<ArrayBuffer>,
  alg: JwsAlg,
): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey("pkcs8", pkcs8, keyAlgorithm(alg), false, ["sign"]);
  } catch {
    return null;
  }
}

/** The private key for one signature, or null: another secret, another kid, another alg, or a changed byte. */
export async function openPrivateKey(
  secret: string,
  kid: string,
  sealed: string,
  alg: JwsAlg,
): Promise<CryptoKey | null> {
  const pkcs8 = await openPrivateKeyBytes(secret, kid, sealed);
  return pkcs8 ? importPrivateKey(pkcs8, alg) : null;
}

/** A compact JWS with the header `{ alg, kid, typ }`. The payload goes in as given. */
export async function signJws(input: {
  alg: JwsAlg;
  kid: string;
  typ: string;
  key: CryptoKey;
  payload: Record<string, unknown>;
}): Promise<string> {
  const head = toBase64Url(
    enc.encode(JSON.stringify({ alg: input.alg, kid: input.kid, typ: input.typ })),
  );
  const body = toBase64Url(enc.encode(JSON.stringify(input.payload)));
  const signingInput = `${head}.${body}`;
  const sig = await crypto.subtle.sign(
    signAlgorithm(input.alg),
    input.key,
    enc.encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * The parts of a compact JWS, or null. The header must be a JSON object
 * with a string `alg` and `kid`, and no `crit`: core understands no
 * critical header parameter (RFC 7515 section 4.1.11). Nothing is verified here.
 */
export function decodeJws(token: string): DecodedJws | null {
  if (token.length > TOKEN_MAX) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h = "", p = "", s = ""] = parts;
  if (!PART_RE.test(h) || !PART_RE.test(p) || !PART_RE.test(s)) return null;
  try {
    const dec = new TextDecoder("utf-8", { fatal: true });
    const header: unknown = JSON.parse(dec.decode(fromBase64Url(h)));
    const payload: unknown = JSON.parse(dec.decode(fromBase64Url(p)));
    if (!isObject(header) || !isObject(payload)) return null;
    if (typeof header.alg !== "string" || typeof header.kid !== "string") return null;
    if (header.crit !== undefined) return null;
    return {
      header: {
        alg: header.alg,
        kid: header.kid,
        typ: typeof header.typ === "string" ? header.typ : null,
      },
      payload,
      signingInput: `${h}.${p}`,
      signature: fromBase64Url(s) as Uint8Array<ArrayBuffer>,
    };
  } catch {
    return null;
  }
}

function jwkForImport(jwk: PublicJwk): JsonWebKey {
  // `y ?? ""`: every EC key that core writes has `y` (`publicJwkOf`). A row
  // without it imports as an empty coordinate, which `importKey` refuses, so
  // the verify answers false: the fallback only satisfies the type.
  return jwk.kty === "OKP"
    ? { kty: "OKP", crv: jwk.crv, x: jwk.x }
    : { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y ?? "" };
}

/** True when the header names this key's alg and kid and the signature verifies under it. */
export async function verifyJws(decoded: DecodedJws, jwk: PublicJwk): Promise<boolean> {
  if (decoded.header.alg !== jwk.alg || decoded.header.kid !== jwk.kid) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwkForImport(jwk),
      keyAlgorithm(jwk.alg),
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      signAlgorithm(jwk.alg),
      key,
      decoded.signature,
      enc.encode(decoded.signingInput),
    );
  } catch {
    return false;
  }
}

/**
 * The `at_hash` of an ID token (OIDC Core 1.0 section 3.1.3.6, read
 * 2026-10-13): the left half of the hash of the ASCII access token, as
 * base64url. SHA-256 for ES256. SHA-512 for EdDSA, the hash inside Ed25519:
 * the section names RS256 only, so this choice is unverified (plan 9g).
 */
export async function tokenHashClaim(alg: JwsAlg, token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(alg === "EdDSA" ? "SHA-512" : "SHA-256", enc.encode(token)),
  );
  return toBase64Url(digest.slice(0, digest.length / 2));
}
