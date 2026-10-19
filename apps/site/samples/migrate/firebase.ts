// The API after the move of the guide "From Firebase Auth".
import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailPort,
  type StorageAdapter,
} from "@authtempo/core";
import { createLegacyPasswordHash, type LegacyFormat } from "@authtempo/legacy-hashes";
import { FIREBASE } from "@authtempo/legacy-hashes/testing";

// Give `authtempo import firebase --formats` exactly this list.
export const FIREBASE_FORMATS: readonly LegacyFormat[] = ["firescrypt"];

export function createFirebaseAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    password: {
      hash: createLegacyPasswordHash({
        // Only the formats that the import brought. A row in another format never signs in.
        formats: FIREBASE_FORMATS,
        // The signer key and the salt separator of the Firebase console. These are the test
        // values of the firebase/scrypt README. The app reads its own two from its secrets.
        firebase: { signerKey: FIREBASE.signerKey, saltSeparator: FIREBASE.saltSeparator },
        // New hashes, and the rehash at the first right sign-in, are PBKDF2.
        next: createPbkdf2PasswordHash(),
      }),
    },
  });
}
