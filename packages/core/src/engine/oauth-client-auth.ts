import type { ResolvedConfig } from "../config.js";
import { sha256Hex } from "../primitives/crypto.js";
import {
  decodeForeignJws,
  FOREIGN_ALGS,
  type ForeignJws,
  keyFitsAlg,
  verifyForeign,
} from "../primitives/foreign-jwk.js";
import { newId } from "../primitives/ids.js";
import type { ClientAuthMethod, OAuthClientRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { issuerOf } from "./jwt.js";
import { secretMatches } from "./oauth-client-secret.js";
import { CLIENT_KEYS_MAX, fetchClientJwks, findClient } from "./oauth-clients.js";
import { type OAuthResult, oauthFail, oauthOk } from "./oauth-result.js";

/**
 * The client auth of every client-facing endpoint (plan 12e, spec 8.16):
 * `client_secret_basic`, `client_secret_post`, `private_key_jwt` (RFC 7523),
 * and `none` for a public client. RFC 6749 section 2.3: one method per request. A client with a
 * secret takes either secret method. Section 2.3.1 makes Basic a MUST for
 * it, and the form stays for clients that cannot send Basic. `none` and
 * `private_key_jwt` take their own method only. No per-client limit on a failed auth: a secret of 256
 * bits does not fall to guesses. A limit per client would let a stranger
 * lock a real client out. The per-IP limit of the token endpoint stays (plan 12e).
 */

export type AuthMethod = ClientAuthMethod;

export interface AuthedClient {
  client: OAuthClientRow;
  /** The method of this request. A client with a secret may use either secret method. */
  method: AuthMethod;
  /** OAuth 2.1 section 2.1: a client with credentials. */
  confidential: boolean;
}

/** RFC 7523 section 2.2: the type of a JWT client assertion. */
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/**
 * The longest life of a client assertion, in seconds. RFC 7523 section 3
 * lets the server refuse an `exp` far ahead or an `iat` far back. A short
 * life bounds the replay store and the use of a stolen assertion.
 */
export const ASSERTION_MAX_LIFE_S = 300;
/** The clock skew that each time claim of a client JWT allows, in seconds. */
export const CLOCK_SKEW_S = 30;
/** The longest `jti`: a bound on the replay key, which core hashes. */
const JTI_MAX = 256;

const BASIC_RE = /^basic /i;
const SECRET_METHODS: ReadonlySet<AuthMethod> = new Set([
  "client_secret_basic",
  "client_secret_post",
]);

/**
 * `client_secret` of the form, or null. RFC 6749 section 2.3.1 lets a client
 * omit an empty secret, so an empty value counts as omitted.
 */
function formSecretOf(form: URLSearchParams): string | null {
  const secret = form.get("client_secret");
  return secret === "" ? null : secret;
}

/**
 * The id and the secret of a Basic token (the part after `Basic `), or null
 * for a bad token. RFC 6749 section 2.3.1: each half is form-encoded, so a
 * plus is a space and a percent escape is its byte.
 */
export function basicCredentials(token: string): { id: string; secret: string } | null {
  let clear: string;
  try {
    clear = atob(token);
  } catch {
    return null;
  }
  const at = clear.indexOf(":");
  if (at < 0) return null;
  const decode = (s: string) => decodeURIComponent(s.replaceAll("+", " "));
  try {
    return { id: decode(clear.slice(0, at)), secret: decode(clear.slice(at + 1)) };
  } catch {
    return null;
  }
}

/** True when the request names a client: a credential of any method, or `client_id` in the form. */
export function namesClient(request: Request, form: URLSearchParams): boolean {
  return (
    BASIC_RE.test(request.headers.get("authorization") ?? "") ||
    form.has("client_id") ||
    formSecretOf(form) !== null ||
    form.has("client_assertion_type") ||
    form.has("client_assertion")
  );
}

/**
 * The client of the request, authenticated. The methods present are an
 * `Authorization: Basic` header, `client_secret` in the form, and
 * `client_assertion_type` in the form. More than one is `invalid_request`.
 * With none, `client_id` of the form names a public client. A public client
 * with a secret, and a confidential client with none, are `invalid_client`. The route adds the
 * Basic challenge to each `invalid_client` (RFC 6749 section 5.2). `known`
 * is a row of the named id that the caller already read, so a CIMD client
 * is not read twice.
 */
export async function authenticateClient(
  config: ResolvedConfig,
  request: Request,
  form: URLSearchParams,
  known?: OAuthClientRow,
): Promise<OAuthResult<AuthedClient>> {
  const header = request.headers.get("authorization") ?? "";
  const isBasic = BASIC_RE.test(header);
  const fail = (error: "invalid_request" | "invalid_client") => oauthFail<AuthedClient>(error);
  const formSecret = formSecretOf(form);
  const assertion = form.has("client_assertion_type") || form.has("client_assertion");
  const present = [isBasic, formSecret !== null, assertion].filter(Boolean).length;
  if (present > 1) return fail("invalid_request");
  if (assertion) return assertionClient(config, form, known);
  let method: AuthMethod = "none";
  let id = form.get("client_id") ?? "";
  let secret: string | null = formSecret;
  if (isBasic) {
    const basic = basicCredentials(header.slice("basic ".length).trim());
    if (!basic) return fail("invalid_client");
    if (form.has("client_id") && form.get("client_id") !== basic.id) return fail("invalid_request");
    method = "client_secret_basic";
    id = basic.id;
    secret = basic.secret;
  } else if (formSecret !== null) method = "client_secret_post";
  const client = known?.id === id ? known : await findClient(config, id);
  if (!client) return fail("invalid_client");
  const allowed =
    method === client.authMethod ||
    (SECRET_METHODS.has(method) && SECRET_METHODS.has(client.authMethod));
  if (!allowed) return fail("invalid_client");
  if (secret !== null && !(await secretMatches(client, secret, config.clock.now())))
    return fail("invalid_client");
  return oauthOk({ client, method, confidential: method !== "none" });
}

/** A NumericDate of RFC 7519 section 2: a finite number of seconds. */
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * True when the claims of a client assertion hold, at `now` in seconds
 * (RFC 7523 section 3 with rfc7523bis-11). The signature is not checked here.
 */
function claimsHold(p: Record<string, unknown>, clientId: string, issuer: string, now: number) {
  if (p.iss !== clientId || p.sub !== clientId) return false;
  // rfc7523bis-11, read 2026-10-19: the issuer as the sole value; the token
  // endpoint URL is the audience injection that the draft closes.
  const aud = p.aud;
  if (!(aud === issuer || (Array.isArray(aud) && aud.length === 1 && aud[0] === issuer)))
    return false;
  if (!isTime(p.exp) || p.exp <= now - CLOCK_SKEW_S) return false;
  if (p.exp > now + ASSERTION_MAX_LIFE_S + CLOCK_SKEW_S) return false;
  // An iat ahead of the clock names a time that has not come: the skew allows no more.
  const iat = p.iat;
  if (iat !== undefined) {
    if (!isTime(iat) || iat < now - ASSERTION_MAX_LIFE_S - CLOCK_SKEW_S) return false;
    if (iat > now + CLOCK_SKEW_S) return false;
  }
  // RFC 7523 section 3 item 5: never before nbf (ruling 21).
  if (p.nbf !== undefined && (!isTime(p.nbf) || p.nbf > now + CLOCK_SKEW_S)) return false;
  return typeof p.jti === "string" && p.jti.length >= 1 && p.jti.length <= JTI_MAX;
}

/** True when a key of the client's set verifies `decoded`: the key of its `kid`, or at most 10 keys of its alg. */
async function signedByClient(
  config: ResolvedConfig,
  client: OAuthClientRow,
  decoded: ForeignJws,
): Promise<boolean> {
  const { alg, kid } = decoded.header;
  const keys = await fetchClientJwks(config, client, { kid });
  if (!keys) return false;
  const fits = (k: Record<string, unknown>) =>
    kid !== null
      ? k.kid === kid
      : FOREIGN_ALGS.some((a) => (a as string) === alg && keyFitsAlg(k, a));
  for (const key of keys.filter(fits).slice(0, CLIENT_KEYS_MAX))
    if (await verifyForeign(decoded, key, FOREIGN_ALGS)) return true;
  return false;
}

/**
 * The client of a JWT client assertion (RFC 7523 section 2.2, RFC 7521
 * section 4.2). The order: the type, one JWS, the client, the claims, the
 * signature, and last the replay row, so a refused assertion spends no
 * `jti`. Each refusal is `invalid_client` (RFC 7523 section 3.2). The
 * assertion never reaches a log or an answer.
 */
async function assertionClient(
  config: ResolvedConfig,
  form: URLSearchParams,
  known: OAuthClientRow | undefined,
): Promise<OAuthResult<AuthedClient>> {
  const refused = oauthFail<AuthedClient>("invalid_client");
  if (form.get("client_assertion_type") !== CLIENT_ASSERTION_TYPE) return refused;
  const decoded = decodeForeignJws(form.get("client_assertion") ?? "");
  if (!decoded) return refused;
  const sub = decoded.payload.sub;
  if (typeof sub !== "string") return refused;
  // RFC 7521 section 4.2: a client_id must name the client of the assertion (ruling 21).
  const formId = form.get("client_id");
  if (formId !== null && formId !== sub) return refused;
  const client = known?.id === sub ? known : await findClient(config, sub);
  if (client?.authMethod !== "private_key_jwt") return refused;
  const now = Math.floor(config.clock.now().getTime() / 1000);
  if (!claimsHold(decoded.payload, client.id, issuerOf(config), now)) return refused;
  if (!(await signedByClient(config, client, decoded))) return refused;
  // The replay store: the unique key on valueHash refuses a second use of a
  // jti on every instance over the same storage. claimsHold compares exp
  // with the whole second of now, and RFC 7519 lets exp be a fraction. So
  // the row lives to ceil(exp) plus the skew plus one second: past the last
  // instant that the claims pass, so no sweep frees a live jti.
  const at = config.clock.now();
  try {
    await config.storage.create("verification", {
      id: newId(at),
      purpose: "client-assertion",
      identifier: client.id,
      valueHash: await sha256Hex(`${client.id}:${decoded.payload.jti as string}`),
      expiresAt: new Date((Math.ceil(decoded.payload.exp as number) + CLOCK_SKEW_S + 1) * 1000),
      consumedAt: null,
      data: null,
      createdAt: at,
      updatedAt: at,
      secretVersion: config.keyring.current,
    });
  } catch (e) {
    if (e instanceof StorageError && e.code === "unique_violation") return refused;
    throw e;
  }
  return oauthOk({ client, method: "private_key_jwt", confidential: true });
}

/**
 * True when a code needs PKCE. A public client always needs it. A
 * confidential client may omit it only when it asks `openid` with a
 * `nonce`. RFC 9700 section 2.1.1 lets the nonce take the place of PKCE for
 * a confidential OpenID client. Owner decision 3 of plan 12e takes that
 * rule, so the Basic OP conformance plan passes.
 */
export function pkceRequired(
  client: Pick<OAuthClientRow, "authMethod">,
  scopes: readonly string[],
  nonce: string | null,
): boolean {
  if (client.authMethod === "none") return true;
  return !(scopes.includes("openid") && typeof nonce === "string");
}
