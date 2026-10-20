// The server entry. Under the alias it answers `better-auth`,
// `@better-auth/drizzle-adapter`, `@better-auth/expo`, and `@better-auth/passkey`.

export { type DrizzleAdapterConfig, drizzleAdapter } from "./adapters/drizzle.js";
export { BetterAuthCompatError } from "./compat-error.js";
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
  compatMigrationSql,
} from "./storage/migration.js";
export { type NamingOptions, resolveNames } from "./storage/names.js";
export type * from "./types.js";
