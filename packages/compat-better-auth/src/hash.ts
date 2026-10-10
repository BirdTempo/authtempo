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
 * One derive needs 32 MiB and more CPU than a PBKDF2 verify. One derive runs
 * on each sign-in against a legacy row, wrong passwords included, until a
 * right sign-in rehashes the row to PBKDF2. The memory gate below bounds the
 * derives that run at once.
 */
export const nobleScrypt: ScryptFn = (password, salt) =>
  scryptAsync(password, salt, { ...SCRYPT, maxmem: MAXMEM });

/**
 * Memory gate. One derive holds 128 * r * N = 32 MiB (N=16384, r=16). A Workers
 * isolate has 128 MiB for all its requests (Workers limits page, checked
 * 2026-10-10). The derive yields between blocks, so derives from concurrent
 * sign-ins overlap, and four of them can end the isolate. That end is not a
 * throw, so no catch sees it. At most MAX_CONCURRENT derives run at once per
 * isolate (this module state). The rest wait in order. The gate never
 * refuses: a refusal would answer invalid_credentials to a right password
 * under load.
 */
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: Array<() => void> = [];

async function gated<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    // The finishing derive hands its slot to the next waiter, so `running` stays at the limit.
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    running++;
  }
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant time for equal lengths. Both inputs are 128 hex characters here.
 * Core has a `constantTimeEqual` (core/src/primitives/crypto.ts), but the
 * core package index does not export it (checked 2026-10-10). This copy
 * stays until core exports it. Then use core's: one source for one fact.
 */
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
 *
 * Timing trade: a scrypt row verifies slower than the PBKDF2 `dummy()` that
 * an unknown address costs, so the response time shows an account that is not
 * yet migrated. The tell ends for each account at its first right sign-in.
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
        const key = await gated(() =>
          scrypt(utf8.encode(plain.normalize("NFKC")), utf8.encode(m[1] ?? "")),
        );
        const ok = equalHex(toHex(key), m[2] ?? "");
        return { ok, rehash: ok };
      } catch {
        // A refused derive is a failed sign-in, not a server error.
        return { ok: false, rehash: false };
      }
    },
  };
}
