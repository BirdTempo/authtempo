import type { ResolvedConfig } from "../config.js";
import type { ClientAuthMethod, OAuthClientRow } from "../schema.js";
import { secretMatches } from "./oauth-client-secret.js";
import { findClient } from "./oauth-clients.js";
import { type OAuthResult, oauthFail, oauthOk } from "./oauth-result.js";

/**
 * The client auth of every client-facing endpoint (plan 12e, spec 8.16):
 * `client_secret_basic`, `client_secret_post`, and `none` for a public
 * client. RFC 6749 section 2.3: one method per request, and the method is
 * the client's own. No per-client limit on a failed auth: a secret of 256
 * bits does not fall to guesses. A limit per client would let a stranger
 * lock a real client out. The per-IP limit of the token endpoint stays (plan 12e).
 */

export type AuthMethod = ClientAuthMethod;

export interface AuthedClient {
  client: OAuthClientRow;
  /** The method of this request, which is the client's own. */
  method: AuthMethod;
  /** OAuth 2.1 section 2.1: a client with credentials. */
  confidential: boolean;
}

const BASIC_RE = /^basic /i;

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
    form.has("client_secret") ||
    form.has("client_assertion_type")
  );
}

/**
 * The client of the request, authenticated. The methods present are an
 * `Authorization: Basic` header, `client_secret` in the form, and
 * `client_assertion_type` in the form. More than one is `invalid_request`.
 * With none, `client_id` of the form names a public client. The method
 * present must be the client's own: a public client with a secret, and a
 * confidential client with none, are `invalid_client`. After a Basic
 * attempt the answer carries `basic`, so a 401 adds the Basic challenge
 * (RFC 6749 section 5.2). `known` is a row of the named id that the caller
 * already read, so a CIMD client is not read twice.
 */
export async function authenticateClient(
  config: ResolvedConfig,
  request: Request,
  form: URLSearchParams,
  known?: OAuthClientRow,
): Promise<OAuthResult<AuthedClient> & { basic?: true }> {
  const header = request.headers.get("authorization") ?? "";
  const isBasic = BASIC_RE.test(header);
  const fail = (error: "invalid_request" | "invalid_client") =>
    isBasic ? { ...oauthFail<AuthedClient>(error), basic: true as const } : oauthFail(error);
  const formSecret = form.get("client_secret");
  const assertion = form.has("client_assertion_type");
  const present = [isBasic, formSecret !== null, assertion].filter(Boolean).length;
  if (present > 1) return fail("invalid_request");
  // Plan 12e Task 5 checks the assertion (RFC 7523); until then no client uses it.
  if (assertion) return fail("invalid_client");
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
  if (client.authMethod !== method) return fail("invalid_client");
  if (secret !== null && !(await secretMatches(client, secret, config.clock.now())))
    return fail("invalid_client");
  const authed = oauthOk({ client, method, confidential: method !== "none" });
  return isBasic ? { ...authed, basic: true } : authed;
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
