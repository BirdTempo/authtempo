import { type ModelName, type Models, StorageError } from "@authtempo/core";
import type { BetterAuthTable } from "./names.js";

/**
 * `nullAsEmpty`: core null is "" in the table (Better Auth's `user.name` is NOT NULL).
 * `base64Std`: base64url in core, standard base64 with padding in the table (Better Auth's passkey key).
 * `emptyAsNull`: "" in the table reads as null (Better Auth writes "" for no transports).
 */
export type Codec = "nullAsEmpty" | "base64Std" | "emptyAsNull";

export interface FieldMap {
  readonly column: string;
  readonly codec?: Codec;
}

export interface Scope {
  readonly column: string;
  readonly op: "eq" | "ne" | "notNull";
  readonly value?: string;
}

type Row = Record<string, unknown>;

export interface ModelMap<M extends ModelName> {
  readonly table: BetterAuthTable;
  /** Every core field, by name. A field missing here, or one the core row does not have, fails the compile. */
  readonly fields: { readonly [K in keyof Models[M] & string]: FieldMap };
  /** Better Auth columns with no core field, written on insert. */
  readonly insertExtras?: (row: Models[M]) => Row;
  /** The same columns, written on update when `data` holds their source. */
  readonly updateExtras?: (data: Partial<Omit<Models[M], "id">>) => Row;
  /** One clause every statement adds, so rows of another meaning stay out of view. */
  readonly scope?: Scope;
}

/** The erased view the statement builder reads. */
export interface AnyModelMap {
  readonly table: BetterAuthTable;
  readonly fields: Readonly<Record<string, FieldMap>>;
  readonly insertExtras?: (row: Row) => Row;
  readonly updateExtras?: (data: Row) => Row;
  readonly scope?: Scope;
}

const as = (column: string, codec?: Codec): FieldMap => (codec ? { column, codec } : { column });
function same<K extends string>(...keys: K[]): Record<K, FieldMap> {
  return Object.fromEntries(keys.map((k) => [k, { column: k }])) as unknown as Record<K, FieldMap>;
}

/**
 * Better Auth 1.7's account issuers (@better-auth/core src/db/schema/account.ts
 * and src/social-providers/{google,apple}.ts, read 2026-10-10): local methods
 * are `local:<id>`, Google and Apple carry their own, other OAuth providers
 * are `local:oauth:<id>`. The unique key is (issuer, accountId). `email` is
 * core's own identity (deviation 2). The one source for the named issuers:
 * `issuerFor` reads it, and migration 0001 builds its SQL fill from it, in
 * this key order (a shipped migration's text never changes).
 */
export const ISSUERS: Readonly<Record<string, string>> = {
  credential: "local:credential",
  email: "local:email",
  google: "https://accounts.google.com",
  apple: "https://appleid.apple.com",
};

/**
 * The issuer of a provider id. A provider with no named issuer is
 * `local:oauth:<id>` with the id through encodeURIComponent, as Better Auth
 * 1.7 writes it. The SQL fill of migration 0001 writes the id raw. The two
 * agree for every id that core's provider name rule allows
 * (`PROVIDER_NAME_RE`, /^[a-z][a-z0-9-]{0,31}$/), because encodeURIComponent
 * changes none of its characters. test/issuer.test.ts pins it (plan 9b2).
 */
export function issuerFor(provider: string): string {
  return Object.hasOwn(ISSUERS, provider)
    ? (ISSUERS[provider] as string)
    : `local:oauth:${encodeURIComponent(provider)}`;
}

function notCredential(provider: string): string {
  // A `credential` identity would read back as a password row.
  if (provider === "credential")
    throw new StorageError("invalid_argument", "identity", ["provider"]);
  return issuerFor(provider);
}

/**
 * Core's models that have a Better Auth table. Core's `apiToken` (plan 8b)
 * has none yet: the plan that maps Better Auth's api-key plugin puts it on
 * the `apikey` table, so that the keys an app already holds keep working.
 * `UNMAPPED_MODELS` in statements.ts is the runtime half of this rule.
 * Some core models keep core's own tables beside the Better Auth tables
 * (`CORE_TABLE_MODELS` in statements.ts). Plan 9f added `totp` and
 * `trustedDevice`. Plan 9g added `jwk`, `oauthClient`, `oauthConsent`, and
 * `oauthToken`. Plan 12c added `secondFactor`. Plan 12e added
 * `oauthDevice`, `oauthSubject`, `oauthSessionClient`, and `oauthLogout`.
 */
export type MappedModel = Exclude<
  ModelName,
  | "apiToken"
  | "totp"
  | "trustedDevice"
  | "jwk"
  | "oauthClient"
  | "oauthConsent"
  | "oauthToken"
  | "oauthDevice"
  | "oauthSubject"
  | "oauthSessionClient"
  | "oauthLogout"
  | "secondFactor"
>;

export const MAPPING: { [M in MappedModel]: ModelMap<M> } = {
  user: {
    table: "user",
    fields: {
      ...same("id", "email", "emailVerified", "image", "createdAt", "updatedAt"),
      name: as("name", "nullAsEmpty"),
    },
  },
  identity: {
    table: "account",
    fields: {
      ...same("id", "userId", "createdAt", "updatedAt"),
      provider: as("providerId"),
      subject: as("accountId"),
      linkedAt: as("taLinkedAt"),
    },
    insertExtras: (row) => ({ issuer: notCredential(row.provider) }),
    updateExtras: (data) =>
      data.provider === undefined ? {} : { issuer: notCredential(data.provider) },
    scope: { column: "providerId", op: "ne", value: "credential" },
  },
  password: {
    table: "account",
    fields: { ...same("id", "userId", "createdAt", "updatedAt"), hash: as("password") },
    // Better Auth writes the credential row with accountId equal to the user id (dist/api/routes/sign-in.mjs:320).
    insertExtras: (row) => ({
      providerId: "credential",
      issuer: issuerFor("credential"),
      accountId: row.userId,
    }),
    updateExtras: (data) => (data.userId === undefined ? {} : { accountId: data.userId }),
    scope: { column: "providerId", op: "eq", value: "credential" },
  },
  session: {
    table: "session",
    fields: {
      ...same(
        "id",
        "userId",
        "expiresAt",
        "userAgent",
        "activeOrganizationId",
        "createdAt",
        "updatedAt",
      ),
      tokenHash: as("token"),
      lastSeenAt: as("taLastSeenAt"),
      ip: as("ipAddress"),
      freshAt: as("taFreshAt"),
    },
  },
  verification: {
    table: "verification",
    fields: {
      ...same("id", "identifier", "expiresAt", "createdAt", "updatedAt"),
      purpose: as("taPurpose"),
      valueHash: as("taValueHash"),
      consumedAt: as("taConsumedAt"),
      data: as("taData"),
      secretVersion: as("taSecretVersion"),
    },
    // Better Auth's `value` is NOT NULL. It holds the hash, never a token.
    insertExtras: (row) => ({ value: row.valueHash }),
    updateExtras: (data) => (data.valueHash === undefined ? {} : { value: data.valueHash }),
    scope: { column: "taPurpose", op: "notNull" },
  },
  passkey: {
    table: "passkey",
    fields: {
      ...same("id", "userId", "counter", "deviceType", "backedUp", "name", "createdAt"),
      credentialId: as("credentialID"),
      publicKey: as("publicKey", "base64Std"),
      transports: as("transports", "emptyAsNull"),
      updatedAt: as("taUpdatedAt"),
    },
  },
  organization: {
    table: "organization",
    fields: {
      ...same("id", "slug", "name", "metadata", "createdAt"),
      updatedAt: as("taUpdatedAt"),
    },
  },
  member: {
    table: "member",
    fields: {
      ...same("id", "organizationId", "userId", "role", "createdAt"),
      updatedAt: as("taUpdatedAt"),
    },
  },
  invitation: {
    table: "invitation",
    fields: {
      ...same("id", "organizationId", "email", "role", "inviterId", "expiresAt", "createdAt"),
      tokenHash: as("taTokenHash"),
      acceptedAt: as("taAcceptedAt"),
      updatedAt: as("taUpdatedAt"),
    },
    insertExtras: (row) => ({ status: row.acceptedAt ? "accepted" : "pending" }),
    updateExtras: (data) =>
      data.acceptedAt === undefined ? {} : { status: data.acceptedAt ? "accepted" : "pending" },
    scope: { column: "taTokenHash", op: "notNull" },
  },
};
