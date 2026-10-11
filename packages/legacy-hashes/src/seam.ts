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
 * - A throw in a derive is a failed sign-in, not a server error.
 * `hash` and `dummy` are `next`'s, so no new row is ever a legacy format.
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
      if (!parsed || !enabled.has(parsed.format) || plain.length === 0) {
        await next.verify(plain, await next.dummy());
        return { ok: false, rehash: false };
      }
      try {
        const ok = await gated(() => verifyParsed(derives, plain, parsed, firebase));
        return { ok, rehash: ok };
      } catch {
        return { ok: false, rehash: false };
      }
    },
  };
}
