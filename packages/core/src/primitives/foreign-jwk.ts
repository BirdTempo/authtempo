import { fromBase64Url, sha256Base64Url } from "./crypto.js";
import { JWK_PRIVATE_MEMBERS, parseJws, RSA_MODULUS_BITS } from "./jwk.js";

/**
 * A JWS under a key that a client sends (plan 12e): a client assertion of
 * RFC 7523 and a DPoP proof of RFC 9449. Core never signs with these keys,
 * so the list is wider than `jwtMint.alg`. Everything runs on
 * `crypto.subtle`, with no supplier in the path.
 */

/**
 * The algs of a client key. "Ed25519" is the fully specified name of RFC
 * 9864 (October 2025), which deprecates "EdDSA". WebCrypto exports an
 * Ed25519 key with alg "Ed25519", so core takes both names (ruling 22).
 */
export type ForeignAlg = "EdDSA" | "Ed25519" | "ES256" | "RS256" | "PS256";

/** Every value of `ForeignAlg`. */
export const FOREIGN_ALGS: readonly ForeignAlg[] = ["EdDSA", "Ed25519", "ES256", "RS256", "PS256"];

/** The parts of a foreign compact JWS. A client key may have no `kid`, and a DPoP proof carries its key in `jwk`. */
export interface ForeignJws {
  header: { alg: string; kid: string | null; typ: string | null; jwk: unknown };
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

/** The members of each key type, by RFC 7638 section 3.2 and RFC 8037 section 2, in lexicographic order. */
const THUMBPRINT_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  EC: ["crv", "kty", "x", "y"],
  OKP: ["crv", "kty", "x"],
  RSA: ["e", "kty", "n"],
};
const enc = new TextEncoder();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isForeignAlg(value: unknown): value is ForeignAlg {
  return typeof value === "string" && (FOREIGN_ALGS as readonly string[]).includes(value);
}

/** EdDSA and Ed25519 name one alg (RFC 9864 section 5): the key is the same, only the name differs. */
function sameAlg(a: string, b: ForeignAlg): boolean {
  const ed = (x: string) => x === "EdDSA" || x === "Ed25519";
  return a === b || (ed(a) && ed(b));
}

/** A base64url text that decodes: a length of 1 mod 4 passes the alphabet but no decode. */
function b64(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && value.length % 4 !== 1;
}

/** The parts of a compact JWS from a client, or null. `kid` is optional; the shared parse refuses `crit`. */
export function decodeForeignJws(token: string): ForeignJws | null {
  const parsed = parseJws(token);
  if (!parsed) return null;
  const { header } = parsed;
  if (typeof header.alg !== "string") return null;
  if (header.kid !== undefined && typeof header.kid !== "string") return null;
  return {
    header: {
      alg: header.alg,
      kid: typeof header.kid === "string" ? header.kid : null,
      typ: typeof header.typ === "string" ? header.typ : null,
      jwk: header.jwk ?? null,
    },
    payload: parsed.payload,
    signingInput: parsed.signingInput,
    signature: parsed.signature,
  };
}

/**
 * True for a JWK of a key type that core reads (OKP, EC, RSA) with no
 * private member. A symmetric `oct` key is a shared secret, never a client key.
 */
export function publicMembersOnly(jwk: unknown): boolean {
  if (!isObject(jwk)) return false;
  if (jwk.kty !== "OKP" && jwk.kty !== "EC" && jwk.kty !== "RSA") return false;
  return !JWK_PRIVATE_MEMBERS.some((m) => m in jwk);
}

/**
 * True when `jwk` is a public key of `alg`: the `kty` and `crv` of the alg,
 * its members, a `use` of `sig` when present, and an `alg` of the same alg
 * when present. An RSA modulus holds at least 2048 bits (RFC 7518 section 3.3).
 */
export function keyFitsAlg(jwk: Record<string, unknown>, alg: ForeignAlg): boolean {
  if (!publicMembersOnly(jwk)) return false;
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  if (jwk.alg !== undefined && (typeof jwk.alg !== "string" || !sameAlg(jwk.alg, alg)))
    return false;
  if (alg === "EdDSA" || alg === "Ed25519")
    return jwk.kty === "OKP" && jwk.crv === "Ed25519" && b64(jwk.x);
  if (alg === "ES256") return jwk.kty === "EC" && jwk.crv === "P-256" && b64(jwk.x) && b64(jwk.y);
  return (
    jwk.kty === "RSA" &&
    b64(jwk.n) &&
    b64(jwk.e) &&
    fromBase64Url(jwk.n).length >= RSA_MODULUS_BITS / 8
  );
}

function importParams(alg: ForeignAlg): Algorithm | EcKeyImportParams | RsaHashedImportParams {
  if (alg === "EdDSA" || alg === "Ed25519") return { name: "Ed25519" };
  if (alg === "ES256") return { name: "ECDSA", namedCurve: "P-256" };
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  return { name: "RSA-PSS", hash: "SHA-256" };
}

function verifyParams(alg: ForeignAlg): Algorithm | EcdsaParams | RsaPssParams {
  if (alg === "EdDSA" || alg === "Ed25519") return { name: "Ed25519" };
  if (alg === "ES256") return { name: "ECDSA", hash: "SHA-256" };
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5" };
  // RFC 7518 section 3.5: the salt is the size of the hash.
  return { name: "RSA-PSS", saltLength: 32 };
}

/** The verify key of `jwk` for `alg`, or null when the key does not fit the alg or does not import. */
export async function importForeignKey(
  jwk: Record<string, unknown>,
  alg: ForeignAlg,
): Promise<CryptoKey | null> {
  if (!keyFitsAlg(jwk, alg)) return null;
  // The key members only: an `alg` or `key_ops` of the client must not steer the import.
  const bare: JsonWebKey =
    jwk.kty === "RSA"
      ? { kty: "RSA", n: jwk.n as string, e: jwk.e as string }
      : jwk.kty === "EC"
        ? { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string }
        : { kty: "OKP", crv: "Ed25519", x: jwk.x as string };
  try {
    return await crypto.subtle.importKey("jwk", bare, importParams(alg), false, ["verify"]);
  } catch {
    return null;
  }
}

/**
 * True when the header alg is one of `algs` and the signature verifies
 * under `jwk`. An alg outside `algs` (`none`, a MAC) answers false before
 * any import. The caller checks the `kid` and the claims.
 */
export async function verifyForeign(
  decoded: Pick<ForeignJws, "header" | "signingInput" | "signature">,
  jwk: Record<string, unknown>,
  algs: readonly ForeignAlg[],
): Promise<boolean> {
  const alg = decoded.header.alg;
  if (!isForeignAlg(alg) || !algs.includes(alg)) return false;
  const key = await importForeignKey(jwk, alg);
  if (!key) return false;
  try {
    return await crypto.subtle.verify(
      verifyParams(alg),
      key,
      decoded.signature,
      enc.encode(decoded.signingInput),
    );
  } catch {
    return false;
  }
}

/**
 * The JWK SHA-256 thumbprint of RFC 7638 section 3, or null for a key type
 * with no rule or a missing member. The JSON holds the required members in
 * lexicographic order with no whitespace.
 */
export async function jwkThumbprint(jwk: Record<string, unknown>): Promise<string | null> {
  const members = typeof jwk.kty === "string" ? THUMBPRINT_MEMBERS[jwk.kty] : undefined;
  if (!members) return null;
  const ordered: Record<string, string> = {};
  for (const m of members) {
    const v = jwk[m];
    if (typeof v !== "string") return null;
    ordered[m] = v;
  }
  return sha256Base64Url(JSON.stringify(ordered));
}
