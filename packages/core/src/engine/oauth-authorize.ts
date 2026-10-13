import type { ResolvedConfig } from "../config.js";
import type { OAuthErrorCode } from "../errors.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { hasControlChar } from "../primitives/text.js";
import type { OAuthClientRow, UserRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { issuerOf } from "./jwt.js";
import { findClient } from "./oauth-clients.js";
import { oauthOf } from "./oauth-result.js";
import type { ResolvedSession } from "./sessions.js";

/**
 * The authorization endpoint (plan 9g, spec 8.13 item 2): RFC 6749 section
 * 4.1 with PKCE S256 (RFC 7636), the resource indicator (RFC 8707), and the
 * OIDC `nonce` and `prompt`. A bad client or redirect URI never redirects
 * (RFC 6749 section 4.1.2.1); every later error goes back to the client with
 * the state and `iss` (RFC 9207).
 */

export const CODE_PREFIX = "oc_";
/** RFC 7636 section 4.2: 43 to 128 unreserved characters. The S256 of a verifier is 43. */
const CHALLENGE_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const PARAM_MAX = 512;
/** The longest `next` that `safeNext` keeps. A longer authorize URL cannot ride through the sign-in page. */
const NEXT_MAX = 2048;
const CLIENT_ID_MAX = 2048;
export const AUTHORIZE_PER_IP = { seconds: 900, max: 60 };

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** Each once, in the order asked. */
  scopes: string[];
  state: string | null;
  resource: string;
  nonce: string | null;
  prompt: "none" | "consent" | null;
  /** `prompt` holds `login`: the person must sign in again (OIDC Core 1.0 section 3.1.2.1). */
  login: boolean;
}

/** The data of an `oauth-code` verification row. */
export interface OAuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  userId: string;
  nonce: string | null;
  sessionId: string;
}

export type AuthorizeStep =
  | { kind: "error"; error: OAuthErrorCode }
  | { kind: "redirect"; location: string }
  | { kind: "sign-in"; location: string }
  | { kind: "consent"; request: AuthorizeRequest; client: OAuthClientRow; user: UserRow };

type Checked =
  | { ok: true; request: AuthorizeRequest; client: OAuthClientRow }
  | { ok: false; step: AuthorizeStep };

/** One value of a parameter: null when absent, undefined when repeated (RFC 6749 section 3.1). */
function single(params: URLSearchParams, name: string): string | null | undefined {
  const all = params.getAll(name);
  if (all.length > 1) return undefined;
  return all[0] ?? null;
}

/** Absent, or at most 512 characters with no control character. */
function shortText(value: string | null | undefined): value is string | null {
  if (value === undefined) return false;
  return value === null || (value.length <= PARAM_MAX && !hasControlChar(value));
}

/** The client's redirect URI with `params` and `iss` in the query. */
export function authorizeRedirect(
  config: ResolvedConfig,
  redirectUri: string,
  params: Record<string, string | null>,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set("iss", issuerOf(config));
  return u.toString();
}

export async function checkAuthorize(
  config: ResolvedConfig,
  params: URLSearchParams,
): Promise<Checked> {
  const oauth = oauthOf(config);
  const stop = (error: OAuthErrorCode): Checked => ({ ok: false, step: { kind: "error", error } });
  const clientId = single(params, "client_id");
  if (!clientId || clientId.length > CLIENT_ID_MAX) return stop("invalid_request");
  const client = await findClient(config, clientId);
  if (!client) return stop("invalid_client");
  // Exact match: no prefix, no added query (OAuth 2.1 section 4.1.1).
  const redirectUri = single(params, "redirect_uri");
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) return stop("invalid_request");
  const back = (error: OAuthErrorCode, state: string | null): Checked => ({
    ok: false,
    step: { kind: "redirect", location: authorizeRedirect(config, redirectUri, { error, state }) },
  });
  const state = single(params, "state");
  if (!shortText(state)) return back("invalid_request", null);
  const responseType = single(params, "response_type");
  if (responseType === undefined) return back("invalid_request", state);
  if (responseType !== "code") return back("unsupported_response_type", state);
  const challenge = single(params, "code_challenge");
  if (
    !challenge ||
    !CHALLENGE_RE.test(challenge) ||
    single(params, "code_challenge_method") !== "S256"
  )
    return back("invalid_request", state);
  // RFC 8707 section 2 admits a repeated `resource`; one token has one
  // audience here, so a repeated one is refused as `invalid_target`.
  const resource = single(params, "resource");
  if (!resource || !oauth.resources.includes(resource)) return back("invalid_target", state);
  const scope = single(params, "scope");
  if (scope === undefined) return back("invalid_request", state);
  const scopes = [...new Set((scope ?? "").split(" ").filter((s) => s.length > 0))];
  if (scopes.length === 0 || scopes.some((s) => !oauth.scopes.has(s)))
    return back("invalid_scope", state);
  const nonce = single(params, "nonce");
  if (!shortText(nonce)) return back("invalid_request", state);
  // OIDC Core section 3.1.2.1: a space-separated list; `none` with another value is an error.
  const prompt = single(params, "prompt");
  if (prompt === undefined) return back("invalid_request", state);
  const prompts = new Set((prompt ?? "").split(" ").filter((p) => p.length > 0));
  if (prompts.has("none") && prompts.size > 1) return back("invalid_request", state);
  return {
    ok: true,
    client,
    request: {
      clientId: client.id,
      redirectUri,
      codeChallenge: challenge,
      scopes,
      state,
      resource,
      nonce,
      prompt: prompts.has("none") ? "none" : prompts.has("consent") ? "consent" : null,
      login: prompts.has("login"),
    },
  };
}

/** True when the user's consent for the client holds every scope asked. */
export async function consentCovers(
  config: ResolvedConfig,
  userId: string,
  clientId: string,
  scopes: readonly string[],
): Promise<boolean> {
  const row = await config.storage.findOne("oauthConsent", [
    { field: "userId", op: "eq", value: userId },
    { field: "clientId", op: "eq", value: clientId },
  ]);
  return row !== null && scopes.every((s) => row.scopes.includes(s));
}

/** Adds `scopes` to the user's consent for the client. Not in a transaction: the unique error is caught here (plan 3 rule). */
export async function grantConsent(
  config: ResolvedConfig,
  userId: string,
  clientId: string,
  scopes: readonly string[],
): Promise<void> {
  const where = [
    { field: "userId" as const, op: "eq" as const, value: userId },
    { field: "clientId" as const, op: "eq" as const, value: clientId },
  ];
  const now = config.clock.now();
  const merge = async () => {
    const row = await config.storage.findOne("oauthConsent", where);
    if (!row) return false;
    await config.storage.update("oauthConsent", [{ field: "id", op: "eq", value: row.id }], {
      scopes: [...new Set([...row.scopes, ...scopes])],
      updatedAt: now,
    });
    return true;
  };
  if (await merge()) return;
  try {
    await config.storage.create("oauthConsent", {
      id: newId(now),
      userId,
      clientId,
      scopes: [...scopes],
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    if (!(e instanceof StorageError && e.code === "unique_violation")) throw e;
    // A parallel allow wrote the row first: add these scopes to it.
    await merge();
  }
}

/** A one-time code: an `oauth-code` verification row with the request, `codeTtlMinutes` long. */
export async function issueCode(
  config: ResolvedConfig,
  input: { request: AuthorizeRequest; userId: string; sessionId: string },
): Promise<string> {
  const oauth = oauthOf(config);
  const now = config.clock.now();
  const code = randomToken(CODE_PREFIX);
  const { request } = input;
  const data: OAuthCodeData = {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scopes: request.scopes,
    resource: request.resource,
    userId: input.userId,
    nonce: request.nonce,
    sessionId: input.sessionId,
  };
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "oauth-code",
    // The user, as for a handoff code: a reset or a password change deletes
    // the user's codes by it (plan 9g final fix wave, round 2).
    identifier: input.userId,
    valueHash: await sha256Hex(code),
    expiresAt: new Date(now.getTime() + oauth.codeTtlMinutes * 60_000),
    consumedAt: null,
    data: { ...data },
    createdAt: now,
    updatedAt: now,
  });
  return code;
}

function denied(
  config: ResolvedConfig,
  request: AuthorizeRequest,
  error: OAuthErrorCode,
): AuthorizeStep {
  return {
    kind: "redirect",
    location: authorizeRedirect(config, request.redirectUri, { error, state: request.state }),
  };
}

async function codeRedirect(
  config: ResolvedConfig,
  request: AuthorizeRequest,
  session: ResolvedSession,
): Promise<AuthorizeStep> {
  const code = await issueCode(config, {
    request,
    userId: session.user.id,
    sessionId: session.session.id,
  });
  return {
    kind: "redirect",
    location: authorizeRedirect(config, request.redirectUri, { code, state: request.state }),
  };
}

const limited = async (config: ResolvedConfig, ip: string | null) =>
  !(await config.limiter.allow(`oauth-authorize:ip:${ip ?? "unknown"}`, AUTHORIZE_PER_IP));

/**
 * The GET of the authorization endpoint. With no session: the sign-in page,
 * with `next` back to this request. An unverified user is refused: a grant
 * would outlive a claim of the address (spec 8.7). A consent that covers
 * every scope asked gives the code at once, unless `prompt=consent`.
 */
export async function authorizeStep(
  config: ResolvedConfig,
  input: { params: URLSearchParams; session: ResolvedSession | null; ip: string | null },
): Promise<AuthorizeStep> {
  if (await limited(config, input.ip)) return { kind: "error", error: "rate_limited" };
  const c = await checkAuthorize(config, input.params);
  if (!c.ok) return c.step;
  const { request } = c;
  const { session } = input;
  if (!session) {
    if (request.prompt === "none") return denied(config, request, "login_required");
    // The sign-in page is the fresh sign-in that `login` asks for. The way
    // back drops `login`, or the new session would answer `login_required`.
    const back = new URLSearchParams(input.params);
    if (request.login) {
      const rest = (back.get("prompt") ?? "")
        .split(" ")
        .filter((p) => p.length > 0 && p !== "login");
      if (rest.length > 0) back.set("prompt", rest.join(" "));
      else back.delete("prompt");
    }
    const next = `${config.basePath}/oauth/authorize?${back.toString()}`;
    // `safeNext` sends a longer `next` to the app root, a dead end: tell the client now.
    if (next.length > NEXT_MAX) return denied(config, request, "invalid_request");
    return {
      kind: "sign-in",
      location: `${config.baseURL}${config.basePath}/oauth/sign-in?next=${encodeURIComponent(next)}`,
    };
  }
  // OIDC Core 1.0 section 3.1.2.1: with `login` the server must sign the
  // person in again or answer an error. Core does not end a live session
  // to sign it in again, so it answers `login_required`; the client may
  // send the person to sign out first.
  if (request.login) return denied(config, request, "login_required");
  if (!session.user.emailVerified) return denied(config, request, "access_denied");
  if (
    request.prompt !== "consent" &&
    (await consentCovers(config, session.user.id, request.clientId, request.scopes))
  )
    return codeRedirect(config, request, session);
  if (request.prompt === "none") return denied(config, request, "consent_required");
  return { kind: "consent", request, client: c.client, user: session.user };
}

/** The POST of the consent form. The route checked the session and the Origin; the request is checked again here. */
export async function decideAuthorize(
  config: ResolvedConfig,
  input: { params: URLSearchParams; decision: string; session: ResolvedSession; ip: string | null },
): Promise<AuthorizeStep> {
  if (await limited(config, input.ip)) return { kind: "error", error: "rate_limited" };
  const c = await checkAuthorize(config, input.params);
  if (!c.ok) return c.step;
  if (input.decision !== "allow" || !input.session.user.emailVerified)
    return denied(config, c.request, "access_denied");
  await grantConsent(config, input.session.user.id, c.request.clientId, c.request.scopes);
  return codeRedirect(config, c.request, input.session);
}
