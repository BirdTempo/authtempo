import { type ModelName, type Models, StorageError } from "@authtempo/core";
import { sha256 } from "@noble/hashes/sha2.js";
import type { BetterAuthTable } from "./names.js";

/**
 * `nullAsEmpty`: core null is "" in the table (Better Auth's `user.name` is NOT NULL).
 * `base64Std`: base64url in core, standard base64 with padding in the table (Better Auth's passkey key).
 * `emptyAsNull`: "" in the table reads as null (Better Auth writes "" for no transports).
 * `permission`: a statement set in core, JSON text with Better Auth's names in
 * the table (`organizationRole.permission`, plan 12k). The read parses it,
 * maps `apiKey` onto `apiToken`, and adds the list reads in memory. A text
 * that does not parse reads as the text, so core's shape rule refuses the row
 * (spec 29 item 6, rule 7). The write maps `apiToken` back onto `apiKey` and
 * removes no action (`toStoredPermissions`, ruling 37).
 * `commaList`: a list of ids in core, the ids joined by "," in the table
 * (`invitation.teamId`, plan 12k Task 11). An empty list and null are null.
 * Better Auth refuses a team id that holds "," (INVALID_TEAM_ID), so the
 * join loses nothing.
 * `placeholder`: Better Auth's `user.email` is NOT NULL, and core's address
 * is nullable from schema version 15 (plan 12i). An insert of null writes
 * Better Auth's placeholder of the row's id, and every placeholder reads as
 * null (placeholder.ts, plan 12i Task 16). A write of an address in a
 * placeholder form, or an update to null, fails with `invalid_argument`
 * before any statement runs.
 */
export type Codec =
  | "nullAsEmpty"
  | "base64Std"
  | "emptyAsNull"
  | "permission"
  | "commaList"
  | "placeholder";

export interface FieldMap {
  readonly column: string;
  readonly codec?: Codec;
  /** A column the read takes when this one is null (Better Auth's nullable `organizationRole.updatedAt`). */
  readonly orColumn?: string;
  /**
   * A boolean column that gates the read: the field reads as null unless it
   * is true. A where and a sort see the same value (Better Auth's
   * `phoneNumberVerified`, ruling 15 of plan 12i).
   */
  readonly onlyWhen?: string;
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
/** `column`, read as `orColumn` while it is null. */
const or = (column: string, orColumn: string): FieldMap => ({ column, orColumn });
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
 * Core's models that have a Better Auth table. Some core models keep core's
 * own tables beside the Better Auth tables (`CORE_TABLE_MODELS` in
 * statements.ts). Plan 9f added `totp` and `trustedDevice`. Plan 9g added
 * `jwk`, `oauthClient`, `oauthConsent`, and `oauthToken`. Plan 12c added
 * `secondFactor`. Plan 12e added `oauthDevice`, `oauthSubject`,
 * `oauthSessionClient`, and `oauthLogout`. Plan 12f added `operatorAudit`.
 * Plan 12k Task 1 added its four models with no table, and the later 12k
 * tasks map each one. Task 10 maps `organizationRole` onto Better Auth's own
 * table, and Task 11 maps `team` and `teamMember` onto Better Auth's own
 * tables. Core's `apiToken` and `organizationToken` keep core's own tables
 * (owner decision 4 of 2026-10-14, plan 12k): `moveBetterAuthApiKeys`
 * moves the rows into them. By ruling 2 of plan 12k a moved row acts: the
 * move writes no retired mark. Core's `movedToken`, the record of each moved
 * row, keeps core's own table too. Plan 12d added its six SSO and SCIM
 * models, each with core's own table.
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
  | "operatorAudit"
  | "organizationToken"
  | "movedToken"
  | "ssoConnection"
  | "ssoDomain"
  | "scimToken"
  | "scimUser"
  | "scimGroup"
  | "scimGroupMember"
>;

export const MAPPING: { [M in MappedModel]: ModelMap<M> } = {
  user: {
    table: "user",
    fields: {
      ...same("id", "emailVerified", "image", "createdAt", "updatedAt"),
      email: as("email", "placeholder"),
      name: as("name", "nullAsEmpty"),
      bannedAt: as("taBannedAt"),
      banReason: as("taBanReason"),
      banUntil: as("taBanUntil"),
      // Better Auth's own columns of its username, phone number, and anonymous
      // plugins (plan 12i). Migration 0012 adds each one that is absent.
      username: as("username"),
      displayUsername: as("displayUsername"),
      // Better Auth stores a sign-up's phoneNumber before its code is proved,
      // and sets phoneNumberVerified only at the verify. Core reads a phone
      // only where it is proved (ruling 15 of plan 12i).
      phone: { column: "phoneNumber", onlyWhen: "phoneNumberVerified" },
      isAnonymous: as("isAnonymous"),
    },
    // Core writes a phone only after its code (Task 4 of plan 12i), so a
    // phone that core writes is proved. A Better Auth number with no proof
    // reads as no phone (onlyWhen above).
    insertExtras: (row) => ({ phoneNumberVerified: row.phone === null ? null : true }),
    updateExtras: (data) =>
      data.phone === undefined ? {} : { phoneNumberVerified: data.phone === null ? null : true },
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
      actorId: as("taActorId"),
      // Better Auth's own column of its teams option (plan 12k).
      activeTeamId: as("activeTeamId"),
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
      // The extension flags of plan 12i (migration 0012).
      discoverable: as("taDiscoverable"),
      prf: as("taPrf"),
      largeBlob: as("taLargeBlob"),
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
      // Better Auth's own column of its teams option (plan 12k): the ids
      // joined by "," (organization/adapter.mjs createInvitation, read 2026-10-21).
      teamIds: as("teamId", "commaList"),
    },
    insertExtras: (row) => ({ status: row.acceptedAt ? "accepted" : "pending" }),
    updateExtras: (data) =>
      data.acceptedAt === undefined ? {} : { status: data.acceptedAt ? "accepted" : "pending" },
    scope: { column: "taTokenHash", op: "notNull" },
  },
  // Better Auth's dynamicAccessControl table, in place (plan 12k Task 10).
  // Better Auth has no rank, so migration 0010 adds taRank with the default 1.
  // Better Auth leaves updatedAt null until the first update; core reads it
  // as createdAt, so the compare of updateRole matches the value it read.
  organizationRole: {
    table: "organizationRole",
    fields: {
      ...same("id", "organizationId", "createdAt"),
      name: as("role"),
      rank: as("taRank"),
      permissions: as("permission", "permission"),
      updatedAt: or("updatedAt", "createdAt"),
    },
  },
  // Better Auth's teams option, in place (plan 12k Task 11). Core never reads
  // memberCount (deviation 11): the create writes 0, as Better Auth's own
  // createTeam does, and no write keeps it. Better Auth counts the rows again
  // before its next add (syncTeamMemberCount). Better Auth's default team has
  // a null updatedAt, which core reads as createdAt.
  team: {
    table: "team",
    fields: {
      ...same("id", "organizationId", "name", "createdAt"),
      updatedAt: or("updatedAt", "createdAt"),
    },
    insertExtras: () => ({ memberCount: 0 }),
  },
  // Migration 0010 adds taOrganizationId (filled from team.organizationId) and
  // taUpdatedAt (filled from createdAt). The unique membershipKey holds Better
  // Auth's own value (deviation 12). So a Better Auth read by the key and a
  // core write agree.
  teamMember: {
    table: "teamMember",
    fields: {
      ...same("id", "teamId", "userId", "createdAt"),
      organizationId: as("taOrganizationId"),
      // A row that Better Auth writes after the migration has no taUpdatedAt.
      updatedAt: or("taUpdatedAt", "createdAt"),
    },
    // No updateExtras: core never updates a team member row, so the pair of the key never changes.
    insertExtras: (row) => ({ membershipKey: teamMembershipKey(row.teamId, row.userId) }),
  },
};

/**
 * Better Auth 1.7.2's `computeTeamMembershipKey` (organization/adapter.mjs:9,
 * read 2026-10-21): the SHA-256 of `JSON.stringify([teamId, userId])` in
 * base64url with no padding. Better Auth hashes through WebCrypto, which is
 * async. A statement is built in sync code, so this uses the sync SHA-256 of
 * @noble/hashes, a dependency of this package already. test/teams.test.ts
 * pins the value against rows that Better Auth itself wrote.
 */
export function teamMembershipKey(teamId: string, userId: string): string {
  const digest = sha256(new TextEncoder().encode(JSON.stringify([teamId, userId])));
  let text = "";
  for (const byte of digest) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
