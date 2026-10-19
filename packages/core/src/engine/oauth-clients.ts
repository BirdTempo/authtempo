import type { ResolvedConfig, ResolvedOAuth } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import { constantTimeEqual, randomToken, sha256Hex } from "../primitives/crypto.js";
import { JWK_PRIVATE_MEMBERS } from "../primitives/jwk.js";
import { hasControlChar } from "../primitives/text.js";
import type { ClientAuthMethod, OAuthClientRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { newClientSecret } from "./oauth-client-secret.js";
import { BUILT_IN_SCOPES, type OAuthResult, oauthFail, oauthOk } from "./oauth-result.js";

/**
 * The OAuth clients (plan 9g, spec 8.13 item 1; plan 12e, spec 8.16). A
 * client is public (`none`, PKCE binds each code to it) or confidential (a
 * `cs_` secret or `private_key_jwt`). A registered client has a `cl_` id
 * from RFC 7591 or `api.oauth.clients`. A CIMD client is the URL of its own
 * metadata document (draft-ietf-oauth-client-id-metadata-document, read 2026-10-13).
 */

export const CLIENT_ID_PREFIX = "cl_";
/** The kinds of a client with a `cl_` id: a registration's and an `api.oauth.clients` one's. */
const CL_KINDS: readonly OAuthClientRow["kind"][] = ["registered", "api"];
const CLIENT_ID_RE = /^cl_[A-Za-z0-9_-]{43}$/;
const REGISTER_PER_IP = { seconds: 3600, max: 10 };
export const CIMD_TIMEOUT_MS = 10_000;
export const CIMD_MAX_BYTES = 65_536;
export const CIMD_CACHE_MS = 3_600_000;
/** The documents one isolate keeps. The oldest goes first. */
const CIMD_CACHE_MAX = 500;
const REDIRECT_MAX = 10;
const URI_MAX = 2048;
const NAME_MAX = 80;
/** A busy client must not write its row on every request. */
const LAST_SEEN_EVERY_MS = 86_400_000;
const GRANT_TYPES = ["authorization_code", "refresh_token"];
/**
 * The grants of a client of `api.oauth.clients`: the registration ones and
 * `client_credentials`. A registration never takes `client_credentials`: a
 * stranger must not get a machine client. The device grant comes with
 * `oauth.device` (plan 12e Task 14); until then every source refuses it.
 */
const CREATE_GRANT_TYPES = [...GRANT_TYPES, "client_credentials"];
const RESPONSE_TYPES = ["code"];
const AUTH_METHODS: readonly ClientAuthMethod[] = [
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
];
/** The algs of a client key: the four of a client assertion (plan 12e Task 5). */
const CLIENT_KEY_ALGS: readonly string[] = ["EdDSA", "ES256", "RS256", "PS256"];
/** A client key set holds 1 to 10 keys: room for a rotation, and a bound on each assertion check. */
const CLIENT_KEYS_MAX = 10;

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
/**
 * The loopback hosts of an http redirect URI. Not `[::1]`: a CSP host-source
 * has no IPv6 literal form, so the consent page cannot name it in
 * `form-action`, and the browser would stop at the allow. A client on the
 * loopback uses 127.0.0.1.
 */
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
/** Host suffixes of names that only a local network resolves. A host equal to the name without its dot is refused too. */
const PRIVATE_SUFFIXES: readonly string[] = [".local", ".home.arpa", ".internal"];
/** A parsed IPv4 host. The URL parser writes every IPv4 form (`127.1`, `0x7f.0.0.1`) as four decimal parts. */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface CimdEntry {
  name: string | null;
  redirectUris: string[];
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
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
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
    if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname)))
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
 * One public key of a client: an Ed25519, P-256, or RSA key with its public
 * members and no private member. An `alg`, when present, is an alg of a
 * client assertion. Plan 12e Task 5 moves the member check into `publicMembersOnly`.
 */
function clientKey(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (JWK_PRIVATE_MEMBERS.some((m) => m in value)) return false;
  if (value.alg !== undefined && !CLIENT_KEY_ALGS.includes(value.alg as string)) return false;
  if (value.kty === "OKP") return value.crv === "Ed25519" && typeof value.x === "string";
  if (value.kty === "EC")
    return value.crv === "P-256" && typeof value.x === "string" && typeof value.y === "string";
  if (value.kty === "RSA") return typeof value.n === "string" && typeof value.e === "string";
  return false;
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
  const oauth = config.oauth;
  if (!oauth) return oauthFail("invalid_request");
  const absent = (v: unknown) => v === undefined || v === null;
  const allowedGrants = source === "create" ? CREATE_GRANT_TYPES : GRANT_TYPES;
  const grantTypes =
    m.grant_types === undefined
      ? [...GRANT_TYPES]
      : stringList(m.grant_types, (g) => allowedGrants.includes(g), allowedGrants.length);
  // A client of client_credentials alone has no redirect. A registration always has one.
  const needsRedirect =
    source === "register" || grantTypes === null || grantTypes.includes("authorization_code");
  const redirectUris =
    needsRedirect || !absent(m.redirect_uris) ? redirectList(m.redirect_uris) : [];
  if (!redirectUris) return oauthFail("invalid_redirect_uri");
  const name = clientName(m.client_name);
  if (name === undefined) return oauthFail("invalid_client_metadata");
  // RFC 7591 section 2 and OIDC Registration section 2 default to
  // client_secret_basic. Core keeps none, so an MCP client that omits the
  // field works as a public client (owner decision 4 of 2026-10-14, spec
  // 8.16 item 2).
  const method = m.token_endpoint_auth_method ?? "none";
  if (!AUTH_METHODS.includes(method as ClientAuthMethod))
    return oauthFail("invalid_client_metadata");
  const authMethod = method as ClientAuthMethod;
  if (!grantTypes || grantTypes.length === 0) return oauthFail("invalid_client_metadata");
  // A public client has no credential, so no grant can name it alone.
  if (grantTypes.includes("client_credentials") && authMethod === "none")
    return oauthFail("invalid_client_metadata");
  if (!subsetOf(m.response_types, RESPONSE_TYPES)) return oauthFail("invalid_client_metadata");
  // OIDC Registration section 2: jwks and jwks_uri never together.
  if (!absent(m.jwks) && !absent(m.jwks_uri)) return oauthFail("invalid_client_metadata");
  const jwks = absent(m.jwks) ? null : clientKeySet(m.jwks);
  if (!absent(m.jwks) && !jwks) return oauthFail("invalid_client_metadata");
  let jwksUri: string | null = null;
  if (!absent(m.jwks_uri)) {
    if (typeof m.jwks_uri !== "string" || !validCimdUrl(m.jwks_uri, config.baseURL))
      return oauthFail("invalid_client_metadata");
    jwksUri = m.jwks_uri;
  }
  if (authMethod === "private_key_jwt" && !jwks && !jwksUri)
    return oauthFail("invalid_client_metadata");
  const postLogoutRedirectUris = stringList(
    m.post_logout_redirect_uris,
    validRedirectUri,
    REDIRECT_MAX,
  );
  if (!postLogoutRedirectUris) return oauthFail("invalid_client_metadata");
  // Plan 12e Task 16 adds the back-channel logout and its checks.
  if (!absent(m.backchannel_logout_uri) || !absent(m.backchannel_logout_session_required))
    return oauthFail("invalid_client_metadata");
  const subjectType = m.subject_type ?? "public";
  if (subjectType !== "public" && subjectType !== "pairwise")
    return oauthFail("invalid_client_metadata");
  // One key of one alg signs every token (owner decision 1).
  if (
    !absent(m.id_token_signed_response_alg) &&
    m.id_token_signed_response_alg !== config.jwtMint?.alg
  )
    return oauthFail("invalid_client_metadata");
  const dpopBound = m.dpop_bound_access_tokens ?? false;
  if (typeof dpopBound !== "boolean") return oauthFail("invalid_client_metadata");
  let credentialsScopes: string[] = [];
  let introspect = false;
  if (source === "create") {
    // An app scope only: a built-in scope names a user, and this grant has none.
    const scopes = stringList(
      m.credentials_scopes,
      (s) => oauth.scopes.has(s) && !BUILT_IN_SCOPES.has(s),
      oauth.scopes.size,
    );
    if (!scopes) return oauthFail("invalid_client_metadata");
    credentialsScopes = scopes;
    const flag = m.introspect ?? false;
    if (typeof flag !== "boolean") return oauthFail("invalid_client_metadata");
    introspect = flag;
  }
  return oauthOk({
    name,
    redirectUris,
    authMethod,
    jwks,
    jwksUri,
    grantTypes,
    credentialsScopes,
    introspect,
    postLogoutRedirectUris,
    backchannelLogoutUri: null,
    backchannelLogoutSessionRequired: false,
    subjectType,
    dpopBound,
  });
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
  if (!(await config.limiter.allow(`oauth-register:ip:${ipKey(input.ip)}`, REGISTER_PER_IP)))
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
  // A trailing dot names the same host: `localhost.` is `localhost`.
  const host = u.hostname.replace(/\.$/, "");
  // An IP literal (IPv4 or IPv6, 127.0.0.1 and [::1] too): a public client has a DNS name, and an address may be internal.
  if (host.startsWith("[") || IPV4_RE.test(host)) return false;
  // `localhost` and `*.localhost` resolve to the loopback (RFC 6761 section 6.3).
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  // A single label (no dot) is an intranet name.
  if (!host.includes(".")) return false;
  // The special-use and private names that only a local network resolves:
  // `.local` (RFC 6762 mDNS), `.home.arpa` (RFC 8375), and `.internal`
  // (the ICANN private-use name, 2024).
  if (PRIVATE_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) return false;
  // This instance's own host: a document there would make core fetch itself.
  // The compare is by `hostname`, with no port: a document on another port
  // of this host is refused too, which is stricter than the host and port.
  if (host === new URL(baseURL).hostname) return false;
  return true;
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
 * The fields core reads from a client ID metadata document, or null with
 * one log line that names the reason and never the document. The fetch is
 * the app's guarded fetch; core adds `redirect: "manual"`, a 10-second
 * timeout for the answer and the body, and a 64 KB cap. The document must
 * name its own URL as `client_id` (the draft, section 4, read 2026-10-13).
 */
export async function fetchCimd(
  fetchFn: typeof fetch | null,
  url: string,
): Promise<{ name: string | null; redirectUris: string[] } | null> {
  const refuse = (why: string) => {
    console.error("authtempo: client metadata document refused", why);
    return null;
  };
  if (!fetchFn) return refuse("no fetch");
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
      return refuse("the fetch failed or timed out");
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return refuse(`status ${res.status}`);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      await res.body?.cancel().catch(() => {});
      return refuse("not application/json");
    }
    const text = await readCapped(res, CIMD_MAX_BYTES, ctrl.signal);
    if (text === null) return refuse("larger than 64 KB, not UTF-8, or not in time");
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return refuse("not JSON");
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc))
      return refuse("not a JSON object");
    const d = doc as Record<string, unknown>;
    if (d.client_id !== url) return refuse("client_id is not the document URL");
    const redirectUris = redirectList(d.redirect_uris);
    if (!redirectUris) return refuse("redirect_uris");
    const name = clientName(d.client_name);
    if (name === undefined) return refuse("client_name");
    if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== "none")
      return refuse("token_endpoint_auth_method is not none: core serves public clients only");
    return { name, redirectUris };
  } finally {
    clearTimeout(timer);
  }
}

/** Writes or refreshes the row of a document that this call read. */
async function writeCimdRow(
  config: ResolvedConfig,
  url: string,
  entry: CimdEntry,
  row: OAuthClientRow | null,
  now: Date,
): Promise<OAuthClientRow> {
  const data = {
    kind: "cimd" as const,
    name: entry.name,
    redirectUris: entry.redirectUris,
    lastSeenAt: now,
    updatedAt: now,
  };
  const where = [{ field: "id" as const, op: "eq" as const, value: url }];
  if (row) {
    await config.storage.update("oauthClient", where, data);
    return { ...row, ...data };
  }
  try {
    return await config.storage.create("oauthClient", {
      id: url,
      ...data,
      createdAt: now,
      ...publicClientFields(),
    });
  } catch (e) {
    if (!(e instanceof StorageError && e.code === "unique_violation")) throw e;
    // A parallel request wrote the row first: this document's values win, and
    // the row comes back from storage, with the winner's `createdAt`.
    await config.storage.update("oauthClient", where, data);
    const winner = await config.storage.findOne("oauthClient", where);
    if (!winner) throw e;
    return winner;
  }
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
  const doc = await fetchCimd(oauth.fetch, url);
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
