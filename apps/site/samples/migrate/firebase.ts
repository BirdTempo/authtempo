// The API after the move of the guide "From Firebase Auth".
import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailPort,
  type StorageAdapter,
} from "@authtempo/core";
import { createLegacyPasswordHash, type LegacyFormat } from "@authtempo/legacy-hashes";

// Give `authtempo import firebase --formats` exactly this list.
export const FIREBASE_FORMATS: readonly LegacyFormat[] = ["firescrypt"];

/** The two hash parameters of the Firebase console. Read them from your secret store. The placeholders only build the config. */
export interface FirebaseEnv {
  /** The base64 signer key. */
  FIREBASE_SIGNER_KEY: string;
  /** The base64 salt separator. */
  FIREBASE_SALT_SEPARATOR: string;
}

const PLACEHOLDERS: FirebaseEnv = {
  FIREBASE_SIGNER_KEY: "cGxhY2Vob2xkZXItc2lnbmVyLWtleQ==",
  FIREBASE_SALT_SEPARATOR: "AA==",
};

export function createFirebaseAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  env: FirebaseEnv = PLACEHOLDERS,
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
        formats: FIREBASE_FORMATS,
        // Only for firescrypt: the signer key and the salt separator of the project.
        firebase: {
          signerKey: env.FIREBASE_SIGNER_KEY,
          saltSeparator: env.FIREBASE_SALT_SEPARATOR,
        },
        // New hashes, and the rehash at the first right sign-in, are PBKDF2.
        next: createPbkdf2PasswordHash(),
      }),
    },
  });
}
