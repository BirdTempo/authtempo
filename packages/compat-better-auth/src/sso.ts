// `sso` and `scim` of the server entry. Under the alias the entry answers
// `@better-auth/sso` and `@better-auth/scim` (plan 12d Task 14).
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex } from "./hash.js";
import {
  COMPAT_PLUGIN,
  type ScimCredentialOptions,
  type ScimMarkerOptions,
  type ScimOptions,
  type ScimPlugin,
  type SsoOptions,
  type SsoPlugin,
} from "./types.js";

/**
 * The Better Auth versions whose typings and code the two markers read: the
 * tarballs of @better-auth/sso and @better-auth/scim, read 2026-10-22.
 */
export const BETTER_AUTH_SSO_VERSION = "1.7.2";
export const BETTER_AUTH_SCIM_VERSION = "1.7.2";

/**
 * Better Auth's `sso(options)` on core's SSO (plan 12d, spec 30). A marker,
 * as the other plugins: `betterAuth` checks and maps the options.
 */
export function sso(options: SsoOptions = {}): SsoPlugin {
  return { kind: COMPAT_PLUGIN, id: "sso", options };
}

/**
 * Better Auth's `scim(options)` on core's SCIM server. The marker keeps the
 * SHA-256 of each credential's token in hex and drops the token, so no
 * object of the shim holds it. The shim checks a bearer by its hash.
 */
export function scim(options: ScimOptions): ScimPlugin {
  const connections = Array.isArray(options?.connections)
    ? options.connections.map((c) => ({
        ...c,
        credentials: Array.isArray(c?.credentials)
          ? c.credentials.map(({ token, ...rest }: ScimCredentialOptions) => ({
              ...rest,
              tokenHash:
                typeof token === "string" && token !== ""
                  ? toHex(sha256(new TextEncoder().encode(token)))
                  : null,
            }))
          : c?.credentials,
      }))
    : options?.connections;
  return {
    kind: COMPAT_PLUGIN,
    id: "scim",
    options: { ...options, connections } as ScimMarkerOptions,
  };
}
