import type { PasswordHashSeam } from "@tempo-auth/core";
import {
  type Derives,
  decodeFirebase,
  type FirebaseHashConfig,
  NOBLE_DERIVES,
  verifyParsed,
} from "./derive.js";
import { gated } from "./gate.js";
import { LEGACY_FORMATS, type LegacyFormat, parseLegacyHash } from "./grammar.js";

/**
 * bcrypt reads only the first 72 bytes of the UTF-8 password (bcryptjs
 * 3.0.3 `truncates`, read 2026-10-11). A longer password matches with any
 * text after byte 72. A rehash would then write a hash of the text the user
 * typed this time, and the password the user knows would stop working if
 * the tail had an error. So a match on a longer password keeps the bcrypt
 * row: it answers `{ ok: true, rehash: false }`.
 */
export const BCRYPT_MAX_PASSWORD_BYTES = 72;

export interface LegacyPasswordHashOptions {
  /** The formats this app verifies. A stored string in another format verifies against the dummy and fails. */
  formats: readonly LegacyFormat[];
  /** Needed for `firescrypt`. Without it `firescrypt` in `formats` is a construction error. */
  firebase?: FirebaseHashConfig;
  /** The seam after this one: core's PBKDF2 (`createPbkdf2PasswordHash()`), or `betterAuthPasswordHash()`. It makes every new hash and the dummy. */
  next: PasswordHashSeam;
  /** For tests: the derive primitives. Default `NOBLE_DERIVES`. */
  derives?: Derives;
}

/**
 * The hash seam for an app whose users came from another auth provider
 * (spec 17.2). Chained before `next`, as `betterAuthPasswordHash` is:
 * - A stored string that does not start with `$` goes to `next` unchanged.
 * - A string in an enabled format runs one full derive in the gate and
 *   answers `{ ok, rehash: ok }`, so plan 8's sign-in writes `next`'s hash
 *   on the first right sign-in.
 * - Any other string that starts with `$` (an unknown tag, a bound broken,
 *   a format not enabled, a malformed segment) answers `{ ok: false,
 *   rehash: false }` after one `next.verify` against `next.dummy()`, with
 *   no legacy derive. So it costs what a wrong password costs.
 * - A `firescrypt` hash whose length is not the signer key's length cannot
 *   match. It costs the dummy as a malformed string does.
 * - A bcrypt match on a password longer than 72 bytes answers
 *   `rehash: false` (see `BCRYPT_MAX_PASSWORD_BYTES`).
 * - A throw in a derive is a failed sign-in, not a server error.
 * `hash` and `dummy` are `next`'s, so no new row is ever a legacy format.
 *
 * The password goes to the derive as its raw UTF-8 bytes, with no Unicode
 * normalization. Of the sources, only Better Auth applies NFKC (its seam is
 * plan 9's). Supabase (Go bcrypt), Firebase (firebase/scrypt), and Ory hash
 * the raw bytes, so NFKC here would refuse a right password.
 *
 * The gate is per isolate (module state in `gate.ts`), and every seam of
 * this package shares it. The Better Auth seam of plan 9 has its own gate.
 * Chained with `betterAuthPasswordHash()` as `next`, the two gates of two
 * each let up to four derives (128 MiB at the worst) run at once in one
 * isolate. One shared gate is an input for a later plan.
 */
export function createLegacyPasswordHash(options: LegacyPasswordHashOptions): PasswordHashSeam {
  const enabled = new Set<LegacyFormat>();
  for (const f of options.formats) {
    if (!LEGACY_FORMATS.includes(f))
      throw new Error(`tempo-auth legacy-hashes: unknown format ${String(f)}`);
    enabled.add(f);
  }
  if (enabled.has("firescrypt") && !options.firebase)
    throw new Error("tempo-auth legacy-hashes: the firescrypt format needs the firebase option");
  const firebase = options.firebase ? decodeFirebase(options.firebase) : null;
  const derives = options.derives ?? NOBLE_DERIVES;
  const { next } = options;
  return {
    hash: (plain) => next.hash(plain),
    dummy: () => next.dummy(),
    async verify(plain, stored) {
      if (!stored.startsWith("$")) return next.verify(plain, stored);
      const parsed = parseLegacyHash(stored);
      if (
        !parsed ||
        !enabled.has(parsed.format) ||
        plain.length === 0 ||
        (parsed.format === "firescrypt" && parsed.hash.length !== firebase?.signerKey.length)
      ) {
        await next.verify(plain, await next.dummy());
        return { ok: false, rehash: false };
      }
      try {
        const ok = await gated(() => verifyParsed(derives, plain, parsed, firebase));
        const truncated =
          parsed.format === "bcrypt" &&
          new TextEncoder().encode(plain).length > BCRYPT_MAX_PASSWORD_BYTES;
        return { ok, rehash: ok && !truncated };
      } catch {
        return { ok: false, rehash: false };
      }
    },
  };
}
