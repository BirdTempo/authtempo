import { StorageError } from "@authtempo/core";
import { META_TABLE, SCHEMA_VERSION_KEY, schemaVersionGate } from "@authtempo/core/sql";
import type { Sql } from "postgres";
import { ISSUERS } from "./mapping.js";
import { BETTER_AUTH_TABLES, type BetterAuthTable, type Names } from "./names.js";

/**
 * The lowest `compat_better_auth` value this code reads. Migration 0002
 * writes 2 and migration 0003 writes 3, so that the Postgres runner applies
 * each once. The mapping of Better Auth's tables does not change in either:
 * 0002 adds no table, and 0003 adds core's own `ta_totp` and
 * `ta_trusted_device` (plan 9f). So the floor stays 1. Core's gate on
 * `schema_version` is the check that needs 0002 and 0003.
 */
export const COMPAT_SCHEMA_VERSION = 1;
export const COMPAT_META_KEY = "compat_better_auth";
export const MIGRATION_NAME = "0001_compat_better_auth";
export const MIGRATION_0002_NAME = "0002_compat_schema_v5";

/**
 * Migration 0002 (plan 8b): core's schema version 5. Core 5 adds the
 * `apiToken` model, which this package does not map (`UNMAPPED_MODELS`), so
 * no table changes. Core's gate compares `schema_version` with
 * SCHEMA_VERSION, so without this file the storage refuses to start. The
 * text is the same for both dialects, both D1 variants, and every naming: it
 * touches ta_meta only. Append-only.
 */
export const COMPAT_MIGRATION_0002_SQL =
  "UPDATE ta_meta SET value = '5' WHERE key = 'schema_version';\nUPDATE ta_meta SET value = '2' WHERE key = 'compat_better_auth';\n";

export const MIGRATION_0003_NAME = "0003_compat_schema_v6";

/**
 * Migration 0003 (plan 9f): core's schema version 6. Core 6 adds the
 * `totp` and `trustedDevice` models. Better Auth has no table that fits
 * them, so this migration creates core's own two tables, with core 0006's
 * names, columns, and indexes, beside the Better Auth tables
 * (`CORE_TABLE_MODELS`). The text is the same for every naming and for both
 * D1 variants: it names `ta_` tables only, in the first schema of the search
 * path, as ta_meta. The two dialects differ in their column types only.
 * Append-only.
 */
export const COMPAT_MIGRATION_0003_SQL: Readonly<Record<"postgres" | "sqlite", string>> = {
  postgres: `CREATE TABLE ta_totp (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  secret text NOT NULL,
  enabled_at timestamptz,
  last_step bigint NOT NULL,
  backup_codes jsonb NOT NULL
);
CREATE UNIQUE INDEX ux_ta_totp__user_id ON ta_totp (user_id);
CREATE TABLE ta_trusted_device (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX ux_ta_trusted_device__token_hash ON ta_trusted_device (token_hash);
CREATE INDEX ix_ta_trusted_device__user_id ON ta_trusted_device (user_id);
UPDATE ta_meta SET value = '6' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '3' WHERE key = 'compat_better_auth';
`,
  sqlite: `CREATE TABLE ta_totp (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled_at INTEGER,
  last_step INTEGER NOT NULL,
  backup_codes TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_totp__user_id ON ta_totp (user_id);
CREATE TABLE ta_trusted_device (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_ta_trusted_device__token_hash ON ta_trusted_device (token_hash);
CREATE INDEX ix_ta_trusted_device__user_id ON ta_trusted_device (user_id);
UPDATE ta_meta SET value = '6' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '3' WHERE key = 'compat_better_auth';
`,
};

export const MIGRATION_0004_NAME = "0004_compat_schema_v7";

/**
 * Migration 0004 (plan 9g): core's schema version 7. Core 7 adds the `jwk`,
 * `oauthClient`, `oauthConsent`, and `oauthToken` models. This package maps
 * no Better Auth jwt or OAuth plugin (owner decision of 2026-10-13), and core's
 * minting is off under it, so the tables stay empty until an app moves to
 * core's routes; the migration creates them so that core's version gate and
 * conformance hold. They are core's own tables, with core 0007's names,
 * columns, and indexes, beside the Better Auth tables (`CORE_TABLE_MODELS`).
 * The text is the same for every naming and for both D1 variants. Append-only.
 */
export const COMPAT_MIGRATION_0004_SQL: Readonly<Record<"postgres" | "sqlite", string>> = {
  postgres: `CREATE TABLE ta_jwk (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  public_jwk jsonb NOT NULL,
  private_key text NOT NULL,
  slot text,
  retired_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_jwk__slot ON ta_jwk (slot);
CREATE TABLE ta_oauth_client (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  kind text NOT NULL,
  name text,
  redirect_uris jsonb NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE TABLE ta_oauth_consent (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  client_id text NOT NULL,
  scopes jsonb NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_consent__client_id__user_id ON ta_oauth_consent (client_id, user_id);
CREATE INDEX ix_ta_oauth_consent__user_id ON ta_oauth_consent (user_id);
CREATE TABLE ta_oauth_token (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  token_hash text NOT NULL,
  family_id text NOT NULL,
  user_id text NOT NULL,
  client_id text NOT NULL,
  scopes jsonb NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE UNIQUE INDEX ux_ta_oauth_token__token_hash ON ta_oauth_token (token_hash);
CREATE INDEX ix_ta_oauth_token__user_id ON ta_oauth_token (user_id);
CREATE INDEX ix_ta_oauth_token__family_id ON ta_oauth_token (family_id);
CREATE INDEX ix_ta_oauth_token__client_id ON ta_oauth_token (client_id);
UPDATE ta_meta SET value = '7' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '4' WHERE key = 'compat_better_auth';
`,
  sqlite: `CREATE TABLE ta_jwk (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  public_jwk TEXT NOT NULL,
  private_key TEXT NOT NULL,
  slot TEXT,
  retired_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_jwk__slot ON ta_jwk (slot);
CREATE TABLE ta_oauth_client (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  redirect_uris TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE ta_oauth_consent (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_consent__client_id__user_id ON ta_oauth_consent (client_id, user_id);
CREATE INDEX ix_ta_oauth_consent__user_id ON ta_oauth_consent (user_id);
CREATE TABLE ta_oauth_token (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE UNIQUE INDEX ux_ta_oauth_token__token_hash ON ta_oauth_token (token_hash);
CREATE INDEX ix_ta_oauth_token__user_id ON ta_oauth_token (user_id);
CREATE INDEX ix_ta_oauth_token__family_id ON ta_oauth_token (family_id);
CREATE INDEX ix_ta_oauth_token__client_id ON ta_oauth_token (client_id);
UPDATE ta_meta SET value = '7' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '4' WHERE key = 'compat_better_auth';
`,
};

export const MIGRATION_0005_NAME = "0005_compat_schema_v8";

/**
 * Migration 0005 (plan 12c): core's schema version 8. Core 8 adds the
 * `secondFactor` model: the factor apart from its methods. This package
 * keeps the factor in core's own tables (plan 9f), so this migration creates
 * core's `ta_second_factor` beside them, with core 0008's names, columns, and
 * index, and copies each enabled `ta_totp` row into it with the same id: a
 * backup code hash is keyed by the row id, so every stored code stays valid.
 * The text is the same for every naming and for both D1 variants: it names
 * `ta_` tables only. Append-only.
 */
export const COMPAT_MIGRATION_0005_SQL: Readonly<Record<"postgres" | "sqlite", string>> = {
  postgres: `CREATE TABLE ta_second_factor (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  enabled_at timestamptz NOT NULL,
  methods jsonb NOT NULL,
  backup_codes jsonb NOT NULL,
  backup_codes_version integer NOT NULL
);
CREATE UNIQUE INDEX ux_ta_second_factor__user_id ON ta_second_factor (user_id);
INSERT INTO ta_second_factor (id, created_at, updated_at, user_id, enabled_at, methods, backup_codes, backup_codes_version)
SELECT id, created_at, updated_at, user_id, enabled_at, '["totp"]'::jsonb, backup_codes, 1
FROM ta_totp
WHERE enabled_at IS NOT NULL;
-- A plan 9f setup holds codes of 8 to 12 characters. The person runs the setup again.
DELETE FROM ta_totp WHERE enabled_at IS NULL;
UPDATE ta_meta SET value = '8' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '5' WHERE key = 'compat_better_auth';
`,
  sqlite: `CREATE TABLE ta_second_factor (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  enabled_at INTEGER NOT NULL,
  methods TEXT NOT NULL,
  backup_codes TEXT NOT NULL,
  backup_codes_version INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_ta_second_factor__user_id ON ta_second_factor (user_id);
INSERT INTO ta_second_factor (id, created_at, updated_at, user_id, enabled_at, methods, backup_codes, backup_codes_version)
SELECT id, created_at, updated_at, user_id, enabled_at, '["totp"]', backup_codes, 1
FROM ta_totp
WHERE enabled_at IS NOT NULL;
-- A plan 9f setup holds codes of 8 to 12 characters. The person runs the setup again.
DELETE FROM ta_totp WHERE enabled_at IS NULL;
UPDATE ta_meta SET value = '8' WHERE key = 'schema_version';
UPDATE ta_meta SET value = '5' WHERE key = 'compat_better_auth';
`,
};

export const MIGRATION_0006_NAME = "0006_compat_schema_v9";

/**
 * Migration 0006 (plan 12b): core's schema version 9. Core 9 adds the
 * secret version of each sealed value and keyed hash. Core's own tables in
 * this database (`ta_totp`, `ta_second_factor`, `ta_jwk`) get
 * `secret_version`, and Better Auth's `verification` gets
 * `taSecretVersion`, which holds core's field. Every column defaults to 1,
 * the one secret of every value of today. The verification column takes the
 * app's naming, so the text depends on `names`: the D1 files in this package
 * are the text of the default naming, as for 0001. Append-only.
 */
export function compatMigration0006Sql(dialect: "postgres" | "sqlite", n: Names): string {
  const int = dialect === "postgres" ? "integer" : "INTEGER";
  const col = (table: string) =>
    `ALTER TABLE ${table} ADD COLUMN secret_version ${int} NOT NULL DEFAULT 1;`;
  return `${[
    col("ta_totp"),
    col("ta_second_factor"),
    col("ta_jwk"),
    `ALTER TABLE ${n.table("verification")} ADD COLUMN ${n.column("verification", "taSecretVersion")} ${int} NOT NULL DEFAULT 1;`,
    "UPDATE ta_meta SET value = '9' WHERE key = 'schema_version';",
    "UPDATE ta_meta SET value = '6' WHERE key = 'compat_better_auth';",
  ].join("\n")}\n`;
}

export const MIGRATION_0007_NAME = "0007_compat_schema_v10";

/**
 * Migration 0007 (plan 12a): core's schema version 10. Core 10 adds
 * `session.freshAt`, the time a sign-in or a re-authentication last proved
 * the person. Better Auth's `session` gets `taFreshAt`, which holds core's
 * field. It has no default and no fill: a session of today is not fresh, and
 * it re-authenticates once before its first sensitive change. Better Auth
 * ignores the extra column. The column takes the app's naming, so the text
 * depends on `names`: the D1 files in this package are the text of the
 * default naming, as for 0006. Append-only.
 */
export function compatMigration0007Sql(dialect: "postgres" | "sqlite", n: Names): string {
  const date = dialect === "postgres" ? "timestamptz" : "TEXT";
  return `${[
    `ALTER TABLE ${n.table("session")} ADD COLUMN ${n.column("session", "taFreshAt")} ${date};`,
    "UPDATE ta_meta SET value = '10' WHERE key = 'schema_version';",
    "UPDATE ta_meta SET value = '7' WHERE key = 'compat_better_auth';",
  ].join("\n")}\n`;
}

export const MIGRATION_0008_NAME = "0008_compat_schema_v11";

/** The core statements of migration 0008, by dialect: core 0011's text on core's own tables. */
const COMPAT_0008_CORE: Readonly<Record<"postgres" | "sqlite", string>> = {
  postgres: `ALTER TABLE ta_oauth_client ADD COLUMN auth_method text NOT NULL DEFAULT 'none';
ALTER TABLE ta_oauth_client ADD COLUMN secret_hash text;
ALTER TABLE ta_oauth_client ADD COLUMN secret_expires_at timestamptz;
ALTER TABLE ta_oauth_client ADD COLUMN previous_secret_hash text;
ALTER TABLE ta_oauth_client ADD COLUMN previous_secret_until timestamptz;
ALTER TABLE ta_oauth_client ADD COLUMN jwks jsonb;
ALTER TABLE ta_oauth_client ADD COLUMN jwks_uri text;
ALTER TABLE ta_oauth_client ADD COLUMN grant_types jsonb NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb;
ALTER TABLE ta_oauth_client ADD COLUMN credentials_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ta_oauth_client ADD COLUMN introspect boolean NOT NULL DEFAULT false;
ALTER TABLE ta_oauth_client ADD COLUMN post_logout_redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ta_oauth_client ADD COLUMN backchannel_logout_uri text;
ALTER TABLE ta_oauth_client ADD COLUMN backchannel_logout_session_required boolean NOT NULL DEFAULT false;
ALTER TABLE ta_oauth_client ADD COLUMN subject_type text NOT NULL DEFAULT 'public';
ALTER TABLE ta_oauth_client ADD COLUMN dpop_bound boolean NOT NULL DEFAULT false;
ALTER TABLE ta_oauth_token ADD COLUMN parent_id text;
ALTER TABLE ta_oauth_token ADD COLUMN dpop_jkt text;
CREATE INDEX ix_ta_oauth_token__parent_id ON ta_oauth_token (parent_id);
CREATE TABLE ta_oauth_device (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  device_code_hash text NOT NULL,
  user_code_hash text NOT NULL,
  secret_version integer NOT NULL,
  client_id text NOT NULL,
  scopes jsonb NOT NULL,
  resource text NOT NULL,
  status text NOT NULL,
  user_id text,
  session_id text,
  interval integer NOT NULL,
  last_polled_at timestamptz,
  dpop_jkt text,
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_device__device_code_hash ON ta_oauth_device (device_code_hash);
CREATE UNIQUE INDEX ux_ta_oauth_device__user_code_hash ON ta_oauth_device (user_code_hash);
CREATE INDEX ix_ta_oauth_device__expires_at ON ta_oauth_device (expires_at);
CREATE TABLE ta_oauth_subject (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  user_id text NOT NULL,
  sector text NOT NULL,
  subject text NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_subject__sector__user_id ON ta_oauth_subject (sector, user_id);
CREATE UNIQUE INDEX ux_ta_oauth_subject__subject ON ta_oauth_subject (subject);
CREATE INDEX ix_ta_oauth_subject__user_id ON ta_oauth_subject (user_id);
CREATE TABLE ta_oauth_session_client (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  session_id text NOT NULL,
  client_id text NOT NULL,
  user_id text NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_session_client__session_id__client_id ON ta_oauth_session_client (session_id, client_id);
CREATE INDEX ix_ta_oauth_session_client__user_id ON ta_oauth_session_client (user_id);
CREATE TABLE ta_oauth_logout (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  client_id text NOT NULL,
  user_id text NOT NULL,
  session_id text NOT NULL,
  attempts integer NOT NULL,
  next_attempt_at timestamptz NOT NULL
);
CREATE INDEX ix_ta_oauth_logout__next_attempt_at ON ta_oauth_logout (next_attempt_at);
CREATE INDEX ix_ta_oauth_logout__user_id ON ta_oauth_logout (user_id);`,
  sqlite: `ALTER TABLE ta_oauth_client ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE ta_oauth_client ADD COLUMN secret_hash TEXT;
ALTER TABLE ta_oauth_client ADD COLUMN secret_expires_at INTEGER;
ALTER TABLE ta_oauth_client ADD COLUMN previous_secret_hash TEXT;
ALTER TABLE ta_oauth_client ADD COLUMN previous_secret_until INTEGER;
ALTER TABLE ta_oauth_client ADD COLUMN jwks TEXT;
ALTER TABLE ta_oauth_client ADD COLUMN jwks_uri TEXT;
ALTER TABLE ta_oauth_client ADD COLUMN grant_types TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]';
ALTER TABLE ta_oauth_client ADD COLUMN credentials_scopes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ta_oauth_client ADD COLUMN introspect INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ta_oauth_client ADD COLUMN post_logout_redirect_uris TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ta_oauth_client ADD COLUMN backchannel_logout_uri TEXT;
ALTER TABLE ta_oauth_client ADD COLUMN backchannel_logout_session_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ta_oauth_client ADD COLUMN subject_type TEXT NOT NULL DEFAULT 'public';
ALTER TABLE ta_oauth_client ADD COLUMN dpop_bound INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ta_oauth_token ADD COLUMN parent_id TEXT;
ALTER TABLE ta_oauth_token ADD COLUMN dpop_jkt TEXT;
CREATE INDEX ix_ta_oauth_token__parent_id ON ta_oauth_token (parent_id);
CREATE TABLE ta_oauth_device (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  device_code_hash TEXT NOT NULL,
  user_code_hash TEXT NOT NULL,
  secret_version INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  interval INTEGER NOT NULL,
  last_polled_at INTEGER,
  dpop_jkt TEXT,
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_device__device_code_hash ON ta_oauth_device (device_code_hash);
CREATE UNIQUE INDEX ux_ta_oauth_device__user_code_hash ON ta_oauth_device (user_code_hash);
CREATE INDEX ix_ta_oauth_device__expires_at ON ta_oauth_device (expires_at);
CREATE TABLE ta_oauth_subject (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  sector TEXT NOT NULL,
  subject TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_subject__sector__user_id ON ta_oauth_subject (sector, user_id);
CREATE UNIQUE INDEX ux_ta_oauth_subject__subject ON ta_oauth_subject (subject);
CREATE INDEX ix_ta_oauth_subject__user_id ON ta_oauth_subject (user_id);
CREATE TABLE ta_oauth_session_client (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ta_oauth_session_client__session_id__client_id ON ta_oauth_session_client (session_id, client_id);
CREATE INDEX ix_ta_oauth_session_client__user_id ON ta_oauth_session_client (user_id);
CREATE TABLE ta_oauth_logout (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL
);
CREATE INDEX ix_ta_oauth_logout__next_attempt_at ON ta_oauth_logout (next_attempt_at);
CREATE INDEX ix_ta_oauth_logout__user_id ON ta_oauth_logout (user_id);`,
};

/**
 * Migration 0008 (plan 12e): core's schema version 11. Core 11 adds the
 * client fields of the OAuth provider's second version on `oauthClient`,
 * two fields on `oauthToken`, and the models `oauthDevice`, `oauthSubject`,
 * `oauthSessionClient`, and `oauthLogout`. Each one is core's own table in
 * this database (`CORE_TABLE_MODELS`), so the text is core 0011's
 * statements, with the same defaults: each client row of today reads as
 * the public client it was. The text names `ta_` tables only, so it is the
 * same for every naming and for both D1 variants. Append-only.
 */
export function compatMigration0008Sql(dialect: "postgres" | "sqlite"): string {
  return `${[
    COMPAT_0008_CORE[dialect],
    "UPDATE ta_meta SET value = '11' WHERE key = 'schema_version';",
    "UPDATE ta_meta SET value = '8' WHERE key = 'compat_better_auth';",
  ].join("\n")}\n`;
}

/** Postgres: now, cut to the millisecond precision that core reads back. */
const MS_NOW = "date_trunc('milliseconds', now())";

/** The core columns with no Better Auth column. `from` fills existing rows. */
const ADDED: readonly {
  table: BetterAuthTable;
  field: string;
  type: "date" | "text";
  from?: string;
}[] = [
  { table: "account", field: "taLinkedAt", type: "date", from: "createdAt" },
  { table: "session", field: "taLastSeenAt", type: "date", from: "updatedAt" },
  { table: "verification", field: "taPurpose", type: "text" },
  { table: "verification", field: "taValueHash", type: "text" },
  { table: "verification", field: "taConsumedAt", type: "date" },
  { table: "verification", field: "taData", type: "text" },
  { table: "passkey", field: "taUpdatedAt", type: "date", from: "createdAt" },
  { table: "organization", field: "taUpdatedAt", type: "date", from: "createdAt" },
  { table: "member", field: "taUpdatedAt", type: "date", from: "createdAt" },
  { table: "invitation", field: "taTokenHash", type: "text" },
  { table: "invitation", field: "taAcceptedAt", type: "date" },
  { table: "invitation", field: "taUpdatedAt", type: "date", from: "createdAt" },
];

/** The added dates that migration 0001 fills from a Better Auth column. The SQLite statements read `from` when the added column is null. */
export const FILLED_DATES = ADDED.filter(
  (a): a is (typeof ADDED)[number] & { from: string } => a.from !== undefined,
);

/** SQLite: a date as the ISO millisecond text core writes (toISOString), from either SQLite text form. */
export const sqliteIsoText = (col: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${col})`;

/**
 * The Better Auth date columns that core reads, per table. On SQLite each
 * must hold date text. A Drizzle schema with integer timestamps stores
 * numbers, which sort before every text and do not read as a date.
 */
const BETTER_AUTH_DATES: Readonly<Record<BetterAuthTable, readonly string[]>> = {
  user: ["createdAt", "updatedAt"],
  session: ["expiresAt", "createdAt", "updatedAt"],
  account: ["createdAt", "updatedAt"],
  verification: ["expiresAt", "createdAt", "updatedAt"],
  organization: ["createdAt"],
  member: ["createdAt"],
  invitation: ["expiresAt", "createdAt"],
  passkey: ["createdAt"],
};

/** The name of the CHECK that refuses a date that is not text. SQLite and D1 put it in the error text. */
export const SQLITE_DATE_CHECK = "tempo_auth_compat_every_better_auth_date_must_be_text";

/** The keys core's conformance suite needs and Better Auth lacks, plus core's two lookup indexes. (issuer, accountId) is separate: see SqliteVariant. */
const INDEXES: readonly {
  name: string;
  table: BetterAuthTable;
  fields: string[];
  unique: boolean;
}[] = [
  {
    name: "ix_session__active_organization_id",
    table: "session",
    fields: ["activeOrganizationId"],
    unique: false,
  },
  {
    name: "ux_verification__ta_value_hash",
    table: "verification",
    fields: ["taValueHash"],
    unique: true,
  },
  {
    name: "ix_verification__ta_purpose__identifier",
    table: "verification",
    fields: ["taPurpose", "identifier"],
    unique: false,
  },
  { name: "ux_passkey__credential_id", table: "passkey", fields: ["credentialID"], unique: true },
  {
    name: "ux_member__organization_id__user_id",
    table: "member",
    fields: ["organizationId", "userId"],
    unique: true,
  },
  {
    name: "ux_invitation__ta_token_hash",
    table: "invitation",
    fields: ["taTokenHash"],
    unique: true,
  },
  {
    name: "ix_invitation__organization_id__email",
    table: "invitation",
    fields: ["organizationId", "email"],
    unique: false,
  },
];

/**
 * `account.issuer` is on both dialects (spec 16.2): Better Auth 1.7 tables
 * have it, and a table from before 1.7 (consumer-i) gets it, filled from
 * `providerId`, and core's unique index on (issuer, accountId). Postgres
 * tests for the column and the index at run time. A SQLite file is static
 * and cannot test, so the D1 file comes in two variants: "1.7" fills only,
 * because a 1.7 table has the column and Better Auth's own unique index;
 * "before-1.7" adds the column and the index too.
 */
export type SqliteVariant = "1.7" | "before-1.7";

/**
 * Migration 0001: authtempo on the Better Auth tables. Append-only:
 * never change the text a shipped name produces. The two added tables are
 * ta_limit (core schema version 3's shape) and ta_meta, last, so a failed
 * run leaves no version row. schema_version is the literal '4', the core
 * version when 0001 shipped; migration 0002 moves it to 5. It is not read
 * from SCHEMA_VERSION, because a shipped migration never changes. `variant`
 * applies to SQLite only.
 */
export function compatMigrationSql(
  dialect: "postgres" | "sqlite",
  n: Names,
  variant: SqliteVariant = "1.7",
): string {
  const T = (t: BetterAuthTable) => n.table(t);
  const C = (t: BetterAuthTable, f: string) => n.column(t, f);
  const pg = dialect === "postgres";
  const date = pg ? "timestamptz" : "TEXT";
  const issuer = C("account", "issuer");
  const providerId = C("account", "providerId");
  // The named issuers come from ISSUERS, the table issuerFor reads (one
  // source). Any other provider id is 'local:oauth:' || providerId, which
  // equals issuerFor's encodeURIComponent form for every id of letters,
  // digits, and - _ . ! ~ * ' ( ). Rows that already have an issuer keep it.
  const cases = Object.entries(ISSUERS)
    .map(([id, value]) => `WHEN '${id}' THEN '${value}'`)
    .join(" ");
  const fillIssuer = `UPDATE ${T("account")} SET ${issuer} = CASE ${providerId} ${cases} ELSE 'local:oauth:' || ${providerId} END WHERE ${issuer} IS NULL;`;
  const issuerIndex = `CREATE UNIQUE INDEX ux_account__issuer__account_id ON ${T("account")} (${issuer}, ${C("account", "accountId")});`;
  const lines: string[] = [];
  if (pg) {
    const schemaExpr = n.pgSchema ? `'${n.pgSchema}'` : "current_schema()";
    const list = BETTER_AUTH_TABLES.map((t) => `'${n.rawTable(t)}'`).join(", ");
    lines.push(
      "DO $$ BEGIN",
      `  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = ${schemaExpr} AND table_name IN (${list}) AND data_type = 'timestamp without time zone') THEN`,
      "    RAISE EXCEPTION 'authtempo compat: every Better Auth date column must be timestamptz';",
      "  END IF;",
      "END $$;",
      "CREATE TABLE ta_limit (key text PRIMARY KEY, window_start bigint NOT NULL, count bigint NOT NULL, expires_at bigint NOT NULL);",
      `ALTER TABLE ${T("account")} ADD COLUMN IF NOT EXISTS ${issuer} text;`,
      fillIssuer,
      // Better Auth 1.7 has its own unique index on (issuer, accountId), under
      // its own name (account_issuer_accountId_uidx). A second equal index
      // costs one more index write per account insert. So look for any
      // valid, unique, non-partial index on exactly these two columns, by
      // any name. The names sort in byte order on both sides: COLLATE "C"
      // in SQL, and JavaScript's sort() in code-unit order.
      "DO $$ BEGIN",
      `  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace s ON s.oid = t.relnamespace WHERE s.nspname = ${schemaExpr} AND t.relname = '${n.rawTable("account")}' AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indnatts = 2 AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C") FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY (i.indkey)) = ARRAY[${[
        n.rawColumn("account", "issuer"),
        n.rawColumn("account", "accountId"),
      ]
        .sort()
        .map((c) => `'${c}'`)
        .join(", ")}]) THEN`,
      `    ${issuerIndex}`,
      "  END IF;",
      "END $$;",
      `UPDATE ${T("passkey")} SET ${C("passkey", "createdAt")} = ${MS_NOW} WHERE ${C("passkey", "createdAt")} IS NULL;`,
    );
  } else {
    // A static file cannot raise an error, so a CHECK refuses the run: the
    // INSERT writes 0 when any Better Auth date is not text that SQLite reads
    // as a date. D1 refuses TEMP tables (SQLITE_AUTH, probed 2026-10-10), so
    // the check table is a plain one that the next statement drops.
    // One EXISTS per table, joined with OR: D1 refuses a compound SELECT
    // (UNION ALL) of this many terms ("too many terms", run 2026-10-10).
    const notDate = BETTER_AUTH_TABLES.map((t) => {
      const bad = BETTER_AUTH_DATES[t]
        .map((f) => C(t, f))
        .map((c) => `(${c} IS NOT NULL AND (typeof(${c}) <> 'text' OR julianday(${c}) IS NULL))`)
        .join(" OR ");
      return `EXISTS (SELECT 1 FROM ${T(t)} WHERE ${bad})`;
    }).join(" OR ");
    // The statements that fail on the wrong variant (issuer) come before the
    // first CREATE TABLE, and the CREATE TABLE ta_limit that fails on a second
    // run comes after only idempotent fills. So a runner that does not roll
    // back a failed file (a plain `d1 execute --file`) is left with no change.
    lines.push(
      `CREATE TABLE IF NOT EXISTS ta_date_check (ok INTEGER CONSTRAINT ${SQLITE_DATE_CHECK} CHECK (ok = 1));`,
      `INSERT INTO ta_date_check (ok) SELECT NOT (${notDate});`,
      "DROP TABLE ta_date_check;",
      ...(variant === "before-1.7"
        ? [`ALTER TABLE ${T("account")} ADD COLUMN ${issuer} TEXT;`]
        : []),
      fillIssuer,
      ...(variant === "before-1.7" ? [issuerIndex] : []),
      `UPDATE ${T("passkey")} SET ${C("passkey", "createdAt")} = ${sqliteIsoText("'now'")} WHERE ${C("passkey", "createdAt")} IS NULL;`,
      "CREATE TABLE ta_limit (key TEXT PRIMARY KEY NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);",
    );
  }
  lines.push("CREATE INDEX ix_ta_limit__expires_at ON ta_limit (expires_at);");
  for (const a of ADDED) {
    // Postgres: a column filled from a Better Auth column also gets a
    // default, so a row that another writer adds after the migration (an old
    // replica during the deploy, the app's own SQL) has a value. Without it
    // core reads null in a field that is not nullable and throws
    // schema_mismatch on that row. The value is cut to milliseconds, the
    // precision core reads back (to_char ... MS): a guard that compares a
    // read value with `eq` (ownerWrite on organization.updatedAt) then
    // matches. SQLite's ALTER TABLE takes no expression default: its fill
    // writes the ISO millisecond text core writes, from either SQLite date
    // form, and the SQLite statements read the `from` column when the added
    // one is null (statements.ts, `value`).
    const def = pg && a.from ? ` DEFAULT ${MS_NOW}` : "";
    lines.push(
      `ALTER TABLE ${T(a.table)} ADD COLUMN ${C(a.table, a.field)} ${a.type === "date" ? date : pg ? "text" : "TEXT"}${def};`,
    );
    if (a.from) {
      const from = C(a.table, a.from);
      lines.push(
        `UPDATE ${T(a.table)} SET ${C(a.table, a.field)} = ${pg ? `date_trunc('milliseconds', ${from})` : sqliteIsoText(from)};`,
      );
    }
  }
  for (const i of INDEXES) {
    lines.push(
      `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${i.name} ON ${T(i.table)} (${i.fields.map((f) => C(i.table, f)).join(", ")});`,
    );
  }
  lines.push(
    pg
      ? "CREATE TABLE ta_meta (key text PRIMARY KEY, value text NOT NULL);"
      : "CREATE TABLE ta_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
    "INSERT INTO ta_meta (key, value) VALUES ('schema_version', '4'), ('compat_better_auth', '1');",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The names of the compat migrations, in order (plan 11c). Each name is the
 * file name, without `.sql`, under `migrations/d1/` and
 * `migrations/d1-before-1.7/`, and the name that the Postgres runner below
 * reports. The CLI reads this list; a test of the CLI holds it to the files.
 */
export const COMPAT_MIGRATION_NAMES: readonly string[] = [
  MIGRATION_NAME,
  MIGRATION_0002_NAME,
  MIGRATION_0003_NAME,
  MIGRATION_0004_NAME,
  MIGRATION_0005_NAME,
  MIGRATION_0006_NAME,
  MIGRATION_0007_NAME,
  MIGRATION_0008_NAME,
];

/**
 * The Postgres text of each compat migration, in the order of
 * COMPAT_MIGRATION_NAMES (review of plan 11c, m13). The runner takes its
 * names from that list, so the CLI, the D1 files, and the runner cannot
 * drift apart. A length that differs stops the module at load.
 */
const POSTGRES_TEXTS: readonly ((names: Names) => string)[] = [
  (names) => compatMigrationSql("postgres", names),
  () => COMPAT_MIGRATION_0002_SQL,
  () => COMPAT_MIGRATION_0003_SQL.postgres,
  () => COMPAT_MIGRATION_0004_SQL.postgres,
  () => COMPAT_MIGRATION_0005_SQL.postgres,
  (names) => compatMigration0006Sql("postgres", names),
  (names) => compatMigration0007Sql("postgres", names),
  () => compatMigration0008Sql("postgres"),
];
if (POSTGRES_TEXTS.length !== COMPAT_MIGRATION_NAMES.length)
  throw new Error(
    `the compat runner has ${POSTGRES_TEXTS.length} texts for ${COMPAT_MIGRATION_NAMES.length} names in COMPAT_MIGRATION_NAMES`,
  );

/** One fixed advisory lock key for every compat migration run. */
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('tempo_auth_compat_migrations'))";

/**
 * Applies the compat migrations the database does not hold yet, each in its
 * own transaction under one advisory lock, so two replicas that deploy at
 * once run each migration once. The applied version is the
 * `compat_better_auth` row of ta_meta: no third table.
 */
export async function applyBetterAuthCompatMigrations(sql: Sql, names: Names): Promise<string[]> {
  // Migration n writes compat_better_auth = n, so the version is the place in the list.
  const migrations = COMPAT_MIGRATION_NAMES.map((name, i) => ({
    version: i + 1,
    name,
    text: (POSTGRES_TEXTS[i] as (names: Names) => string)(names),
  }));
  const applied: string[] = [];
  for (const m of migrations) {
    const ran = await sql.begin(async (tx) => {
      await tx.unsafe(LOCK);
      const reg = await tx.unsafe<{ t: string | null }[]>(
        "SELECT to_regclass('ta_meta')::text AS t",
      );
      let current = 0;
      if (reg[0]?.t) {
        const rows = await tx.unsafe<{ value: string }[]>(
          `SELECT value FROM ${META_TABLE} WHERE key = $1`,
          [COMPAT_META_KEY],
        );
        current = Number(rows[0]?.value ?? "0");
      }
      if (current >= m.version) return false;
      await tx.unsafe(m.text);
      return true;
    });
    if (ran) applied.push(m.name);
  }
  return applied;
}

/** Core's schema version gate, then the mapping version. A failed check is not kept. */
export function compatVersionGate(
  readSchema: () => Promise<string | null>,
  readCompat: () => Promise<string | null>,
): () => Promise<void> {
  const core = schemaVersionGate(readSchema);
  let checked: Promise<void> | null = null;
  return () => {
    checked ??= (async () => {
      try {
        await core();
        const value = await Promise.resolve().then(readCompat);
        const found = value === null ? Number.NaN : Number(value);
        if (!Number.isInteger(found) || found < COMPAT_SCHEMA_VERSION) {
          throw new StorageError("schema_mismatch", "meta", [
            `${COMPAT_META_KEY}:${value ?? "none"}`,
          ]);
        }
      } catch (e) {
        checked = null;
        throw e;
      }
    })();
    return checked;
  };
}

/** Only an undefined table (42P01) reads as "no version"; any other error passes through. */
export function postgresCompatReady(sql: Sql): () => Promise<void> {
  const read = async (key: string) => {
    try {
      const rows = await sql.unsafe<{ value: string }[]>(
        `SELECT value FROM ${META_TABLE} WHERE key = $1`,
        [key],
      );
      return rows[0]?.value ?? null;
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === "42P01") return null;
      throw e;
    }
  };
  return compatVersionGate(
    () => read(SCHEMA_VERSION_KEY),
    () => read(COMPAT_META_KEY),
  );
}

interface D1Readable {
  prepare(query: string): {
    bind(...values: unknown[]): { first(column: string): Promise<unknown> };
    all(): Promise<{ results: Record<string, unknown>[] }>;
  };
}

/**
 * Only "no such table" reads as "no version"; any other D1 error passes
 * through. The 1.7 file adds no (issuer, accountId) index: it trusts
 * Better Auth's own. So the check also needs a unique, non-partial index on
 * exactly these two columns, by any name. Without it two OAuth callbacks
 * for one subject both insert, and two users own one identity. The check
 * runs once per storage; a failed check is not kept.
 */
export function d1CompatReady(db: unknown, names: Names): () => Promise<void> {
  const d1 = db as D1Readable;
  const read = async (key: string) => {
    try {
      const v = await d1
        .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
        .bind(key)
        .first("value");
      return typeof v === "string" ? v : null;
    } catch (e) {
      if (e instanceof Error && e.message.includes("no such table")) return null;
      throw e;
    }
  };
  const version = compatVersionGate(
    () => read(SCHEMA_VERSION_KEY),
    () => read(COMPAT_META_KEY),
  );
  // SQLite matches names without case, so the compare does too.
  const want = [names.rawColumn("account", "issuer"), names.rawColumn("account", "accountId")]
    .map((c) => c.toLowerCase())
    .sort()
    .join(",");
  const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
  const hasIssuerKey = async () => {
    const list = await d1.prepare(`PRAGMA index_list(${quote(names.rawTable("account"))})`).all();
    for (const i of list.results) {
      if (i.unique !== 1 || i.partial !== 0) continue;
      const cols = await d1.prepare(`PRAGMA index_info(${quote(String(i.name))})`).all();
      const got = cols.results
        .map((c) => String(c.name).toLowerCase())
        .sort()
        .join(",");
      if (got === want) return true;
    }
    return false;
  };
  let checked: Promise<void> | null = null;
  return () => {
    checked ??= (async () => {
      try {
        await version();
        if (!(await hasIssuerKey())) {
          const e = new StorageError("schema_mismatch", "identity", ["provider", "subject"]);
          e.message = `${e.message}: no unique index on ${names.rawTable("account")} (${names.rawColumn("account", "issuer")}, ${names.rawColumn("account", "accountId")})`;
          throw e;
        }
      } catch (e) {
        checked = null;
        throw e;
      }
    })();
    return checked;
  };
}
