/**
 * The reasons of the two fetched documents of a client: a client metadata
 * document and a `jwks_uri` key set. Each log line of a refusal names one
 * of these texts, never the document (plan 12h). The event table reads these
 * lists, so a new reason joins its event by this file. The file imports
 * nothing, so the event table can read it with no import cycle.
 */

/** The media type of a client metadata document (the CIMD draft). */
export const CIMD_TYPES: readonly string[] = ["application/json"];
/** The read cap of a client metadata document. */
export const CIMD_MAX_BYTES = 8192;
/** A key set may also come as the JWK Set type that RFC 7517 section 8.5 registers. */
export const JWKS_TYPES: readonly string[] = ["application/json", "application/jwk-set+json"];
/** The read cap of a `jwks_uri` set: ten RSA keys with long members fit with a margin. */
export const JWKS_MAX_BYTES = 65_536;

/** The fixed reasons of a guarded fetch. A status other than 200 is the reason `status` with its number. */
export const FETCH_REFUSALS = [
  "no fetch",
  "the fetch failed or timed out",
  "not JSON",
  "not a JSON object",
] as const;

/** The reason of a media type outside `types`. */
export function notOfTypes(types: readonly string[]): string {
  return `not ${types.join(" or ")}`;
}

/** The reason of a body over `max` bytes, a body that is not UTF-8, or a body that is late. */
export function overCap(max: number): string {
  return `larger than ${max} bytes, not UTF-8, or not in time`;
}

/** The rules of a document that are not one member (-02 sections 4 and 4.1). */
export const CIMD_RULES = [
  "client_id is not the document URL",
  "client_secret is present (-02 section 4.1)",
  "client_secret_expires_at is present (-02 section 4.1)",
  "token_endpoint_auth_method is not none or private_key_jwt (-02 section 4.1)",
] as const;
export type CimdRule = (typeof CIMD_RULES)[number];

/** The members that a metadata read refuses by name. `oauth` is the refusal with no provider. */
export const METADATA_MEMBERS = [
  "oauth",
  "redirect_uris",
  "client_name",
  "token_endpoint_auth_method",
  "grant_types",
  "response_types",
  "jwks_uri",
  "jwks",
  "post_logout_redirect_uris",
  "backchannel_logout_uri",
  "backchannel_logout_session_required",
  "subject_type",
  "sector_identifier_uri",
  "id_token_signed_response_alg",
  "dpop_bound_access_tokens",
  "credentials_scopes",
  "introspect",
] as const;
export type MetadataMember = (typeof METADATA_MEMBERS)[number];

/** The rules of a key set after its fetch. */
export const KEY_SET_RULES = ["no keys array", "no public signing key"] as const;
