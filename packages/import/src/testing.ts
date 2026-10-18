import type { LegacyFormat } from "@authtempo/legacy-hashes";
import { FIREBASE, VECTORS } from "@authtempo/legacy-hashes/testing";
import type { ImportBundle } from "./sources.js";
import type { SourceName } from "./types.js";

/**
 * Test data only: one small fixture export per provider, from the hashes of
 * `@authtempo/legacy-hashes/testing`. The no-secret test of the CLI, the
 * guide samples of the site, and the MCP plan test read these files, so a
 * reader change and its docs test the same export. It imports no Node
 * module. It is in `src` so that the build ships it as `dist/testing.js`
 * under the entry `@authtempo/import/testing`; the main entry does not
 * import this file (plan 11f Task 1).
 *
 * Each fixture has at most three users, at least one with an address and a
 * name, in the provider's real file format (the shape of the reader's own
 * test in `test/readers/`). `secrets` names every address, every name, and
 * every hash string of the fixture, so a test can prove that no output
 * holds one of them (spec 23 item 14).
 */
export interface FixtureExport {
  bundle: ImportBundle;
  /** The `--formats` list the fixture needs: the formats of its hashes. */
  formats: readonly LegacyFormat[];
  /** True for the one provider whose users get the legacy-verify marker. */
  legacyVerify: boolean;
  /** Every address, name, and hash string of the files. */
  secrets: readonly string[];
  /** A user of the fixture that signs in with a password after the import, or null when no password moves. */
  signIn: { email: string; password: string } | null;
}

/** A CSV field as psql writes it: quoted when it holds a comma, a quote, or a line end. */
function field(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV text with a header row, one line per row, as `\copy ... with csv header` writes it. */
function csv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((r) => r.map(field).join(",")).join("\n")}\n`;
}

// The firebase/scrypt README vector: `$firescrypt$n=14,r=8,p=1$<salt>$<hash>`.
// The export writes the salt and the hash as plain base64, with no tag.
const FIRESCRYPT_PARTS = VECTORS.firescrypt.stored.split("$");
const FIRESCRYPT_PARAMS = FIRESCRYPT_PARTS[2] ?? "";
const FIRESCRYPT_SALT = FIRESCRYPT_PARTS[3] ?? "";
const FIRESCRYPT_HASH = FIRESCRYPT_PARTS[4] ?? "";
const FIRESCRYPT_MEM_COST = Number(/n=(\d+)/.exec(FIRESCRYPT_PARAMS)?.[1]);
const FIRESCRYPT_ROUNDS = Number(/r=(\d+)/.exec(FIRESCRYPT_PARAMS)?.[1]);

const SUPABASE_ADA = "11111111-1111-4111-8111-111111111111";
const SUPABASE_BOB = "22222222-2222-4222-8222-222222222222";

export const FIXTURE_EXPORTS: Readonly<Record<SourceName, FixtureExport>> = {
  // The column shape of the README's \copy select. Bob has no
  // email_confirmed_at, so he imports unverified and a claim can reach him.
  supabase: {
    bundle: {
      provider: "supabase",
      files: {
        users: csv([
          [
            "id",
            "email",
            "encrypted_password",
            "email_confirmed_at",
            "raw_user_meta_data",
            "created_at",
            "is_anonymous",
            "deleted_at",
            "banned_until",
            "is_sso_user",
          ],
          [
            SUPABASE_ADA,
            "ada@example.com",
            VECTORS.bcrypt2a.stored,
            "2024-01-15 10:30:00.123456+00",
            '{"full_name": "Ada Lovelace"}',
            "2024-01-15 10:29:00.5+00",
            "f",
            "",
            "",
            "f",
          ],
          [
            SUPABASE_BOB,
            "bob@example.com",
            VECTORS.argon2id.stored,
            "",
            '{"full_name": "Bob Ortiz"}',
            "2024-02-01 08:00:00+00",
            "f",
            "",
            "",
            "f",
          ],
        ]),
        identities: csv([
          ["provider", "provider_id", "user_id"],
          ["email", SUPABASE_ADA, SUPABASE_ADA],
          ["google", "109876543210", SUPABASE_ADA],
          ["email", SUPABASE_BOB, SUPABASE_BOB],
        ]),
      },
    },
    formats: ["bcrypt", "argon2id"],
    legacyVerify: false,
    secrets: [
      "ada@example.com",
      "bob@example.com",
      "Ada Lovelace",
      "Bob Ortiz",
      VECTORS.bcrypt2a.stored,
      VECTORS.argon2id.stored,
    ],
    signIn: { email: "ada@example.com", password: VECTORS.bcrypt2a.password },
  },
  // The dashboard CSV and the `GET /v1/users` array, joined on the user id.
  clerk: {
    bundle: {
      provider: "clerk",
      files: {
        csv: csv([
          [
            "id",
            "first_name",
            "last_name",
            "username",
            "primary_email_address",
            "primary_phone_number",
            "verified_email_addresses",
            "unverified_email_addresses",
            "verified_phone_numbers",
            "unverified_phone_numbers",
            "totp_secret",
            "password_digest",
            "password_hasher",
          ],
          [
            "user_2a",
            "Kim",
            "Lee",
            "",
            "kim@example.com",
            "",
            "kim@example.com",
            "",
            "",
            "",
            "",
            VECTORS.bcrypt2b.stored,
            "bcrypt",
          ],
        ]),
        users: JSON.stringify([
          {
            id: "user_2a",
            first_name: "Kim",
            last_name: "Lee",
            image_url: "https://img.clerk.com/kim",
            primary_email_address_id: "idn_1",
            email_addresses: [
              {
                id: "idn_1",
                email_address: "kim@example.com",
                verification: { status: "verified" },
              },
            ],
            external_accounts: [],
            password_enabled: true,
            created_at: 1700000000000,
          },
        ]),
      },
    },
    formats: ["bcrypt"],
    legacyVerify: false,
    secrets: ["kim@example.com", "Kim", "Lee", VECTORS.bcrypt2b.stored],
    signIn: { email: "kim@example.com", password: VECTORS.bcrypt2b.password },
  },
  // The user export job's NDJSON and the hash file of the support case.
  auth0: {
    bundle: {
      provider: "auth0",
      files: {
        users: `${JSON.stringify({
          user_id: "auth0|o7p6",
          email: "ann@example.com",
          email_verified: true,
          created_at: "2023-05-01T10:00:00.000Z",
          name: "Ann Field",
          identities: [
            {
              provider: "auth0",
              user_id: "o7p6",
              connection: "Username-Password-Authentication",
              isSocial: false,
            },
          ],
        })}\n`,
        hashes: `${JSON.stringify({
          _id: { $oid: "o7p6" },
          email: "ann@example.com",
          passwordHash: VECTORS.bcrypt2b.stored,
        })}\n`,
      },
    },
    formats: ["bcrypt"],
    legacyVerify: false,
    secrets: ["ann@example.com", "Ann Field", VECTORS.bcrypt2b.stored],
    signIn: { email: "ann@example.com", password: VECTORS.bcrypt2b.password },
  },
  // `firebase auth:export --format=json`: the firebase/scrypt README user.
  firebase: {
    bundle: {
      provider: "firebase",
      files: {
        users: JSON.stringify({
          users: [
            {
              localId: "fbuid1",
              email: "user1@example.com",
              emailVerified: true,
              passwordHash: FIRESCRYPT_HASH,
              salt: FIRESCRYPT_SALT,
              displayName: "User One",
              createdAt: "1600000000000",
              providerUserInfo: [],
            },
          ],
        }),
      },
      firebase: {
        signerKey: FIREBASE.signerKey,
        saltSeparator: FIREBASE.saltSeparator,
        rounds: FIRESCRYPT_ROUNDS,
        memCost: FIRESCRYPT_MEM_COST,
      },
    },
    formats: ["firescrypt"],
    legacyVerify: false,
    secrets: ["user1@example.com", "User One", FIRESCRYPT_HASH],
    signIn: { email: "user1@example.com", password: VECTORS.firescrypt.password },
  },
  // The adapter tables of the README's select, with the app's own password column.
  authjs: {
    bundle: {
      provider: "authjs",
      files: {
        tables: JSON.stringify({
          users: [
            {
              id: "cuid1",
              name: "Ida Finch",
              email: "ida@example.com",
              emailVerified: "2024-01-01T00:00:00.000Z",
              image: null,
              password: VECTORS.bcrypt2a.stored,
            },
          ],
          accounts: [],
          authenticators: [],
        }),
      },
      passwordColumn: "password",
    },
    formats: ["bcrypt"],
    legacyVerify: false,
    secrets: ["ida@example.com", "Ida Finch", VECTORS.bcrypt2a.stored],
    signIn: { email: "ida@example.com", password: VECTORS.bcrypt2a.password },
  },
  // `aws cognito-idp list-users --output json`: one CONFIRMED user. No hash
  // moves; the user gets the legacy-verify marker.
  cognito: {
    bundle: {
      provider: "cognito",
      files: {
        users: JSON.stringify({
          Users: [
            {
              Username: "c0ffee",
              Attributes: [
                { Name: "sub", Value: "sub-1" },
                { Name: "email", Value: "cara@example.com" },
                { Name: "email_verified", Value: "true" },
                { Name: "name", Value: "Cara Diaz" },
              ],
              UserCreateDate: "2023-11-14T22:13:20.000Z",
              Enabled: true,
              UserStatus: "CONFIRMED",
            },
          ],
        }),
      },
    },
    formats: [],
    legacyVerify: true,
    secrets: ["cara@example.com", "Cara Diaz"],
    signIn: null,
  },
  // The four files of the guide's curl script. No hash moves (owner decision 1).
  workos: {
    bundle: {
      provider: "workos",
      files: {
        users: JSON.stringify([
          {
            object: "user",
            id: "user_01",
            email: "wren@example.com",
            email_verified: true,
            first_name: "Wren",
            last_name: "Okafor",
            name: null,
            profile_picture_url: null,
            created_at: "2024-03-01T09:00:00.000Z",
            updated_at: "2024-03-01T09:00:00.000Z",
          },
          {
            object: "user",
            id: "user_02",
            email: "theo@example.com",
            email_verified: true,
            first_name: "Theo",
            last_name: "Park",
            name: null,
            profile_picture_url: null,
            created_at: "2024-03-02T09:00:00.000Z",
            updated_at: "2024-03-02T09:00:00.000Z",
          },
        ]),
        identities: JSON.stringify({
          user_01: [{ idp_id: "109876543210", type: "OAuth", provider: "GoogleOAuth" }],
        }),
        memberships: JSON.stringify([
          {
            object: "organization_membership",
            id: "om_01",
            user_id: "user_01",
            organization_id: "org_01",
            organization_name: "Okafor Labs",
            role: { slug: "admin" },
            status: "active",
            created_at: "2024-03-03T09:00:00.000Z",
            updated_at: "2024-03-03T09:00:00.000Z",
          },
        ]),
        organizations: JSON.stringify([
          {
            object: "organization",
            id: "org_01",
            name: "Okafor Labs",
            created_at: "2024-03-03T09:00:00.000Z",
            updated_at: "2024-03-03T09:00:00.000Z",
          },
        ]),
      },
    },
    formats: [],
    legacyVerify: false,
    secrets: ["wren@example.com", "theo@example.com", "Wren", "Okafor", "Theo", "Park"],
    signIn: null,
  },
};
