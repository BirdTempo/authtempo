import { LEGACY_VERIFY_HASH } from "@authtempo/core";
import { VECTORS } from "@authtempo/legacy-hashes/testing";
import type { ImportPasskey, ImportRecord, Source } from "../../src/types.js";

/**
 * The storage matrix fixture: one record of each kind the importer writes.
 * Each record is one that a reader yields:
 * - ada: a bcrypt hash and a Google identity (the Supabase reader).
 * - fire: a `$firescrypt$` hash (the Supabase reader with the Firebase project
 *   config, or the Firebase reader).
 * - cog: the legacy-verify marker and no hash (the Cognito reader).
 * - pk: a passkey, the relying party id confirmed (the Auth.js reader).
 * - bob: unverified, with one bcrypt hash (a password sign-up).
 * - one organization with members in three roles (the Clerk reader).
 * The Source is named `authjs`, because the importer keeps a passkey only
 * from the Auth.js reader. Run it with `legacyVerify: true`, or the marker is refused.
 */
export const PASSKEY: ImportPasskey = {
  // base64url of "cred-matrix-1".
  credentialId: "Y3JlZC1tYXRyaXgtMQ",
  // base64url with "-" and "_" and no padding, so the mapping's base64 codec has work to do.
  publicKey: "pQECAyYg-_8",
  counter: 7,
  transports: "internal,hybrid",
  deviceType: "multiDevice",
  backedUp: true,
  name: "Laptop",
};
/** PASSKEY.publicKey in standard base64, as Better Auth stores it. */
export const PASSKEY_PUBLIC_KEY_STD = "pQECAyYg+/8=";
export const GOOGLE_SUBJECT = "109876543210";
export const MARKER = LEGACY_VERIFY_HASH;
export const HASHES = {
  ada: VECTORS.bcrypt2a.stored,
  fire: VECTORS.firescrypt.stored,
  bob: VECTORS.bcrypt2b.stored,
} as const;

const created = new Date("2025-01-01T00:00:00.000Z");

function user(
  sourceId: string,
  emailVerified: boolean,
  password: { hash: string } | null,
  over: { identities?: { provider: string; subject: string }[]; passkeys?: ImportPasskey[] } = {},
): ImportRecord {
  return {
    kind: "user",
    sourceId,
    email: `${sourceId}@example.com`,
    emailVerified,
    name: null,
    image: null,
    createdAt: created,
    identities: over.identities ?? [],
    password,
    passkeys: over.passkeys ?? [],
  };
}

export const MATRIX_RECORDS: readonly ImportRecord[] = [
  user(
    "ada",
    true,
    { hash: HASHES.ada },
    {
      identities: [{ provider: "google", subject: GOOGLE_SUBJECT }],
    },
  ),
  user("fire", true, { hash: HASHES.fire }),
  user("cog", true, { hash: MARKER }),
  user("pk", true, null, { passkeys: [PASSKEY] }),
  user("bob", false, { hash: HASHES.bob }),
  {
    kind: "organization",
    sourceId: "org_matrix",
    name: "Matrix Org",
    slug: null,
    createdAt: created,
    members: [
      { userSourceId: "ada", roles: ["owner"] },
      { userSourceId: "pk", roles: ["admin"] },
      { userSourceId: "cog", roles: ["member"] },
    ],
  },
];

export function matrixSource(): Source {
  return {
    name: "authjs",
    roles: {},
    async *records() {
      yield* MATRIX_RECORDS;
    },
  };
}
