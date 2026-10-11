import type { LegacyFormat } from "@tempo-auth/legacy-hashes";

/**
 * The legacy formats the example verifies, chained before PBKDF2 in index.ts.
 * The import must use this same list: a hash in a format that the Worker does
 * not verify must be refused at import, or that user can never sign in with it.
 * No firescrypt: the example has no Firebase project parameters.
 */
export const LEGACY_FORMATS: readonly LegacyFormat[] = [
  "bcrypt",
  "argon2id",
  "pbkdf2-sha256",
  "scrypt",
];
