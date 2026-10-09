import { constantTimeEqual, fromBase64Url, toBase64Url } from "../primitives/crypto.js";

/**
 * The one place core hashes a password. A seam, so a later algorithm
 * (Argon2id, for example) can replace PBKDF2: its `verify` answers
 * `rehash: true` for a PBKDF2 hash it still accepts, and the sign-in
 * writes the new hash.
 */
export interface PasswordHashSeam {
  hash(plain: string): Promise<string>;
  /** `ok` is a match. `rehash` is true only on a match whose stored cost is below this seam's cost. */
  verify(plain: string, stored: string): Promise<{ ok: boolean; rehash: boolean }>;
  /**
   * A stored string in this seam's format, at this seam's cost, that no
   * password matches. A sign-in with no password row runs one `verify`
   * against it, so an unknown address costs the same CPU as a known one.
   * Built at seam construction, so no sign-in pays a hash to make it.
   */
  readonly dummy: string;
}

/**
 * 100000, not the 600000 that OWASP names for PBKDF2-HMAC-SHA256. The
 * workerd binary 1.20261006.1 holds "Pbkdf2 failed: iteration counts above
 * <max> are not supported" (checked with strings on 2026-10-10). The local
 * workerd accepted 600000 that day, so no test here shows the production
 * limit. Raise this only after a deployed Worker hashes at the new count;
 * stored hashes then rehash on sign-in. One hash costs more CPU than
 * Workers Free allows (10 ms); a deployment needs Workers Paid.
 */
export const PBKDF2_ITERATIONS = 100_000;
const MAX_ITERATIONS = 9_999_999;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const HEADER = "pbkdf2-sha256";
/** A 16-byte salt is 22 base64url characters; a 32-byte hash is 43. Seven digits at most bounds the CPU a stored row can ask for. */
const STORED_RE = /^pbkdf2-sha256\$([1-9][0-9]{0,6})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

/** PBKDF2-HMAC-SHA256 through Web Crypto. `bytes` is the output length. */
export async function pbkdf2Sha256(
  plain: string,
  salt: Uint8Array,
  iterations: number,
  bytes = HASH_BYTES,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(plain),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    // The cast matches seams/webauthn.ts: TypeScript 7 does not accept a plain Uint8Array as BufferSource.
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * The default seam. Tests pass a low `iterations` so each hash is fast.
 * `maxIterations` is the highest cost this seam hashes or verifies. It
 * defaults to the Workers cap (see PBKDF2_ITERATIONS): above it a deployed
 * Worker refuses the derive, and a stored row with a huge cost would ask for
 * a long derive. A stored cost above it fails closed, before any derive.
 */
export function createPbkdf2PasswordHash(
  options: { iterations?: number; maxIterations?: number } = {},
): PasswordHashSeam {
  const maxIterations = options.maxIterations ?? PBKDF2_ITERATIONS;
  const iterations = options.iterations ?? Math.min(PBKDF2_ITERATIONS, maxIterations);
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_ITERATIONS) {
    throw new Error(`tempo-auth: maxIterations must be an integer from 1 to ${MAX_ITERATIONS}`);
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > maxIterations) {
    throw new Error(
      `tempo-auth: iterations must be an integer from 1 to maxIterations (${maxIterations})`,
    );
  }
  // A random salt and a random digest: the same derive as a real row, and no
  // password matches it (the chance is 2^-256). No derive runs here.
  const dummySalt = new Uint8Array(SALT_BYTES);
  const dummyDigest = new Uint8Array(HASH_BYTES);
  crypto.getRandomValues(dummySalt);
  crypto.getRandomValues(dummyDigest);
  return {
    dummy: `${HEADER}$${iterations}$${toBase64Url(dummySalt)}$${toBase64Url(dummyDigest)}`,
    async hash(plain) {
      const salt = new Uint8Array(SALT_BYTES);
      crypto.getRandomValues(salt);
      const out = await pbkdf2Sha256(plain, salt, iterations);
      return `${HEADER}$${iterations}$${toBase64Url(salt)}$${toBase64Url(out)}`;
    },
    async verify(plain, stored) {
      const m = STORED_RE.exec(stored);
      if (!m) return { ok: false, rehash: false };
      const cost = Number(m[1] ?? "0");
      if (cost > maxIterations) return { ok: false, rehash: false };
      try {
        const out = await pbkdf2Sha256(plain, fromBase64Url(m[2] ?? ""), cost);
        const ok = constantTimeEqual(toBase64Url(out), m[3] ?? "");
        return { ok, rehash: ok && cost < iterations };
      } catch {
        // A refused derive is a failed sign-in, not a server error.
        return { ok: false, rehash: false };
      }
    },
  };
}
