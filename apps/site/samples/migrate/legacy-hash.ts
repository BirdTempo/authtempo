import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailPort,
  type StorageAdapter,
} from "@authtempo/core";
import {
  createLegacyPasswordHash,
  type FirebaseHashConfig,
  type LegacyFormat,
} from "@authtempo/legacy-hashes";

/**
 * The API after an import of users with password hashes. The legacy seam
 * verifies each old hash, and the first right sign-in rewrites it as PBKDF2.
 * Give `authtempo-import --formats` exactly the same list as `formats`.
 */
export function createImportedAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  formats: readonly LegacyFormat[] = ["bcrypt"],
  firebase?: FirebaseHashConfig,
) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    password: {
      hash: createLegacyPasswordHash({
        // Only the formats that the import brought. A row in another format never signs in.
        formats,
        // Only for firescrypt: the signer key and the salt separator from the Firebase console.
        ...(firebase !== undefined ? { firebase } : {}),
        // New hashes, and the rehash at the first right sign-in, are PBKDF2.
        next: createPbkdf2PasswordHash(),
      }),
    },
  });
}
