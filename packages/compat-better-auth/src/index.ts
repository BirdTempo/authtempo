// The server entry. Under the alias it answers `better-auth`,
// `@better-auth/drizzle-adapter`, `@better-auth/expo`, and `@better-auth/passkey`.

export { type DrizzleAdapterConfig, drizzleAdapter } from "./adapters/drizzle.js";
export { BetterAuthCompatError } from "./compat-error.js";
export { betterAuthPasswordHash, SCRYPT, type ScryptFn } from "./hash.js";
export { expo, passkey } from "./plugins.js";
export {
  betterAuthSchemaStorage,
  type D1DatabaseLike,
  type D1SchemaStorage,
  type D1SchemaStorageOptions,
  type PostgresSchemaStorage,
  type PostgresSchemaStorageOptions,
} from "./storage/index.js";
export { applyBetterAuthCompatMigrations, compatMigrationSql } from "./storage/migration.js";
export { type NamingOptions, resolveNames } from "./storage/names.js";
export type * from "./types.js";
