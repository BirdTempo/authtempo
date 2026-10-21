/**
 * The grant types of the token endpoint. The file imports nothing, so the
 * event table reads them with no import cycle (plan 12h Task 6).
 */

/** The grants of every provider. */
export const GRANT_TYPES: readonly string[] = ["authorization_code", "refresh_token"];
/** RFC 8628 section 3.4 (read 2026-10-20): the grant type of a device poll (plan 12e). */
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** The grant type of RFC 6749 section 4.4.2 (plan 12e). */
export const CREDENTIALS_GRANT = "client_credentials";
/** Every grant that some config serves: the `grant` list of the `oauth.token` event. */
export const ALL_GRANT_TYPES: readonly string[] = [...GRANT_TYPES, CREDENTIALS_GRANT, DEVICE_GRANT];
