import { openSealed, seal } from "./aead.js";
import { fromBase64Url, toBase64Url } from "./crypto.js";

/**
 * Signing keys and compact JWS on `crypto.subtle` (plan 9g, spec 8.12). No
 * supplier is in the signing path: jose stays behind `seams/jwt.ts` for the
 * ID tokens of other issuers. EdDSA is Ed25519 (RFC 8037). ES256 is ECDSA
 * P-256 with SHA-256 and the 64-byte r||s signature (RFC 7518 section 3.4),
 * which is the form `crypto.subtle.sign` answers. RS256 is RSASSA-PKCS1-v1_5
 * with SHA-256 and a 2048-bit key (RFC 7518 section 3.3), for an OIDC client
 * that needs it (plan 12e, owner decision 1).
 */

export type JwsAlg = "EdDSA" | "ES256" | "RS256";

/** Every value of `jwtMint.alg`: the one list that the config, the CLI check, and the verifier read. */
export const JWS_ALGS: readonly JwsAlg[] = ["EdDSA", "ES256", "RS256"];

/** RFC 7518 section 3.3: 2048 bits or larger. Larger costs more CPU per signature on Workers. */
export const RSA_MODULUS_BITS = 2048;

/** A retired key verifies this long after its retirement and then goes (the sweep). */
export const RETIRED_KEY_MS = 86_400_000;

/**
 * The retired keys the JWKS lists at most. Two live versions of an app with
 * different secrets or algs retire a key at each mint, so the list can grow
 * by one key per mint for 24 hours; the bound keeps the newest (Task 3 review).
 * Here since plan 11d, so the credentials entry exports it with no engine module:
 * the verifier caps a key set at this bound plus the signing key.
 */
export const JWKS_RETIRED_MAX = 100;

/** Three base64url parts: the shape of a compact JWS, and of nothing core issues otherwise. */
export const JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface OkpPublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}

export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
}

export interface RsaPublicJwk {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  alg: "RS256";
  use: "sig";
}

export type PublicJwk = OkpPublicJwk | EcPublicJwk | RsaPublicJwk;

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
/**
 * The private members of a JWK (RFC 7518 sections 6.2.2, 6.3.2, and 6.4). A public key holds none.
 * One list for core, the CLI check, and the verifier.
 */
export const JWK_PRIVATE_MEMBERS: readonly string[] = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
const enc = new TextEncoder();

function keyAlgorithm(alg: JwsAlg): Algorithm | EcKeyImportParams | RsaHashedImportParams {
  if (alg === "EdDSA") return { name: "Ed25519" };
  if (alg === "ES256") return { name: "ECDSA", namedCurve: "P-256" };
  return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
}

function signAlgorithm(alg: JwsAlg): Algorithm | EcdsaParams {
  if (alg === "EdDSA") return { name: "Ed25519" };
  if (alg === "ES256") return { name: "ECDSA", hash: "SHA-256" };
  return { name: "RSASSA-PKCS1-v1_5" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The public JWK of an exported key. It copies the public members only, so no private member leaves. */
function publicJwkOf(jwk: JsonWebKey, alg: JwsAlg, kid: string): PublicJwk {
  if (alg === "RS256") {
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string")
      throw new Error("authtempo: the public key has no n or e");
    return { kty: "RSA", n: jwk.n, e: jwk.e, kid, alg, use: "sig" };
  }
  if (typeof jwk.x !== "string") throw new Error("authtempo: the public key has no x");
  if (alg === "EdDSA") return { kty: "OKP", crv: "Ed25519", x: jwk.x, kid, alg, use: "sig" };
  if (typeof jwk.y !== "string") throw new Error("authtempo: the public key has no y");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg, use: "sig" };
}

/**
 * True for a public signing key of one of the three algs. It has a string
 * `kid`, `use` `sig`, and the members of its `kty` with its `alg`. It holds no
 * private member. An RSA modulus must hold at least 2048 bits (RFC 7518 section 3.3).
 * A JWK type is a compile-time type only, so a key from outside core comes through here.
 */
export function isPublicJwk(value: unknown): value is PublicJwk {
  if (!isObject(value)) return false;
  if (typeof value.kid !== "string" || value.use !== "sig") return false;
  if (JWK_PRIVATE_MEMBERS.some((m) => m in value)) return false;
  // A length of 1 mod 4 passes the alphabet, but no base64 text has it, and the decode throws.
  const b64 = (v: unknown): v is string =>
    typeof v === "string" && PART_RE.test(v) && v.length % 4 !== 1;
  if (value.kty === "OKP") return value.crv === "Ed25519" && value.alg === "EdDSA" && b64(value.x);
  if (value.kty === "EC")
    return value.crv === "P-256" && value.alg === "ES256" && b64(value.x) && b64(value.y);
  if (value.kty === "RSA")
    return (
      value.alg === "RS256" &&
      b64(value.n) &&
      b64(value.e) &&
      fromBase64Url(value.n).length >= RSA_MODULUS_BITS / 8
    );
  return false;
}

/** A new key pair. The public half as a JWK with `kid`, `alg`, and `use`; the private half as PKCS#8. */
export async function generateSigningKey(alg: JwsAlg, kid: string): Promise<GeneratedKey> {
  const params: Algorithm | EcKeyGenParams | RsaHashedKeyGenParams =
    alg === "RS256"
      ? {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: RSA_MODULUS_BITS,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        }
      : keyAlgorithm(alg);
  const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
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
  if (jwk.kty === "OKP") return { kty: "OKP", crv: jwk.crv, x: jwk.x };
  if (jwk.kty === "EC") return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
  return { kty: "RSA", n: jwk.n, e: jwk.e };
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
 * RS256: the section names it; SHA-256 is normative.
 */
export async function tokenHashClaim(alg: JwsAlg, token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(alg === "EdDSA" ? "SHA-512" : "SHA-256", enc.encode(token)),
  );
  return toBase64Url(digest.slice(0, digest.length / 2));
}
