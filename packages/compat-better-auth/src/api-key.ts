// The entry `./api-key`. Under the alias it answers `@better-auth/api-key`.
import { type ApiKeyOptions, type ApiKeyPlugin, COMPAT_PLUGIN } from "./types.js";

export type { ApiKeyOptions, ApiKeyPlugin } from "./types.js";

/**
 * The @better-auth/api-key version whose typings, rules, and stored row the
 * shim reads (consumerb's pin, read 2026-10-21). The rest of the package
 * reads Better Auth 1.7.2.
 */
export const BETTER_AUTH_API_KEY_VERSION = "1.7.5";

/**
 * Better Auth's `apiKey(options)` on core's tokens (plan 12k Task 12). A
 * marker, as the other plugins: `betterAuth` checks and maps the options.
 * Better Auth 1.7.5 also takes a list of configurations, each with its own
 * `configId`. Core keeps one token model, so a list is refused (deviation
 * 15 of plan 12k).
 */
export function apiKey(options: ApiKeyOptions = {}): ApiKeyPlugin {
  return { kind: COMPAT_PLUGIN, id: "api-key", options };
}
