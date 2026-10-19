// The API after the move of the guide "From Clerk".
import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailPort,
  type StorageAdapter,
} from "@authtempo/core";
import { createLegacyPasswordHash, type LegacyFormat } from "@authtempo/legacy-hashes";

// Give `authtempo import clerk --formats` exactly this list.
export const CLERK_FORMATS: readonly LegacyFormat[] = ["bcrypt"];

export function createClerkAuth(deps: { storage: StorageAdapter; mail: MailPort; secret: string }) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    password: {
      hash: createLegacyPasswordHash({
        // Only the formats that the import brought. A row in another format never signs in.
        formats: CLERK_FORMATS,
        // New hashes, and the rehash at the first right sign-in, are PBKDF2.
        next: createPbkdf2PasswordHash(),
      }),
    },
  });
}
