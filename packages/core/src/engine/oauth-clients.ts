import type { ResolvedConfig, ResolvedOAuth } from "../config.js";
import type { OAuthErrorCode } from "../errors.js";
import { ipKey } from "../limiter/ip-key.js";
import { limit } from "../limiter/limit.js";
import type { Observer } from "../observe/observer.js";
import { constantTimeEqual, randomToken, sha256Hex } from "../primitives/crypto.js";
import { FOREIGN_ALGS, keyFitsAlg } from "../primitives/foreign-jwk.js";
import { HTTP_LOOPBACK, isIpLiteral, isLocalHost } from "../primitives/host.js";
import { hasControlChar } from "../primitives/text.js";
import { clientRef } from "../redact.js";
import type { ClientAuthMethod, OAuthClientRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { newClientSecret } from "./oauth-client-secret.js";
import { deleteFamilies, endFamilies, familyEnds } from "./oauth-family.js";
import { CREDENTIALS_GRANT, DEVICE_GRANT, GRANT_TYPES } from "./oauth-grant-types.js";
import {
  CIMD_MAX_BYTES,
  CIMD_TYPES,
  type CimdRule,
  JWKS_MAX_BYTES,
  JWKS_TYPES,
  type MetadataMember,
  notOfTypes,
  overCap,
} from "./oauth-refusals.js";
import { BUILT_IN_SCOPES, type OAuthResult, oauthFail, oauthOk } from "./oauth-result.js";
import { redirectSector } from "./oauth-subject.js";

/**
 * The OAuth clients (plan 9g, spec 8.13 item 1; plan 12e, spec 8.16). A
 * client is public (`none`, PKCE binds each code to it) or confidential (a
 * `cs_` secret or `private_key_jwt`). A registered client has a `cl_` id
 * from RFC 7591 or `api.oauth.clients`. A CIMD client is the URL of its own
 * metadata document. Core implements draft-ietf-oauth-client-id-metadata-document-02
 * (6 July 2026) and accepts the documents of -00, which MCP 2026-07-28 pins.
 * Both drafts were read on 2026-10-19 (plan 12e Task 6).
 */

/** The CIMD draft that core implements (plan 12e Task 6). */
export const CIMD_REVISION = "draft-ietf-oauth-client-id-metadata-document-02";

export const CLIENT_ID_PREFIX = "cl_";
/** The kinds of a client with a `cl_` id: a registration's and an `api.oauth.clients` one's. */
const CL_KINDS: readonly OAuthClientRow["kind"][] = ["registered", "api"];
const CLIENT_ID_RE = /^cl_[A-Za-z0-9_-]{43}$/;
const REGISTER_PER_IP = { seconds: 3600, max: 10 };
export const CIMD_TIMEOUT_MS = 10_000;
/** -02 section 8.7 recommends 5 KB; 8 KB keeps a margin for a long jwks (plan 12e). The value is in `oauth-refusals.ts`. */
export { CIMD_MAX_BYTES };
export const CIMD_CACHE_MS = 3_600_000;
/** The documents one isolate keeps. The oldest goes first. */
const CIMD_CACHE_MAX = 500;
const REDIRECT_MAX = 10;
const URI_MAX = 2048;
const NAME_MAX = 80;
/** A busy client must not write its row on every request. */
const LAST_SEEN_EVERY_MS = 86_400_000;

// The grant types live in a file with no import, for the event table (plan 12h).
export { CREDENTIALS_GRANT, DEVICE_GRANT };

/**
 * The grants that only a client of `api.oauth.clients` takes, beside the
 * registration ones. A registration never takes `client_credentials`: a
 * stranger must not get a machine client. Every source takes the device
 * grant while `oauth.device` is on, and refuses it while it is off.
 */
const CREATE_ONLY_GRANT_TYPES = [CREDENTIALS_GRANT];
/**
 * The grants of the token endpoint under this config. The token route and
 * the metadata documents both read this list, so the two cannot differ.
 */
export function tokenGrantTypes(oauth: ResolvedOAuth): string[] {
  return [
    ...GRANT_TYPES,
    ...CREATE_ONLY_GRANT_TYPES,
    ...(oauth.device !== null ? [DEVICE_GRANT] : []),
  ];
}
const RESPONSE_TYPES = ["code"];
/**
 * The client auth methods that `authenticateClient` takes. The registration
 * check and the metadata documents read this list.
 */
export const AUTH_METHODS: readonly ClientAuthMethod[] = [
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
];
/** The subject types of OIDC Core 1.0 section 8 that a client may ask for (plan 12e). */
export const SUBJECT_TYPES: readonly OAuthClientRow["subjectType"][] = ["public", "pairwise"];
const isSubjectType = (v: unknown): v is OAuthClientRow["subjectType"] =>
  (SUBJECT_TYPES as readonly unknown[]).includes(v);
/** A client key set holds 1 to 10 keys: room for a rotation, and a bound on each assertion check. */
export const CLIENT_KEYS_MAX = 10;
/** The key sets of `jwks_uri` that one isolate keeps, each for one hour. The oldest goes first. */
const JWKS_CACHE_MAX = 500;
const JWKS_CACHE_MS = 3_600_000;
/**
 * A `kid` that the kept set does not hold reads the set again, at most once
 * per 30 seconds per URL. A client that rotates its key gets the new key
 * soon, and a stranger's unknown kid cannot make core fetch on each request.
 */
const JWKS_REREAD_MS = 30_000;
/**
 * The methods of a metadata document (-02 section 4.1): no method of a
 * shared secret, because a document cannot hold one. With `private_key_jwt`
 * the keys of the document make a confidential client.
 */
const CIMD_AUTH_METHODS: readonly unknown[] = ["none", "private_key_jwt"];

/**
 * The fields of schema version 11 for a public client with no secret (plan
 * 12e). Migration 0011 gives each row of version 10 the same values, so a
 * client of this plan's registration and an old row read alike. A new
 * object per call: no two rows share an array.
 */
export function publicClientFields(): Omit<
  OAuthClientRow,
  "id" | "createdAt" | "updatedAt" | "kind" | "name" | "redirectUris" | "lastSeenAt"
> {
  return {
    authMethod: "none",
    secretHash: null,
    secretExpiresAt: null,
    previousSecretHash: null,
    previousSecretUntil: null,
    jwks: null,
    jwksUri: null,
    grantTypes: [...GRANT_TYPES],
    credentialsScopes: [],
    introspect: false,
    postLogoutRedirectUris: [],
    backchannelLogoutUri: null,
    backchannelLogoutSessionRequired: false,
    subjectType: "public",
    dpopBound: false,
  };
}
/** Schemes that run code or read local data in a browser: never a redirect target. */
const BLOCKED_SCHEMES: ReadonlySet<string> = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "blob:",
  "about:",
  "filesystem:",
  "ws:",
  "wss:",
  "ftp:",
]);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:$/;

/** One key set of a `jwks_uri` in the isolate cache. */
export interface JwksEntry {
  /** The keys, or null for a failed read of a URL with no set: a 30-second negative entry. */
  keys: Record<string, unknown>[] | null;
  /** Epoch milliseconds by the config clock. */
  until: number;
  /** The last read of the URL, in epoch milliseconds: the bound of a read for an unknown kid. */
  readAt: number;
}

/** A read metadata document in the isolate cache: the fields of its row (plan 12e Task 6). */
export interface CimdEntry extends ClientFields {
  /** Epoch milliseconds by the config clock. */
  until: number;
}

/** The answer of a registration: RFC 7591 section 3.2.1, every registered field in its metadata name. */
export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: ClientAuthMethod;
  grant_types: string[];
  response_types: string[];
  jwks?: Record<string, unknown>;
  jwks_uri?: string;
  post_logout_redirect_uris?: string[];
  backchannel_logout_uri?: string;
  backchannel_logout_session_required?: boolean;
  subject_type: "public" | "pairwise";
  id_token_signed_response_alg: string;
  dpop_bound_access_tokens: boolean;
  /** Present once, in this answer, for a secret client. */
  client_secret?: string;
  /** 0: the secret does not expire (OIDC Registration 3.2). Present with `client_secret`. */
  client_secret_expires_at?: number;
}

/** The fields of a client row that its metadata sets: every field but the id, the kind, the times, and the secret. */
export type ClientFields = Pick<
  OAuthClientRow,
  | "name"
  | "redirectUris"
  | "authMethod"
  | "jwks"
  | "jwksUri"
  | "grantTypes"
  | "credentialsScopes"
  | "introspect"
  | "postLogoutRedirectUris"
  | "backchannelLogoutUri"
  | "backchannelLogoutSessionRequired"
  | "subjectType"
  | "dpopBound"
>;

/**
 * One redirect URI of a public client (RFC 8252 sections 7.1 and 7.3, the
 * OAuth 2.1 draft): https; http on a loopback host with any port; or a
 * private-use scheme. No fragment, no credentials, no control character.
 */
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > URI_MAX) return false;
  if (value.includes("#") || hasControlChar(value)) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "") return false;
  if (u.protocol === "https:") return true;
  // `hostname` is the parsed form, so `127.1` and `0x7f.0.0.1` pass as
  // 127.0.0.1. The list keeps the raw value, and the authorize step matches
  // the raw value exactly, so an odd form is still a loopback URI: harmless.
  if (u.protocol === "http:") return HTTP_LOOPBACK.has(u.hostname);
  return SCHEME_RE.test(u.protocol) && !BLOCKED_SCHEMES.has(u.protocol);
}

/**
 * The web origins of a client's redirect URIs (plan 11d): the origin of each
 * `https` URI, and of each `http` URI on a loopback host. A private-use
 * scheme has no web origin (its URL origin is "null") and adds none, so a
 * native client gets no CORS at the token endpoint.
 */
export function redirectOrigins(redirectUris: readonly string[]): Set<string> {
  const origins = new Set<string>();
  for (const uri of redirectUris) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      continue;
    }
    if (u.protocol === "https:" || (u.protocol === "http:" && HTTP_LOOPBACK.has(u.hostname)))
      origins.add(u.origin);
  }
  return origins;
}

/**
 * The origin check of the token endpoint (plan 11d): 60 per IP per 15
 * minutes, at the POST and at the preflight of a foreign origin, before the
 * client read. It has its own key, so a server request keeps the budget of
 * `oauth-token:ip`.
 */
export const ORIGIN_CHECK_PER_IP = { seconds: 900, max: 60 };

/**
 * A registered `cl_` client by its id, with no write and no fetch: the read
 * of a CORS preflight (plan 11d). A client metadata document URL answers
 * null, so a preflight never makes core fetch a document.
 */
export async function registeredClient(
  config: ResolvedConfig,
  clientId: string,
): Promise<OAuthClientRow | null> {
  if (!config.oauth || !CLIENT_ID_RE.test(clientId)) return null;
  return config.storage.findOne("oauthClient", [
    { field: "id", op: "eq", value: clientId },
    { field: "kind", op: "in", value: CL_KINDS },
  ]);
}

/** 1 to 10 valid redirect URIs, each once, or null. */
export function redirectList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > REDIRECT_MAX) return null;
  if (!value.every(validRedirectUri)) return null;
  return [...new Set(value as string[])];
}

/** The client's name: null when absent, undefined when it is not 1 to 80 characters with no control character. */
export function clientName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > NAME_MAX) return undefined;
  return hasControlChar(value) ? undefined : value;
}

function subsetOf(value: unknown, allowed: readonly string[]): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((x) => typeof x === "string" && allowed.includes(x));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One public key of a client: a key of one alg of a client assertion, with
 * its public members and no private member (`publicMembersOnly`). An
 * Ed448 key and an RSA key under 2048 bits fit no alg.
 */
function clientKey(value: unknown): value is Record<string, unknown> {
  return isObject(value) && FOREIGN_ALGS.some((alg) => keyFitsAlg(value, alg));
}

/** A JWK Set of 1 to 10 public client keys, or null. */
function clientKeySet(value: unknown): Record<string, unknown> | null {
  if (!isObject(value) || !Array.isArray(value.keys)) return null;
  const keys: unknown[] = value.keys;
  if (keys.length < 1 || keys.length > CLIENT_KEYS_MAX || !keys.every(clientKey)) return null;
  return { keys };
}

/** A list of distinct strings that each pass `ok`, or null. Absent is `[]`. */
function stringList(value: unknown, ok: (s: string) => boolean, max: number): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((x) => typeof x === "string" && ok(x))) return null;
  return new Set(value).size === value.length ? (value as string[]) : null;
}

/** A read of client metadata: the fields and the members a document dropped, or the refusal and its member. */
type MetadataRead =
  | { ok: true; fields: ClientFields; dropped: string[] }
  | { ok: false; error: OAuthErrorCode; why: MetadataMember | CimdRule };

/**
 * The grants of a document that core serves, in document order, once each,
 * or null when the value is not a list of strings. A grant that core does
 * not serve is dropped, and `dropped` gets the member name.
 */
function servedList(
  value: unknown,
  served: readonly string[],
  member: string,
  dropped: string[],
): string[] | null {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) return null;
  const kept = [...new Set(value as string[])].filter((x) => served.includes(x));
  if (kept.length < value.length) dropped.push(member);
  return kept;
}

/**
 * The client metadata of RFC 7591 section 2 and OIDC Registration section 2,
 * as the fields of a client row (plan 12e). `register` reads a registration
 * body; `create` reads `api.oauth.clients`, which also takes
 * `client_credentials`, `credentials_scopes`, and `introspect`. A
 * registration ignores those two fields: they are no RFC 7591 metadata.
 */
export function validClientMetadata(
  config: ResolvedConfig,
  m: Record<string, unknown>,
  source: "register" | "create",
): OAuthResult<ClientFields> {
  const read = readClientMetadata(config, m, source);
  return read.ok ? oauthOk(read.fields) : oauthFail(read.error);
}

/**
 * The one reader of client metadata. Each refusal names its member, never
 * its value. `cimd` reads a client metadata document (ruling 24 of plan
 * 12e). The rules of -02 section 4.1 and the key rules stay strict. A
 * document cannot change at the request of this server. So a member that
 * core does not serve is dropped, not refused. These members are another
 * grant, another response type, a `backchannel_logout_uri` off the
 * document's host or against its rules (Task 16), and an
 * `id_token_signed_response_alg` other than `jwtMint.alg`.
 */
function readClientMetadata(
  config: ResolvedConfig,
  m: Record<string, unknown>,
  source: "register" | "create" | "cimd",
): MetadataRead {
  const fail = (error: OAuthErrorCode, why: MetadataMember | CimdRule): MetadataRead => ({
    ok: false,
    error,
    why,
  });
  const meta = (why: MetadataMember | CimdRule) => fail("invalid_client_metadata", why);
  const oauth = config.oauth;
  if (!oauth) return fail("invalid_request", "oauth");
  const cimd = source === "cimd";
  const dropped: string[] = [];
  if (cimd) {
    const rule = cimdCredentialRule(m);
    if (rule !== null) return meta(rule);
  }
  const absent = (v: unknown) => v === undefined || v === null;
  const served = oauth.device !== null ? [...GRANT_TYPES, DEVICE_GRANT] : GRANT_TYPES;
  const allowedGrants = source === "create" ? [...served, ...CREATE_ONLY_GRANT_TYPES] : served;
  let grantTypes: string[] | null;
  // A null list reads as an absent one, at every source (ruling 26 of plan 12e).
  if (absent(m.grant_types)) grantTypes = [...GRANT_TYPES];
  else if (cimd) grantTypes = servedList(m.grant_types, served, "grant_types", dropped);
  else
    grantTypes = stringList(m.grant_types, (g) => allowedGrants.includes(g), allowedGrants.length);
  // A document is a client of the code grant: core serves no other grant to a document.
  if (cimd && !grantTypes?.includes("authorization_code")) return meta("grant_types");
  // A client of client_credentials alone has no redirect. A registration and a document always have one.
  const needsRedirect =
    source !== "create" || grantTypes === null || grantTypes.includes("authorization_code");
  // Such a client holds an empty list, and an update sends the whole row back: an empty list reads as absent.
  const noRedirect =
    absent(m.redirect_uris) || (Array.isArray(m.redirect_uris) && m.redirect_uris.length === 0);
  const redirectUris = needsRedirect || !noRedirect ? redirectList(m.redirect_uris) : [];
  if (!redirectUris) return fail("invalid_redirect_uri", "redirect_uris");
  const name = clientName(m.client_name);
  if (name === undefined) return meta("client_name");
  // RFC 7591 section 2 and OIDC Registration section 2 default to
  // client_secret_basic. Core keeps none, so an MCP client that omits the
  // field works as a public client (owner decision 4 of 2026-10-14, spec
  // 8.16 item 2).
  const method = m.token_endpoint_auth_method ?? "none";
  if (!AUTH_METHODS.includes(method as ClientAuthMethod)) return meta("token_endpoint_auth_method");
  const authMethod = method as ClientAuthMethod;
  if (!grantTypes || grantTypes.length === 0) return meta("grant_types");
  // A public client has no credential, so no grant can name it alone.
  if (grantTypes.includes("client_credentials") && authMethod === "none")
    return meta("grant_types");
  if (cimd && !absent(m.response_types)) {
    const kept = servedList(m.response_types, RESPONSE_TYPES, "response_types", dropped);
    if (!kept?.includes("code")) return meta("response_types");
  } else if (!subsetOf(m.response_types, RESPONSE_TYPES)) return meta("response_types");
  // OIDC Registration section 2: jwks and jwks_uri never together.
  if (!absent(m.jwks) && !absent(m.jwks_uri)) return meta("jwks_uri");
  const jwks = absent(m.jwks) ? null : clientKeySet(m.jwks);
  if (!absent(m.jwks) && !jwks) return meta("jwks");
  let jwksUri: string | null = null;
  if (!absent(m.jwks_uri)) {
    if (typeof m.jwks_uri !== "string" || !validCimdUrl(m.jwks_uri, config.baseURL))
      return meta("jwks_uri");
    // With no fetch, core can never read the set, and the client could never authenticate.
    if (!oauth.fetch) return meta("jwks_uri");
    jwksUri = m.jwks_uri;
  }
  if (authMethod === "private_key_jwt" && !jwks && !jwksUri) return meta("jwks");
  const postLogoutRedirectUris = stringList(
    m.post_logout_redirect_uris,
    validRedirectUri,
    REDIRECT_MAX,
  );
  if (!postLogoutRedirectUris) return meta("post_logout_redirect_uris");
  // Back-Channel Logout 1.0 section 2.2 (read 2026-10-20). Core posts a
  // logout token to this URI from the server, so the URI takes the host rule
  // of `validCimdUrl`. With no fetch, core could never deliver a token.
  let backchannelLogoutUri: string | null = null;
  if (!absent(m.backchannel_logout_uri)) {
    const uri = m.backchannel_logout_uri;
    const valid = validLogoutUri(uri, config.baseURL) && oauth.fetch !== null;
    // A document is a claim of its host alone. Its logout URI must be on that
    // host, so a document cannot make core post to a third party (ruling 24).
    if (cimd && !(valid && sameHost(uri, m.client_id))) dropped.push("backchannel_logout_uri");
    else if (!valid) return meta("backchannel_logout_uri");
    else backchannelLogoutUri = uri;
  }
  // Core always sends `sid`, so a client that requires it gets it.
  const sessionRequired = m.backchannel_logout_session_required ?? false;
  let backchannelLogoutSessionRequired = false;
  if (typeof sessionRequired !== "boolean") {
    if (!cimd) return meta("backchannel_logout_session_required");
    dropped.push("backchannel_logout_session_required");
  } else backchannelLogoutSessionRequired = backchannelLogoutUri !== null && sessionRequired;
  const subjectType = m.subject_type ?? "public";
  if (!isSubjectType(subjectType)) return meta("subject_type");
  if (subjectType === "pairwise") {
    // `sector_identifier_uri` is not in plan 12e (OIDC Core 8.1). A document
    // drops it: its sector is the host of its id (`sectorOf`). Elsewhere it
    // is refused, because its sector would differ from the one core takes.
    if (!absent(m.sector_identifier_uri)) {
      if (!cimd) return meta("sector_identifier_uri");
      dropped.push("sector_identifier_uri");
    }
    // A cl_ client needs one host over all its redirect URIs. A document's redirect hosts never set its sector.
    if (!cimd && redirectSector(redirectUris) === null) return meta("subject_type");
    // The device grant has no redirect, so nothing ties the sector to this
    // client. A dynamic client could name a host it does not own (ruling 34).
    if (grantTypes.includes(DEVICE_GRANT)) {
      if (!cimd) return meta("grant_types");
      grantTypes = grantTypes.filter((g) => g !== DEVICE_GRANT);
      dropped.push("grant_types");
    }
  }
  // One key of one alg signs every token (owner decision 1).
  if (
    !absent(m.id_token_signed_response_alg) &&
    m.id_token_signed_response_alg !== config.jwtMint?.alg
  ) {
    if (!cimd) return meta("id_token_signed_response_alg");
    dropped.push("id_token_signed_response_alg");
  }
  const dpopBound = m.dpop_bound_access_tokens ?? false;
  if (typeof dpopBound !== "boolean") return meta("dpop_bound_access_tokens");
  let credentialsScopes: string[] = [];
  let introspect = false;
  if (source === "create") {
    // An app scope only: a built-in scope names a user, and this grant has none.
    const scopes = stringList(
      m.credentials_scopes,
      (s) => oauth.scopes.has(s) && !BUILT_IN_SCOPES.has(s),
      oauth.scopes.size,
    );
    if (!scopes) return meta("credentials_scopes");
    credentialsScopes = scopes;
    const flag = m.introspect ?? false;
    if (typeof flag !== "boolean") return meta("introspect");
    introspect = flag;
  }
  return {
    ok: true,
    dropped,
    fields: {
      name,
      redirectUris,
      authMethod,
      jwks,
      jwksUri,
      grantTypes,
      credentialsScopes,
      introspect,
      postLogoutRedirectUris,
      backchannelLogoutUri,
      backchannelLogoutSessionRequired,
      subjectType,
      dpopBound,
    },
  };
}

/** The RFC 7591 answer of one client row. */
function registeredAnswer(
  config: ResolvedConfig,
  row: OAuthClientRow,
  secret: string | null,
): RegisteredClient {
  return {
    client_id: row.id,
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    ...(row.name !== null ? { client_name: row.name } : {}),
    redirect_uris: [...row.redirectUris],
    token_endpoint_auth_method: row.authMethod,
    grant_types: [...row.grantTypes],
    response_types: [...RESPONSE_TYPES],
    ...(row.jwks !== null ? { jwks: row.jwks } : {}),
    ...(row.jwksUri !== null ? { jwks_uri: row.jwksUri } : {}),
    ...(row.postLogoutRedirectUris.length > 0
      ? { post_logout_redirect_uris: [...row.postLogoutRedirectUris] }
      : {}),
    ...(row.backchannelLogoutUri !== null
      ? {
          backchannel_logout_uri: row.backchannelLogoutUri,
          backchannel_logout_session_required: row.backchannelLogoutSessionRequired,
        }
      : {}),
    subject_type: row.subjectType,
    id_token_signed_response_alg: config.jwtMint?.alg ?? "EdDSA",
    dpop_bound_access_tokens: row.dpopBound,
    ...(secret !== null ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  };
}

/**
 * True when `token` is the initial access token of the register route: its
 * SHA-256 hex equals the configured hash, compared in constant time. The
 * token never reaches a log, an error text, or an answer.
 */
export async function initialAccessTokenMatches(
  hash: string,
  token: string | null,
): Promise<boolean> {
  const got = await sha256Hex(token ?? "");
  return token !== null && constantTimeEqual(got, hash);
}

/** A dynamic registration (RFC 7591 section 3, re-read 2026-10-19 for plan 12e). */
export async function registerClient(
  config: ResolvedConfig,
  input: {
    /** The JSON object of the body, or null when the body is not one. */
    metadata: Record<string, unknown> | null;
    ip: string | null;
    /** The bearer of the request: the initial access token, or null. */
    bearer?: string | null;
  },
): Promise<OAuthResult<RegisteredClient>> {
  const oauth = config.oauth;
  if (!oauth?.dynamic) return oauthFail("invalid_request");
  // The limit comes first, so a guess of the initial access token counts too.
  if (!(await limit(config, "oauth-register:ip", ipKey(input.ip), REGISTER_PER_IP)))
    return oauthFail("rate_limited");
  if (
    oauth.initialAccessTokenHash !== null &&
    !(await initialAccessTokenMatches(oauth.initialAccessTokenHash, input.bearer ?? null))
  )
    return oauthFail("invalid_token");
  if (!input.metadata) return oauthFail("invalid_client_metadata");
  const fields = validClientMetadata(config, input.metadata, "register");
  if (!fields.ok) return fields;
  const now = config.clock.now();
  const secret = await newClientSecret(fields.value.authMethod);
  const row = await config.storage.create("oauthClient", {
    id: randomToken(CLIENT_ID_PREFIX),
    kind: "registered",
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...fields.value,
    secretHash: secret?.hash ?? null,
    secretExpiresAt: null,
    previousSecretHash: null,
    previousSecretUntil: null,
  });
  config.observe.emit({
    name: "oauth.client_register",
    clientRef: await clientRef(row.id),
    outcome: "success",
  });
  return oauthOk(registeredAnswer(config, row, secret?.secret ?? null));
}

/**
 * A client id that may name a metadata document (the CIMD draft section 3,
 * read 2026-10-13): https, a path other than `/`, no dot segment, no query,
 * no fragment, and no credentials. Core also refuses the hosts that only an
 * internal network reaches. `oauth.fetch` should refuse them too, but no
 * supplier's fetch may be the only guard: on Node or Bun a plain `fetch`
 * reaches internal hosts.
 */
export function validCimdUrl(value: string, baseURL: string): boolean {
  if (value.length > URI_MAX || value.includes("#") || hasControlChar(value)) return false;
  if (/\/\.\.?(\/|$)/.test(value)) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  // The canonical form only. The parser folds `%2e%2e`, `.%2E`, a backslash,
  // a capital in the host, and a default port, so without this one document
  // answers for many client ids.
  if (u.href !== value) return false;
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return false;
  if (u.search !== "" || u.pathname === "/") return false;
  return publicHost(u, baseURL);
}

/**
 * The host rule of each URL that core fetches or posts to from the server.
 * No IP literal, no local name, and not the host of this instance.
 */
function publicHost(u: URL, baseURL: string): boolean {
  // A trailing dot names the same host: `localhost.` is `localhost`.
  const host = u.hostname.replace(/\.$/, "");
  // An IP literal (IPv4 or IPv6, 127.0.0.1 and [::1] too): a public client has a DNS name, and an address may be internal.
  if (isIpLiteral(host)) return false;
  // `localhost`, `*.localhost`, a single label, and the private names: the one local host rule.
  if (isLocalHost(host)) return false;
  // This instance's own host: a document there would make core fetch itself.
  // The compare is by `hostname`, with no port: a document on another port
  // of this host is refused too, which is stricter than the host and port.
  if (host === new URL(baseURL).hostname) return false;
  return true;
}

/**
 * A back-channel logout URI (Back-Channel Logout 1.0 section 2.2, read
 * 2026-10-20): absolute, https, no fragment, no user, in canonical form, on
 * a host of `publicHost`. A query is allowed, and core keeps it. Section 2.2
 * allows http for a confidential client; core refuses it, because the token
 * ends a person's session.
 */
export function validLogoutUri(value: unknown, baseURL: string): value is string {
  if (typeof value !== "string" || value.length > URI_MAX) return false;
  if (value.includes("#") || hasControlChar(value)) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.href !== value) return false;
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return false;
  return publicHost(u, baseURL);
}

/** True when `a` and `b` are URLs of one host name. */
function sameHost(a: string, b: unknown): boolean {
  if (typeof b !== "string") return false;
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/** The body as text, or null past `max` bytes, on a read error, or when `signal` aborts. */
async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  // A rejection after the read ended has no reader: it must not count as unhandled.
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(out);
  } catch {
    return null;
  }
}

/**
 * The JSON object at `url`, or the reason of a refusal. The fetch is the
 * app's guarded fetch; core adds `redirect: "manual"`, a 10-second timeout
 * for the answer and the body, and a cap of `max` bytes. It needs status
 * 200 and a media type of `types`. The body never reaches a log.
 */
async function guardedJson(
  fetchFn: typeof fetch | null,
  url: string,
  types: readonly string[],
  max: number,
): Promise<{ doc: Record<string, unknown> } | { why: string; status?: number }> {
  if (!fetchFn) return { why: "no fetch" };
  const ctrl = new AbortController();
  // setTimeout, not AbortSignal.timeout: a test moves it with fake timers.
  const timer = setTimeout(() => ctrl.abort(), CIMD_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: ctrl.signal,
      });
    } catch {
      return { why: "the fetch failed or timed out" };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { why: "status", status: res.status };
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type === undefined || !types.includes(type)) {
      await res.body?.cancel().catch(() => {});
      return { why: notOfTypes(types) };
    }
    const text = await readCapped(res, max, ctrl.signal);
    if (text === null) return { why: overCap(max) };
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return { why: "not JSON" };
    }
    if (!isObject(doc)) return { why: "not a JSON object" };
    return { doc };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The rule of -02 section 4.1 that a metadata document breaks, or null.
 * A document has no shared secret: no `client_secret`, no
 * `client_secret_expires_at`, and no method of a secret. The third rule of
 * 4.1, public keys only, is `clientKey` in `readClientMetadata`.
 */
function cimdCredentialRule(m: Record<string, unknown>): CimdRule | null {
  if (m.client_secret !== undefined) return "client_secret is present (-02 section 4.1)";
  if (m.client_secret_expires_at !== undefined)
    return "client_secret_expires_at is present (-02 section 4.1)";
  // A null method means none, as at registration (owner decision 4).
  const method = m.token_endpoint_auth_method ?? "none";
  if (!CIMD_AUTH_METHODS.includes(method))
    return "token_endpoint_auth_method is not none or private_key_jwt (-02 section 4.1)";
  return null;
}

/**
 * The client fields of a client ID metadata document, or null with one log
 * line that names the reason and never the document. The guards are those
 * of `guardedJson` with the cap `CIMD_MAX_BYTES`. The document must name its
 * own URL as `client_id` (-02 section 4). Then `readClientMetadata` reads it
 * with the rules of -02 section 4.1, so a `jwks_uri` gets the host rule of
 * `validCimdUrl` too (-02 section 8.6). Each dropped member writes one
 * warning line with its name, never its value.
 */
export async function fetchCimd(config: ResolvedConfig, url: string): Promise<ClientFields | null> {
  const refuse = (why: string, status?: number) => {
    config.observe.emit({
      name: "oauth.client_metadata_refused",
      why,
      ...(status === undefined ? {} : { status }),
    });
    return null;
  };
  const got = await guardedJson(config.oauth?.fetch ?? null, url, CIMD_TYPES, CIMD_MAX_BYTES);
  if ("why" in got) return refuse(got.why, got.status);
  const d = got.doc;
  if (d.client_id !== url) return refuse("client_id is not the document URL");
  const read = readClientMetadata(config, d, "cimd");
  if (!read.ok) return refuse(read.why);
  for (const member of read.dropped)
    config.observe.emit({ name: "oauth.client_metadata_member_dropped", member });
  return read.fields;
}

/**
 * The keys of a client's `jwks_uri` set that fit an alg of a client
 * assertion, or null. A refusal writes one log line that names the reason,
 * never the set. A key that fits no alg (an encryption key, an Ed448 key)
 * is left out, so one odd key does not break the client.
 */
async function fetchJwks(
  observe: Observer,
  fetchFn: typeof fetch | null,
  url: string,
): Promise<Record<string, unknown>[] | null> {
  const refuse = (why: string, status?: number) => {
    observe.emit({
      name: "oauth.client_key_set_refused",
      why,
      ...(status === undefined ? {} : { status }),
    });
    return null;
  };
  const got = await guardedJson(fetchFn, url, JWKS_TYPES, JWKS_MAX_BYTES);
  if ("why" in got) return refuse(got.why, got.status);
  const raw = got.doc.keys;
  if (!Array.isArray(raw)) return refuse("no keys array");
  const keys = raw.filter(clientKey);
  if (keys.length === 0) return refuse("no public signing key");
  return keys;
}

/**
 * The key set of a `private_key_jwt` client: `jwks` of the row, or the set
 * of `jwks_uri` through the guards of `guardedJson` and the host rule of
 * `validCimdUrl`. The isolate keeps a read set for one hour. A `kid` that
 * the kept set lacks reads again at most once per 30 seconds per URL. A
 * failed read leaves a kept set in place until its hour ends. With no kept
 * set, a failed read is kept as a negative entry for 30 seconds. So a
 * stranger who points a client at a host that fails makes one fetch per 30
 * seconds, not one per request.
 */
export async function fetchClientJwks(
  config: ResolvedConfig,
  client: Pick<OAuthClientRow, "jwks" | "jwksUri">,
  want: { kid: string | null },
): Promise<Record<string, unknown>[] | null> {
  if (client.jwks) {
    const keys = client.jwks.keys;
    return Array.isArray(keys) ? keys.filter(clientKey) : null;
  }
  const oauth = config.oauth;
  const url = client.jwksUri;
  if (!oauth || url === null || !validCimdUrl(url, config.baseURL)) return null;
  const now = config.clock.now().getTime();
  const kept = oauth.jwksCache.get(url);
  const live = kept && kept.until > now ? kept : null;
  if (live) {
    if (live.keys === null) return null;
    const known = want.kid === null || live.keys.some((k) => k.kid === want.kid);
    if (known || now - live.readAt < JWKS_REREAD_MS) return live.keys;
  }
  const keys = await fetchJwks(config.observe, oauth.fetch, url);
  if (keys) {
    keepJwks(oauth, url, { keys, until: now + JWKS_CACHE_MS, readAt: now });
    return keys;
  }
  if (live) {
    // Only an unknown kid reads a live set again, so no kept key can verify
    // it. The set stays for its hour, and this failure counts as a read.
    live.readAt = now;
    return null;
  }
  keepJwks(oauth, url, { keys: null, until: now + JWKS_REREAD_MS, readAt: now });
  return null;
}

/** Keeps one entry of the key set cache. The oldest entry goes first past 500. */
function keepJwks(oauth: ResolvedOAuth, url: string, entry: JwksEntry): void {
  oauth.jwksCache.delete(url);
  if (oauth.jwksCache.size >= JWKS_CACHE_MAX) {
    const oldest = oauth.jwksCache.keys().next().value;
    if (oldest !== undefined) oauth.jwksCache.delete(oldest);
  }
  oauth.jwksCache.set(url, entry);
}

/**
 * Writes or refreshes the row of a document that this call read. The row
 * holds every client field of the document, its method and keys too. So
 * the client auth reads the method of the last document.
 */
async function writeCimdRow(
  config: ResolvedConfig,
  url: string,
  entry: CimdEntry,
  row: OAuthClientRow | null,
  now: Date,
): Promise<OAuthClientRow> {
  const { until: _until, ...fields } = entry;
  const data = {
    kind: "cimd" as const,
    ...fields,
    lastSeenAt: now,
    updatedAt: now,
  };
  if (row) {
    const refreshed = await refreshCimdRow(config, url, data);
    if (refreshed) return refreshed;
  }
  try {
    return await config.storage.create("oauthClient", {
      ...publicClientFields(),
      id: url,
      ...data,
      createdAt: now,
    });
  } catch (e) {
    if (!(e instanceof StorageError && e.code === "unique_violation")) throw e;
    // A parallel request wrote the row first: this document's values win, and
    // the row comes back from storage, with the winner's `createdAt`.
    const winner = await refreshCimdRow(config, url, data);
    if (!winner) throw e;
    return winner;
  }
}

/**
 * Updates the row of a document in one transaction, or answers null when
 * no row is there. Ruling 25 of plan 12e: a document that drops from a
 * confidential method to `none` revokes every refresh family of the client.
 * The revoke runs in the same write. A refresh token of that client was
 * issued after a client auth. Without the revoke, the client id alone would
 * refresh it (-02 section 8.2). After the commit, each family of the
 * client ends with its mark (`endFamilies`, ruling 43 of plan 12e). The log
 * names the client and the two methods, never a token.
 */
async function refreshCimdRow(
  config: ResolvedConfig,
  url: string,
  data: Partial<Omit<OAuthClientRow, "id">> & Pick<OAuthClientRow, "authMethod">,
): Promise<OAuthClientRow | null> {
  const where = [{ field: "id" as const, op: "eq" as const, value: url }];
  const ends = familyEnds();
  const done = await config.storage.transaction(async (tx) => {
    const current = await tx.findOne("oauthClient", where);
    if (!current) return null;
    const drops = current.authMethod !== "none" && data.authMethod === "none";
    // The delete comes first. Memory and D1 do not isolate a transaction, so
    // another request sees each write at once. A row of none beside a live
    // token would let a client id alone refresh it (ruling 26 of plan 12e).
    if (drops) {
      await deleteFamilies(tx, [{ field: "clientId", op: "eq", value: url }], ends);
      // Each device row began under the client auth, decided or not (ruling 48 of plan 12e).
      await tx.delete("oauthDevice", [{ field: "clientId", op: "eq", value: url }]);
    }
    await tx.update("oauthClient", where, data);
    return { row: { ...current, ...data }, from: drops ? current.authMethod : null };
  });
  await endFamilies(config, ends);
  if (done?.from)
    config.observe.emit({
      name: "oauth.client_auth_dropped",
      clientRef: await clientRef(url),
      from: done.from,
    });
  return done?.row ?? null;
}

async function cimdClient(
  config: ResolvedConfig,
  oauth: ResolvedOAuth,
  url: string,
  now: Date,
): Promise<OAuthClientRow | null> {
  const cached = oauth.cimdCache.get(url);
  if (cached && cached.until > now.getTime()) {
    const row = await config.storage.findOne("oauthClient", [
      { field: "id", op: "eq", value: url },
    ]);
    // A row that the sweep deleted while the document lives in the cache comes back.
    return row ?? writeCimdRow(config, url, cached, null, now);
  }
  const doc = await fetchCimd(config, url);
  if (!doc) return null;
  const entry: CimdEntry = { ...doc, until: now.getTime() + CIMD_CACHE_MS };
  oauth.cimdCache.delete(url);
  if (oauth.cimdCache.size >= CIMD_CACHE_MAX) {
    const oldest = oauth.cimdCache.keys().next().value;
    if (oldest !== undefined) oauth.cimdCache.delete(oldest);
  }
  oauth.cimdCache.set(url, entry);
  const row = await config.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: url }]);
  return writeCimdRow(config, url, entry, row, now);
}

/**
 * The client of `clientId`, or null: a registered `cl_` client, or a CIMD
 * client whose document this call or this isolate's cache read. A failed
 * fetch answers null: the document is the source of the client's data.
 */
export async function findClient(
  config: ResolvedConfig,
  clientId: string,
): Promise<OAuthClientRow | null> {
  const oauth = config.oauth;
  if (!oauth) return null;
  const now = config.clock.now();
  if (CLIENT_ID_RE.test(clientId)) {
    const row = await config.storage.findOne("oauthClient", [
      { field: "id", op: "eq", value: clientId },
      { field: "kind", op: "in", value: CL_KINDS },
    ]);
    if (row && now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_EVERY_MS) {
      await config.storage.update("oauthClient", [{ field: "id", op: "eq", value: row.id }], {
        lastSeenAt: now,
        updatedAt: now,
      });
      return { ...row, lastSeenAt: now, updatedAt: now };
    }
    return row;
  }
  if (!oauth.cimd || !validCimdUrl(clientId, config.baseURL)) return null;
  return cimdClient(config, oauth, clientId, now);
}
