import { scryptAsync } from "@noble/hashes/scrypt.js";
import { createPbkdf2PasswordHash, type PasswordHashSeam } from "@tempo-auth/core";

/**
 * Better Auth 1.7's scrypt (@better-auth/utils 0.4.2 password.mjs, read
 * 2026-10-10). The stored form is `<32 hex salt>:<128 hex key>`, all
 * lowercase. The salt is used as text, not decoded. The password is NFKC
 * normalized first. maxmem is Better Auth's own bound, 64 MiB.
 */
export const SCRYPT = { N: 16384, r: 16, p: 1, dkLen: 64 } as const;
const MAXMEM = 128 * SCRYPT.N * SCRYPT.r * 2;
const BETTER_AUTH_RE = /^([0-9a-f]{32}):([0-9a-f]{128})$/;
const PBKDF2_HEADER = "pbkdf2-sha256$";

export type ScryptFn = (password: Uint8Array, salt: Uint8Array) => Promise<Uint8Array>;

/**
 * Pure JavaScript, so a Worker needs no nodejs_compat (plan 9 deviation 3).
 * One derive needs 32 MiB and more CPU than a PBKDF2 verify; it runs once
 * per legacy user, and the sign-in then writes PBKDF2.
 */
export const nobleScrypt: ScryptFn = (password, salt) =>
  scryptAsync(password, salt, { ...SCRYPT, maxmem: MAXMEM });

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant time for equal lengths. Both inputs are 128 hex characters here. */
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The hash seam for an app that comes from Better Auth. New hashes and the
 * dummy are PBKDF2 through core's seam. `verify` reads a PBKDF2 hash by its
 * header first, then Better Auth's scrypt format, and answers `rehash: true`
 * on a scrypt match, so plan 8's sign-in writes PBKDF2. Any other stored
 * text, and an empty password, answers ok false with no derive.
 */
export function betterAuthPasswordHash(
  options: { pbkdf2?: PasswordHashSeam; scrypt?: ScryptFn } = {},
): PasswordHashSeam {
  const pbkdf2 = options.pbkdf2 ?? createPbkdf2PasswordHash();
  const scrypt = options.scrypt ?? nobleScrypt;
  const utf8 = new TextEncoder();
  return {
    hash: (plain) => pbkdf2.hash(plain),
    dummy: () => pbkdf2.dummy(),
    async verify(plain, stored) {
      if (stored.startsWith(PBKDF2_HEADER)) return pbkdf2.verify(plain, stored);
      const m = BETTER_AUTH_RE.exec(stored);
      if (!m || plain.length === 0) return { ok: false, rehash: false };
      try {
        const key = await scrypt(utf8.encode(plain.normalize("NFKC")), utf8.encode(m[1] ?? ""));
        const ok = equalHex(toHex(key), m[2] ?? "");
        return { ok, rehash: ok };
      } catch {
        // A refused derive is a failed sign-in, not a server error.
        return { ok: false, rehash: false };
      }
    },
  };
}
