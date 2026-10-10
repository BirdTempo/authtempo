// The server entry. Under the alias it answers `better-auth`,
// `@better-auth/drizzle-adapter`, `@better-auth/expo`, and `@better-auth/passkey`.

export { betterAuthPasswordHash, SCRYPT, type ScryptFn } from "./hash.js";
export { expo, passkey } from "./plugins.js";
export type * from "./types.js";
