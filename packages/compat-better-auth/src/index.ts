// The server entry. Under the alias it answers `better-auth`,
// `@better-auth/drizzle-adapter`, `@better-auth/expo`, and `@better-auth/passkey`.
// `@better-auth/api-key` is the entry `./api-key` (plan 12k Task 12).
// `@better-auth/sso` and `@better-auth/scim` are this entry too (plan 12d Task 14).

export { type DrizzleAdapterConfig, drizzleAdapter } from "./adapters/drizzle.js";
export { BetterAuthCompatError } from "./compat-error.js";
export {
  type CopySsoInput,
  type CopySsoReport,
  copyBetterAuthSso,
} from "./copy-sso.js";
export {
  APIError,
  BETTER_AUTH_CODES,
  COMPAT_CODES,
  type CompatCode,
  NOT_SUPPORTED,
} from "./errors.js";
export { betterAuthPasswordHash, SCRYPT, type ScryptFn } from "./hash.js";
export { expo, passkey } from "./plugins.js";
export { betterAuth } from "./server/better-auth.js";
export { movedKeyPrefixesOf } from "./server/map-options.js";
export {
  BETTER_AUTH_SCIM_VERSION,
  BETTER_AUTH_SSO_VERSION,
  scim,
  sso,
} from "./sso.js";
export {
  type ApiKeyMoveInput,
  type ApiKeyMoveReport,
  moveBetterAuthApiKeys,
  type SkipReason,
} from "./storage/api-keys.js";
export {
  betterAuthSchemaStorage,
  type D1DatabaseLike,
  type D1SchemaStorage,
  type D1SchemaStorageOptions,
  type PostgresSchemaStorage,
  type PostgresSchemaStorageOptions,
} from "./storage/index.js";
export {
  applyBetterAuthCompatMigrations,
  COMPAT_MIGRATION_NAMES,
  compatMigration0006Sql,
  compatMigration0007Sql,
  compatMigration0008Sql,
  compatMigration0009Sql,
  compatMigration0010Sql,
  compatMigration0011Sql,
  compatMigration0012Sql,
  compatMigrationSql,
} from "./storage/migration.js";
export { type NamingOptions, resolveNames } from "./storage/names.js";
export type * from "./types.js";
export { BETTER_AUTH_RANGE, inRange } from "./version.js";
