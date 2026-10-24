import { type FieldType, type ModelName, SCHEMA_VERSION, schema } from "../schema.js";
import {
  AUX_TABLES,
  type AuxTable,
  columnName,
  type Dialect,
  indexName,
  META_TABLE,
  SCHEMA_VERSION_KEY,
  TABLES,
  uniqueIndexName,
} from "./sql.js";

/**
 * The column facts of each dialect (plan 12g), in one map. `schemaDdl`, the
 * expected shapes of the adapters, the MySQL baseline, and `authtempo
 * generate` read it. The D1 and Postgres migrations are records written by
 * hand, so they do not read it. Core imports no adapter, so each adapter
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
const DOMAIN =
  "normalizeDomain gives the A-label form, ASCII, of at most 253 characters (DOMAIN_MAX, engine/sso/domains.ts)";
const SCIM_TEXT =
  "an externalId of a SCIM resource: 1 to 256 characters (ID_TEXT_MAX, engine/scim/users.ts and groups.ts)";
const SCIM_KEY =
  "scimKey (NFKC, then lower case) of a userName of at most 256 or a displayName of at most 255 characters; NFKC can lengthen a text, and 752 is the most that the unique key with organizationId holds in 3072 bytes";

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
  // Schema version 15 (plan 12i): the username and the phone are unique keys.
  "user.username": ascii(
    64,
    "the stored form of USERNAME_RE (plan 12i Task 2): [a-z0-9_.] after NFKC and lower case, at most 30 by username.maxLength; the margin holds an imported name",
  ),
  "user.phone": ascii(16, "E.164 by PHONE_RE (plan 12i Task 4): a plus sign and at most 15 digits"),
  "identity.id": ascii(64, ROW_ID),
  "identity.userId": ascii(64, ROW_ID),
  "identity.provider": utf8(
    64,
    "PROVIDER_NAME_RE (social/provider.ts) allows 32, but the importers write cognito:<name> (readers/cognito.ts) and the Auth0 provider string with no bound (readers/auth0.ts)",
  ),
  "identity.subject": utf8(
    255,
    "SUBJECT_MAX (bounds.ts) bounds the subject of each provider kind, OIDC and generic OAuth2, to 255; the importer drops a longer one and writes an address",
  ),
  "session.id": ascii(64, ROW_ID),
  "session.tokenHash": ascii(64, HASH),
  "session.userId": ascii(64, ROW_ID),
  "session.activeOrganizationId": ascii(64, ROW_ID),
  "verification.id": ascii(64, ROW_ID),
  "verification.purpose": ascii(
    32,
    "the VerificationPurpose union (schema.ts); its longest member has 19 characters (password-verify-otp, plan 12i)",
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
    "base64url of a credential id of at most 1023 bytes (WebAuthn Level 3); the passkey registration refuses a longer id",
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
  // Schema version 14 (plan 12d): SSO and SCIM.
  "ssoConnection.id": ascii(64, ROW_ID),
  "ssoConnection.organizationId": ascii(64, ROW_ID),
  "ssoDomain.id": ascii(64, ROW_ID),
  "ssoDomain.organizationId": ascii(64, ROW_ID),
  "ssoDomain.domain": ascii(253, DOMAIN),
  "ssoDomain.claimedDomain": ascii(253, DOMAIN),
  "ssoDomain.connectionId": ascii(64, ROW_ID),
  "scimToken.id": ascii(64, ROW_ID),
  "scimToken.organizationId": ascii(64, ROW_ID),
  "scimToken.tokenHash": ascii(64, HASH),
  "scimUser.id": ascii(64, ROW_ID),
  "scimUser.organizationId": ascii(64, ROW_ID),
  "scimUser.userId": ascii(64, ROW_ID),
  "scimUser.userNameKey": utf8(752, SCIM_KEY),
  "scimUser.externalId": utf8(256, SCIM_TEXT),
  "scimGroup.id": ascii(64, ROW_ID),
  "scimGroup.organizationId": ascii(64, ROW_ID),
  "scimGroup.displayNameKey": utf8(752, SCIM_KEY),
  "scimGroup.externalId": utf8(256, SCIM_TEXT),
  "scimGroupMember.id": ascii(64, ROW_ID),
  "scimGroupMember.groupId": ascii(64, ROW_ID),
  "scimGroupMember.scimUserId": ascii(64, ROW_ID),
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
 * `ta_limit.key` is `VARBINARY(3072)` (ruling 3 of plan 12g). A `utf8mb4`
 * key cannot pass 768 characters, and the limiter compares bytes already.
 * A test of each limiter site holds its longest key under 3072 bytes. A key
 * from a custom `clientIp` hook that passes 3072 bytes fails with MySQL
 * error 1406.
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

/**
 * The tables that a migration runner makes for its own records. They are a
 * fact of each runner, not of the schema, so `schemaDdl` does not make them
 * and the shape check leaves them out. D1's runner table is wrangler's
 * `d1_migrations`, which has no `ta_` prefix, so no shape read sees it.
 */
export const RUNNER_TABLES: readonly string[] = ["ta_migrations"];

/** The table options of each MySQL table: a binary collation, so `=` compares bytes. */
const MYSQL_TABLE_OPTIONS = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin";

/** One table of the DDL: its columns, its primary key, its unique keys, and its plain indexes. */
interface DdlTable {
  name: string;
  columns: readonly { name: string; type: string; notNull: boolean }[];
  primaryKey: readonly string[];
  unique: readonly { name: string; columns: readonly string[] }[];
  indexes: readonly {
    name: string;
    columns: readonly string[];
    prefixes: readonly (number | undefined)[];
  }[];
}

function modelTable(d: Dialect, model: ModelName): DdlTable {
  const def = schema[model];
  const fields = def.fields as Record<string, { nullable?: boolean }>;
  const prefix = (field: string) =>
    d.name === "mysql" ? MYSQL_STRINGS[`${model}.${field}`]?.prefix : undefined;
  return {
    name: TABLES[model],
    columns: Object.entries(fields).map(([field, f]) => ({
      name: columnName(field),
      type: columnType(d, model, field),
      notNull: f.nullable !== true,
    })),
    primaryKey: ["id"],
    unique: def.unique.map((f) => ({
      name: uniqueIndexName(model, f),
      columns: f.map(columnName),
    })),
    indexes: def.indexes.map((f) => ({
      name: indexName(model, f),
      columns: f.map(columnName),
      prefixes: f.map(prefix),
    })),
  };
}

function auxTable(d: Dialect, t: AuxTable): DdlTable {
  return {
    name: t.name,
    columns: t.columns.map((c) => ({
      name: c.name,
      type: auxColumnType(d, t.name, c.name),
      notNull: true,
    })),
    primaryKey: t.primaryKey,
    unique: [],
    indexes: t.indexes.map((ix) => ({ ...ix, prefixes: ix.columns.map(() => undefined) })),
  };
}

/** The column line. A one-column primary key is inline on SQLite and Postgres, in the form of their migrations. */
function columnLine(d: Dialect, t: DdlTable, c: DdlTable["columns"][number]): string {
  const inlineKey = d.name !== "mysql" && t.primaryKey.length === 1 && t.primaryKey[0] === c.name;
  if (inlineKey)
    // D1: `id TEXT PRIMARY KEY NOT NULL` (0007_schema_v7.sql). Postgres:
    // `id text PRIMARY KEY` (0007_schema_v7.ts); its key is NOT NULL.
    return `${d.quote(c.name)} ${c.type} PRIMARY KEY${d.name === "sqlite" ? " NOT NULL" : ""}`;
  return `${d.quote(c.name)} ${c.type}${c.notNull ? " NOT NULL" : ""}`;
}

const keyList = (d: Dialect, columns: readonly string[]) => columns.map(d.quote).join(", ");

function tableStatements(d: Dialect, t: DdlTable): string[] {
  const lines = t.columns.map((c) => columnLine(d, t, c));
  if (d.name !== "mysql") {
    if (t.primaryKey.length > 1) lines.push(`PRIMARY KEY (${keyList(d, t.primaryKey)})`);
    return [
      `CREATE TABLE ${t.name} (\n  ${lines.join(",\n  ")}\n)`,
      ...t.unique.map(
        (u) => `CREATE UNIQUE INDEX ${u.name} ON ${t.name} (${keyList(d, u.columns)})`,
      ),
      ...t.indexes.map((ix) => `CREATE INDEX ${ix.name} ON ${t.name} (${keyList(d, ix.columns)})`),
    ];
  }
  // MySQL: each key and index is inside its table, one statement per table.
  // Only a plain index takes a prefix; a unique key never does.
  lines.push(`PRIMARY KEY (${keyList(d, t.primaryKey)})`);
  for (const u of t.unique) lines.push(`UNIQUE KEY ${d.quote(u.name)} (${keyList(d, u.columns)})`);
  for (const ix of t.indexes) {
    const cols = ix.columns.map((c, i) => {
      const n = ix.prefixes[i];
      return n === undefined ? d.quote(c) : `${d.quote(c)}(${n})`;
    });
    lines.push(`KEY ${d.quote(ix.name)} (${cols.join(", ")})`);
  }
  return [`CREATE TABLE ${d.quote(t.name)} (\n  ${lines.join(",\n  ")}\n) ${MYSQL_TABLE_OPTIONS}`];
}

/**
 * The full DDL of `SCHEMA_VERSION` on `d` (plan 12g), one statement per
 * entry. Each model comes in schema order, with its columns in field order.
 * Its unique keys and its indexes follow, with core's names. Then come
 * `AUX_TABLES` and the version row. No comment and no `IF NOT EXISTS`, so two calls give the
 * same text. The shipped D1 and Postgres migrations stay records written by
 * hand; the shape check holds them equal to this text.
 */
export function schemaDdl(d: Dialect): string[] {
  const models = Object.keys(schema) as ModelName[];
  const tables = [...models.map((m) => modelTable(d, m)), ...AUX_TABLES.map((t) => auxTable(d, t))];
  return [
    ...tables.flatMap((t) => tableStatements(d, t)),
    `INSERT INTO ${d.quote(META_TABLE)} (${d.quote("key")}, ${d.quote("value")}) VALUES ('${SCHEMA_VERSION_KEY}', '${SCHEMA_VERSION}')`,
  ];
}
