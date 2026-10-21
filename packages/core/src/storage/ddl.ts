import { type FieldType, type ModelName, schema } from "../schema.js";
import { AUX_TABLES, type Dialect } from "./sql.js";

/**
 * The column facts of each dialect (plan 12g). One map for every dialect:
 * the D1 and Postgres migrations, the MySQL baseline, the shape checks, and
 * `authtempo generate` read it. Core imports no adapter, so each adapter
 * test holds its own map equal to this one.
 */

/** The width of one MySQL key string. The bytes of a key are 4 per `utf8mb4` character and 1 per `ascii` character. */
export interface MysqlString {
  length: number;
  charset: "ascii" | "utf8mb4";
  /** The characters of a plain index on the column. A unique key or a primary key never has one. */
  prefix?: number;
  why: string;
}

/** The InnoDB key limit of the DYNAMIC row format (MySQL 8.4 manual, "InnoDB Limits", read 2026-10-14). */
export const MYSQL_KEY_LIMIT_BYTES = 3072;

const NEW_ID =
  "newId gives 26 Crockford characters (primitives/ids.ts); the margin holds an imported id";
const ROW_ID = `a row id: ${NEW_ID}`;
const HASH = "SHA-256 or HMAC-SHA256 in hex: 64 characters";
const CLIENT_ID =
  "a cl_ id or the URL of a metadata document, at most 2048 characters (URI_MAX, engine/oauth-clients.ts); a parsed URL's href is ASCII";
const EMAIL =
  "normalizeEmail refuses more than 254 code units (EMAIL_MAX, engine/users.ts); an address can hold a non-ASCII character";

const ascii = (length: number, why: string): MysqlString => ({ length, charset: "ascii", why });
const utf8 = (length: number, why: string): MysqlString => ({ length, charset: "utf8mb4", why });

/**
 * The MySQL width of each string field that a key or an index holds, keyed
 * `<model>.<field>`. Any other string is TEXT. A value longer than its
 * column is MySQL error 1406, which the MySQL adapter answers as
 * `invalid_argument`. The other dialects store the value (decision 3 of
 * plan 12g). A test fails a key string with no row and a row with no key.
 */
export const MYSQL_STRINGS: Readonly<Record<string, MysqlString>> = {
  "user.id": ascii(64, ROW_ID),
  "user.email": utf8(254, EMAIL),
  "identity.id": ascii(64, ROW_ID),
  "identity.userId": ascii(64, ROW_ID),
  "identity.provider": utf8(
    64,
    "PROVIDER_NAME_RE (social/provider.ts) allows 32, but the importers write cognito:<name> (readers/cognito.ts) and the Auth0 provider string with no bound (readers/auth0.ts)",
  ),
  "identity.subject": utf8(
    255,
    "the OIDC sub is at most 255 ASCII characters (SUBJECT_MAX, engine/social.ts); an importer writes an address; a generic OAuth2 subject has no stated bound",
  ),
  "session.id": ascii(64, ROW_ID),
  "session.tokenHash": ascii(64, HASH),
  "session.userId": ascii(64, ROW_ID),
  "session.activeOrganizationId": ascii(64, ROW_ID),
  "verification.id": ascii(64, ROW_ID),
  "verification.purpose": ascii(
    32,
    "the VerificationPurpose union (schema.ts); its longest member has 18 characters",
  ),
  "verification.identifier": {
    length: 2048,
    charset: "utf8mb4",
    prefix: 255,
    why: "an address, a user id, a provider name, or a client id URL of at most 2048 characters; a plain index takes a prefix",
  },
  "verification.valueHash": ascii(64, HASH),
  "passkey.id": ascii(64, ROW_ID),
  "passkey.userId": ascii(64, ROW_ID),
  "passkey.credentialId": ascii(
    1364,
    "base64url of a credential id of at most 1023 bytes (WebAuthn Level 3); the engine keeps no bound of its own",
  ),
  "organization.id": ascii(64, ROW_ID),
  "organization.slug": ascii(64, "SLUG_RE (engine/ranks.ts): at most 64 of [a-z0-9-]"),
  "member.id": ascii(64, ROW_ID),
  "member.organizationId": ascii(64, ROW_ID),
  "member.userId": ascii(64, ROW_ID),
  "invitation.id": ascii(64, ROW_ID),
  "invitation.tokenHash": ascii(64, HASH),
  "invitation.organizationId": ascii(64, ROW_ID),
  "invitation.email": utf8(254, EMAIL),
  "password.id": ascii(64, ROW_ID),
  "password.userId": ascii(64, ROW_ID),
  "apiToken.id": ascii(64, ROW_ID),
  "apiToken.tokenHash": ascii(64, HASH),
  "apiToken.userId": ascii(64, ROW_ID),
  "totp.id": ascii(64, ROW_ID),
  "totp.userId": ascii(64, ROW_ID),
  "trustedDevice.id": ascii(64, ROW_ID),
  "trustedDevice.tokenHash": ascii(64, HASH),
  "trustedDevice.userId": ascii(64, ROW_ID),
  "jwk.id": ascii(64, ROW_ID),
  "jwk.slot": ascii(16, '"signing" or null'),
  "oauthClient.id": ascii(2048, CLIENT_ID),
  "oauthConsent.id": ascii(64, ROW_ID),
  "oauthConsent.userId": ascii(64, ROW_ID),
  "oauthConsent.clientId": ascii(2048, CLIENT_ID),
  "oauthToken.id": ascii(64, ROW_ID),
  "oauthToken.tokenHash": ascii(64, HASH),
  "oauthToken.userId": ascii(64, ROW_ID),
  "oauthToken.clientId": ascii(2048, CLIENT_ID),
  "oauthToken.familyId": ascii(64, `the id of the first token of the family: ${NEW_ID}`),
  "oauthToken.parentId": ascii(64, `the id of the spent token: ${NEW_ID}`),
  "oauthDevice.id": ascii(64, ROW_ID),
  "oauthDevice.deviceCodeHash": ascii(64, HASH),
  "oauthDevice.userCodeHash": ascii(64, HASH),
  "oauthSubject.id": ascii(64, ROW_ID),
  "oauthSubject.userId": ascii(64, ROW_ID),
  "oauthSubject.sector": ascii(
    2048,
    "the host name of a client id URL or of its redirect URIs (sectorOf, engine/oauth-subject.ts): ASCII, and at most 2048",
  ),
  "oauthSubject.subject": ascii(
    64,
    "ps_ and the base64url of 16 random bytes: 25 characters (engine/oauth-subject.ts)",
  ),
  "oauthSessionClient.id": ascii(64, ROW_ID),
  "oauthSessionClient.sessionId": ascii(64, ROW_ID),
  "oauthSessionClient.userId": ascii(64, ROW_ID),
  "oauthSessionClient.clientId": ascii(2048, CLIENT_ID),
  "oauthLogout.id": ascii(64, ROW_ID),
  "oauthLogout.userId": ascii(64, ROW_ID),
  "secondFactor.id": ascii(64, ROW_ID),
  "secondFactor.userId": ascii(64, ROW_ID),
  "operatorAudit.id": ascii(64, ROW_ID),
  "operatorAudit.targetUserId": ascii(64, ROW_ID),
  "operatorAudit.actorId": ascii(
    64,
    "a user id, or the name of an operator secret: at most 32 of [a-z0-9_-] (config.ts)",
  ),
  "organizationRole.id": ascii(64, ROW_ID),
  "organizationRole.organizationId": ascii(64, ROW_ID),
  "organizationRole.name": ascii(
    64,
    "ROLE_RE (engine/ranks.ts) for one role: at most 64 of [a-z0-9_-]; oneRoleName checks it before each write",
  ),
  "team.id": ascii(64, ROW_ID),
  "team.organizationId": ascii(64, ROW_ID),
  "teamMember.id": ascii(64, ROW_ID),
  "teamMember.teamId": ascii(64, ROW_ID),
  "teamMember.userId": ascii(64, ROW_ID),
  "teamMember.organizationId": ascii(64, ROW_ID),
  "organizationToken.id": ascii(64, ROW_ID),
  "organizationToken.tokenHash": ascii(64, HASH),
  "organizationToken.organizationId": ascii(64, ROW_ID),
  "movedToken.id": ascii(64, ROW_ID),
  "movedToken.source": ascii(
    64,
    'the source name of a move, such as "better-auth:apikey" (compat-better-auth/src/storage/api-keys.ts)',
  ),
  "movedToken.sourceId": utf8(
    255,
    "the id of a row of another system, such as a Better Auth apikey id; no bound is stated",
  ),
};

function fieldType(model: ModelName, field: string): FieldType {
  const def = (schema[model].fields as Record<string, { type: FieldType } | undefined>)[field];
  if (def === undefined) throw new Error(`authtempo ddl: ${model} has no field ${field}`);
  return def.type;
}

function isInt64(model: ModelName, field: string): boolean {
  return (schema[model].fields as Record<string, { int64?: true }>)[field]?.int64 === true;
}

/** The MySQL text of one key string column: a binary collation, so `=` compares bytes. */
function mysqlString(length: number, charset: MysqlString["charset"]): string {
  const collation = charset === "ascii" ? "ascii_bin" : "utf8mb4_0900_bin";
  return `VARCHAR(${length}) CHARACTER SET ${charset} COLLATE ${collation}`;
}

function postgresType(model: ModelName, field: string, type: FieldType): string {
  switch (type) {
    case "string":
      return "text";
    case "boolean":
      return "boolean";
    case "date":
      return "timestamp with time zone";
    case "json":
      return "jsonb";
    case "integer":
      // The WebAuthn sign count is an unsigned 32-bit value, and the spec
      // gives the TOTP step counter 64 bits, as RFC 6238 does.
      return isInt64(model, field) ? "bigint" : "integer";
  }
}

function mysqlType(model: ModelName, field: string, type: FieldType): string {
  switch (type) {
    case "string": {
      const row = MYSQL_STRINGS[`${model}.${field}`];
      return row === undefined ? "TEXT" : mysqlString(row.length, row.charset);
    }
    case "boolean":
      return "TINYINT(1)";
    case "date":
      return "BIGINT";
    case "json":
      return "JSON";
    case "integer":
      return isInt64(model, field) ? "BIGINT" : "INT";
  }
}

/**
 * The column type of one field on `d`. SQLite and Postgres answer the names
 * that their migrations write. A MySQL string with no row of
 * `MYSQL_STRINGS` is TEXT, with the table's binary collation.
 */
export function columnType(d: Dialect, model: ModelName, field: string): string {
  const type = fieldType(model, field);
  switch (d.name) {
    case "sqlite":
      return type === "string" || type === "json" ? "TEXT" : "INTEGER";
    case "postgres":
      return postgresType(model, field, type);
    case "mysql":
      return mysqlType(model, field, type);
  }
}

/**
 * The column type of one column of `AUX_TABLES` on `d`. On MySQL,
 * `ta_limit.key` is `VARBINARY(3072)`: a key holds a client id of up to
 * 2048 characters, a `utf8mb4` key cannot pass 768 characters, and the
 * limiter compares bytes already (ruling 3 of plan 12g). A key from a custom
 * `clientIp` hook that passes 3072 bytes fails with MySQL error 1406.
 */
export function auxColumnType(d: Dialect, table: string, column: string): string {
  const kind = AUX_TABLES.find((t) => t.name === table)?.columns.find(
    (c) => c.name === column,
  )?.kind;
  if (kind === undefined) throw new Error(`authtempo ddl: ${table} has no column ${column}`);
  switch (d.name) {
    case "sqlite":
      return kind === "text" ? "TEXT" : "INTEGER";
    case "postgres":
      return kind === "text" ? "text" : "bigint";
    case "mysql":
      if (kind === "int64") return "BIGINT";
      if (table === "ta_limit" && column === "key") return "VARBINARY(3072)";
      // A meta key is a name such as schema_version.
      if (table === "ta_meta" && column === "key") return mysqlString(64, "ascii");
      return "TEXT";
  }
}

/** The bytes of one non-string MySQL column in a key. */
function mysqlFixedBytes(model: ModelName, field: string, type: FieldType): number {
  switch (type) {
    case "boolean":
      return 1;
    case "integer":
      return isInt64(model, field) ? 8 : 4;
    case "date":
      return 8;
    case "string":
    case "json":
      throw new Error(`authtempo ddl: ${model}.${field} cannot be in a MySQL key`);
  }
}

/**
 * The bytes of a MySQL key over `fields` of `model`. A row's `prefix`
 * counts in place of its length: only a plain index has one. A string
 * field with no row is TEXT, which no key can hold, so it throws.
 */
export function mysqlKeyBytes(d: Dialect, model: ModelName, fields: readonly string[]): number {
  if (d.name !== "mysql") throw new Error("authtempo ddl: mysqlKeyBytes is for the MySQL dialect");
  let bytes = 0;
  for (const field of fields) {
    const type = fieldType(model, field);
    if (type !== "string") {
      bytes += mysqlFixedBytes(model, field, type);
      continue;
    }
    const row = MYSQL_STRINGS[`${model}.${field}`];
    if (row === undefined) throw new Error(`authtempo ddl: ${model}.${field} has no MySQL width`);
    bytes += (row.prefix ?? row.length) * (row.charset === "ascii" ? 1 : 4);
  }
  return bytes;
}
