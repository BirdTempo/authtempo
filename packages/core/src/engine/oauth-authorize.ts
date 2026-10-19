import type { ResolvedConfig } from "../config.js";
import type { OAuthErrorCode } from "../errors.js";
import { ipKey } from "../limiter/ip-key.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { hasControlChar } from "../primitives/text.js";
import type { OAuthClientRow, SessionRow, UserRow, VerificationRow } from "../schema.js";
import { StorageError } from "../storage/port.js";
import { issuerOf } from "./jwt.js";
import { pkceRequired } from "./oauth-client-auth.js";
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
/** RFC 7636 section 4.2: 43 to 128 unreserved characters. The S256 of a verifier is 43. Exported for the contract. */
export const CHALLENGE_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const PARAM_MAX = 512;
const CLIENT_ID_MAX = 2048;
/**
 * RFC 9449 section 10: `dpop_jkt` is a SHA-256 thumbprint, 43 base64url
 * characters. Exported for the contract, so the two rules are one.
 */
export const DPOP_JKT_RE = /^[A-Za-z0-9_-]{43}$/;
/** The short id of a held authorize request (plan 9h). Not `or_`: that is the refresh token's prefix. */
export const REQUEST_PREFIX = "oq_";
const REQUEST_RE = /^oq_[A-Za-z0-9_-]{43}$/;
/** A held request lives 10 minutes (owner decision 4a of 2026-10-14): the sign-in and the consent answer fit in it. */
export const REQUEST_TTL_MS = 10 * 60_000;
export const AUTHORIZE_PER_IP = { seconds: 900, max: 60 };
/** `max_age` in seconds: 1 to 10 digits, so the value stays a safe integer. Exported for the contract. */
export const MAX_AGE_RE = /^[0-9]{1,10}$/;
/**
 * OIDC Core 1.0 section 3.1.2.6 (read 2026-10-20): each of these asks for
 * a feature that core does not serve, and goes back to the client.
 */
const REFUSED_PARAMS = [
  ["request", "request_not_supported"],
  ["request_uri", "request_uri_not_supported"],
  ["registration", "registration_not_supported"],
] as const;
/**
 * Each is OPTIONAL: OIDC Core 1.0 section 3.1.2.1, with `claims_locales` in
 * section 5.2 and `claims` in section 5.5. Core reads each once, so a
 * repeated one is `invalid_request`, and does nothing with it.
 */
const IGNORED_PARAMS = [
  "display",
  "ui_locales",
  "claims_locales",
  "login_hint",
  "acr_values",
  "id_token_hint",
  "claims",
] as const;

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  /** Null when the client may omit PKCE (`pkceRequired`, plan 12e). */
  codeChallenge: string | null;
  /** Each once, in the order asked. */
  scopes: string[];
  state: string | null;
  resource: string;
  nonce: string | null;
  prompt: "none" | "consent" | null;
  /** `prompt` holds `login`: the person must sign in again (OIDC Core 1.0 section 3.1.2.1). */
  login: boolean;
  /** `max_age` in seconds, or null. An older sign-in must be done again (OIDC Core 1.0 section 3.1.2.1). */
  maxAge: number | null;
  /** The `dpop_jkt` of RFC 9449 section 10: the exchange needs a proof of this key. */
  dpopJkt: string | null;
}

/** The data of an `oauth-code` verification row. */
export interface OAuthCodeData {
  clientId: string;
  redirectUri: string;
  /** Null when the request had no challenge; the exchange then refuses a verifier (plan 12e). */
  codeChallenge: string | null;
  scopes: string[];
  resource: string;
  userId: string;
  nonce: string | null;
  sessionId: string;
  /** The thumbprint of `dpop_jkt`, or null: the code binds no key (plan 12e). */
  dpopJkt: string | null;
  /**
   * `authTimeOf` the session that the code came from, in seconds: the ID
   * token's `auth_time` (plan 12e). Null for a code of an older core.
   */
  authTime: number | null;
}

/** The data of an `oauth-request` verification row (plan 9h). */
export interface OAuthRequestData {
  /** The authorize query as checked, with `login` dropped from `prompt`. */
  params: string;
  /** The user the consent page showed the request to; null before the sign-in. */
  userId: string | null;
  /**
   * The earliest sign-in that may go on, in epoch milliseconds, or null
   * (plan 12e). `prompt=login` and a `max_age` that the session does not
   * meet set it to the time of the request.
   */
  minAuthTime: number | null;
}

/**
 * The time of the session's last sign-in, in epoch milliseconds: `freshAt`,
 * else `createdAt` (a session of schema 9 or older). With 12a, a
 * re-authentication counts as a sign-in. A handoff session holds the
 * browser session's sign-in in `freshAt`, older than its `createdAt`, so
 * `createdAt` never wins (plan 12e ruling 41).
 */
function authAtMs(session: SessionRow): number {
  return (session.freshAt ?? session.createdAt).getTime();
}

/**
 * The `auth_time` of OIDC Core 1.0 section 2, in seconds: `freshAt`, else
 * `createdAt`. With 12a, a re-authentication counts as a sign-in.
 */
export function authTimeOf(session: SessionRow): number {
  return Math.floor(authAtMs(session) / 1000);
}

export type AuthorizeStep =
  | { kind: "error"; error: OAuthErrorCode }
  | { kind: "redirect"; location: string }
  | { kind: "sign-in"; location: string }
  | {
      kind: "consent";
      request: AuthorizeRequest;
      client: OAuthClientRow;
      user: UserRow;
      /** The short id of the held request, the one field the form posts back (plan 9h). */
      requestId: string;
    };

type Checked =
  | { ok: true; request: AuthorizeRequest; client: OAuthClientRow }
  | { ok: false; step: AuthorizeStep };

/** One value of a parameter: null when absent, undefined when repeated (RFC 6749 section 3.1). */
function single(params: URLSearchParams, name: string): string | null | undefined {
  const all = params.getAll(name);
  if (all.length > 1) return undefined;
  return all[0] ?? null;
}

/**
 * `single`, with an empty value as absent: RFC 6749 section 3.1 (read
 * 2026-10-20) treats a parameter sent without a value as omitted.
 */
function given(params: URLSearchParams, name: string): string | null | undefined {
  const all = params.getAll(name).filter((v) => v !== "");
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
  for (const [name, error] of REFUSED_PARAMS)
    if (given(params, name) !== null) return back(error, state);
  for (const name of IGNORED_PARAMS)
    if (single(params, name) === undefined) return back("invalid_request", state);
  const responseType = single(params, "response_type");
  if (responseType === undefined) return back("invalid_request", state);
  if (responseType !== "code") return back("unsupported_response_type", state);
  // Absent, or S256 with a good challenge. Whether this client may omit it waits for the scopes and the nonce.
  const challenge = single(params, "code_challenge");
  const method = single(params, "code_challenge_method");
  if (challenge === undefined || method === undefined) return back("invalid_request", state);
  if (challenge === null ? method !== null : !CHALLENGE_RE.test(challenge) || method !== "S256")
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
  if (challenge === null && pkceRequired(client, scopes, nonce))
    return back("invalid_request", state);
  // OIDC Core section 3.1.2.1: a space-separated list; `none` with another value is an error.
  const prompt = single(params, "prompt");
  if (prompt === undefined) return back("invalid_request", state);
  const prompts = new Set((prompt ?? "").split(" ").filter((p) => p.length > 0));
  if (prompts.has("none") && prompts.size > 1) return back("invalid_request", state);
  const maxAge = given(params, "max_age");
  if (maxAge === undefined || (maxAge !== null && !MAX_AGE_RE.test(maxAge)))
    return back("invalid_request", state);
  const dpopJkt = given(params, "dpop_jkt");
  if (dpopJkt === undefined || (dpopJkt !== null && !DPOP_JKT_RE.test(dpopJkt)))
    return back("invalid_request", state);
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
      maxAge: maxAge === null ? null : Number(maxAge),
      dpopJkt,
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
  input: { request: AuthorizeRequest; userId: string; sessionId: string; authTime: number },
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
    dpopJkt: request.dpopJkt,
    authTime: input.authTime,
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
    secretVersion: config.keyring.current,
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
    authTime: authTimeOf(session.session),
  });
  return {
    kind: "redirect",
    location: authorizeRedirect(config, request.redirectUri, { code, state: request.state }),
  };
}

const limited = async (config: ResolvedConfig, ip: string | null) =>
  !(await config.limiter.allow(`oauth-authorize:ip:${ipKey(ip)}`, AUTHORIZE_PER_IP));

/** A held request as read: its clear short id, its row, and its data. */
interface HeldRequest {
  id: string;
  row: VerificationRow;
  data: OAuthRequestData;
}

/**
 * Holds the checked query in an `oauth-request` verification row for 10
 * minutes and answers its short id (plan 9h, owner decision 4a). The way
 * back through the sign-in page and the consent form carry the id, not the
 * query: a long client id or state fits in `next`, and the consent POST
 * decides on the request that core checked, not on hidden form fields.
 */
async function holdRequest(
  config: ResolvedConfig,
  clientId: string,
  params: URLSearchParams,
  userId: string | null,
  minAuthTime: number | null,
): Promise<string> {
  const now = config.clock.now();
  const id = randomToken(REQUEST_PREFIX);
  const data: OAuthRequestData = { params: params.toString(), userId, minAuthTime };
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "oauth-request",
    // The client: before the sign-in the row names no user.
    identifier: clientId,
    valueHash: await sha256Hex(id),
    expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    consumedAt: null,
    data: { ...data },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  return id;
}

/** The live held request of `id`, or null: malformed, unknown, spent, expired, or with bad data. */
async function readHeld(config: ResolvedConfig, id: string): Promise<HeldRequest | null> {
  if (!REQUEST_RE.test(id)) return null;
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(id) },
    { field: "purpose", op: "eq", value: "oauth-request" },
  ]);
  if (!row || row.consumedAt !== null || row.expiresAt.getTime() <= config.clock.now().getTime())
    return null;
  const params = row.data?.params;
  const userId = row.data?.userId;
  // A row of a core before plan 12e has no minAuthTime and asks for no new sign-in.
  const min = row.data?.minAuthTime ?? null;
  if (typeof params !== "string") return null;
  if (min !== null && !Number.isSafeInteger(min)) return null;
  const minAuthTime = min as number | null;
  if (userId === null) return { id, row, data: { params, userId: null, minAuthTime } };
  if (typeof userId !== "string") return null;
  return { id, row, data: { params, userId, minAuthTime } };
}

/** Spends the held request in one conditional update: one request, one final answer, also for two parallel ones. */
async function spendHeld(config: ResolvedConfig, held: HeldRequest): Promise<boolean> {
  const now = config.clock.now();
  const n = await config.storage.update(
    "verification",
    [
      { field: "id", op: "eq", value: held.row.id },
      { field: "consumedAt", op: "eq", value: null },
      { field: "expiresAt", op: "gt", value: now },
    ],
    { consumedAt: now, updatedAt: now },
  );
  return n === 1;
}

/**
 * Binds the held request to the user the consent page shows it to. A row
 * bound to a user stays bound (plan 9h fix round 1): another user's GET of
 * its id answers false, so the first user's page keeps working. The update
 * matches the read's `updatedAt`, and the bind moves `updatedAt` at least
 * 1 ms on, so of two parallel GETs on a row with no user one binds. False:
 * another user holds the row, or it was spent or bound since the read.
 */
async function bindHeld(
  config: ResolvedConfig,
  held: HeldRequest,
  userId: string,
): Promise<boolean> {
  if (held.data.userId === userId) return true;
  if (held.data.userId !== null) return false;
  // A clock that does not move between two requests would give the same
  // `updatedAt` twice, and the second bind would match the first one's row.
  const at = new Date(Math.max(config.clock.now().getTime(), held.row.updatedAt.getTime() + 1));
  const n = await config.storage.update(
    "verification",
    [
      { field: "id", op: "eq", value: held.row.id },
      { field: "consumedAt", op: "eq", value: null },
      { field: "updatedAt", op: "eq", value: held.row.updatedAt },
    ],
    { data: { ...held.data, userId }, updatedAt: at },
  );
  return n === 1;
}

/** A final answer: a held request is spent first, so it ends once. A lost spend answers invalid_request. */
async function settle(
  config: ResolvedConfig,
  held: HeldRequest | null,
  step: () => Promise<AuthorizeStep>,
): Promise<AuthorizeStep> {
  if (held && !(await spendHeld(config, held))) return { kind: "error", error: "invalid_request" };
  return step();
}

/**
 * The sign-in step. With `oauth.signInURL` the app's own route, with the
 * held request's id alone. The held request is the only state, so the
 * parameter carries no URL and opens no redirect (plan 9h). Else core's
 * sign-in page, with `next` back to the held request.
 */
function signInStep(config: ResolvedConfig, requestId: string): AuthorizeStep {
  const { signInURL } = oauthOf(config);
  if (signInURL !== null) {
    const url = new URL(signInURL);
    url.searchParams.set("request_id", requestId);
    return { kind: "sign-in", location: url.toString() };
  }
  const next = `${config.basePath}/oauth/authorize?request_id=${requestId}`;
  return {
    kind: "sign-in",
    location: `${config.baseURL}${config.basePath}/oauth/sign-in?next=${encodeURIComponent(next)}`,
  };
}

/** `params` with `login` dropped from `prompt`: the sign-in page is the fresh sign-in that `login` asks for. */
function withoutLogin(params: URLSearchParams): URLSearchParams {
  const back = new URLSearchParams(params);
  const rest = (back.get("prompt") ?? "").split(" ").filter((p) => p.length > 0 && p !== "login");
  if (rest.length > 0) back.set("prompt", rest.join(" "));
  else back.delete("prompt");
  return back;
}

/**
 * The steps with a session, for a fresh request and a held one. A held
 * request bound to another user answers the stale-id error first, before
 * any read of consents and any spend: else that user's GET would spend the
 * row on the three branches below (spec 8.13, plan 9h final fix wave). An
 * unverified user is refused: a grant would outlive a claim of the address
 * (spec 8.7). A consent that covers every scope asked gives the code at
 * once, unless `prompt=consent`. Else the consent page shows the held
 * request, bound to this user.
 */
async function sessionStep(
  config: ResolvedConfig,
  checked: { request: AuthorizeRequest; client: OAuthClientRow },
  params: URLSearchParams,
  session: ResolvedSession,
  held: HeldRequest | null,
): Promise<AuthorizeStep> {
  const { request, client } = checked;
  // The second line: heldStep refuses another user's GET of a bound row
  // first, before checkAuthorize. This one keeps sessionStep safe on its own.
  if (held && held.data.userId !== null && held.data.userId !== session.user.id)
    return { kind: "error", error: "invalid_request" };
  if (!session.user.emailVerified)
    return settle(config, held, () => Promise.resolve(denied(config, request, "access_denied")));
  if (
    request.prompt !== "consent" &&
    (await consentCovers(config, session.user.id, request.clientId, request.scopes))
  )
    return settle(config, held, () => codeRedirect(config, request, session));
  if (request.prompt === "none")
    return settle(config, held, () => Promise.resolve(denied(config, request, "consent_required")));
  if (held && !(await bindHeld(config, held, session.user.id)))
    return { kind: "error", error: "invalid_request" };
  const requestId = held
    ? held.id
    : await holdRequest(config, request.clientId, params, session.user.id, null);
  return { kind: "consent", request, client, user: session.user, requestId };
}

/**
 * True when the session's last sign-in is at or after the held request's
 * `minAuthTime`. A `prompt=login` or `max_age` request never goes on with
 * the session it came with (OIDC Core 1.0 section 3.1.2.1).
 */
function signedInSince(session: ResolvedSession, held: HeldRequest): boolean {
  return held.data.minAuthTime === null || authAtMs(session.session) >= held.data.minAuthTime;
}

/**
 * True when the request needs a sign-in after the session's: `prompt=login`,
 * `max_age=0` (OIDC Core 1.0 section 3.1.2.1 calls it `prompt=login`), or a
 * sign-in more than `max_age` seconds ago.
 */
function needsSignIn(config: ResolvedConfig, request: AuthorizeRequest, session: SessionRow) {
  if (request.login || request.maxAge === 0) return true;
  if (request.maxAge === null) return false;
  return config.clock.now().getTime() - authAtMs(session) > request.maxAge * 1000;
}

/**
 * The GET with `request_id`: the held query, checked again, because the
 * client and the config may have changed. A row bound to a user answers the
 * stale-id error to any other caller, with a session or with none, before
 * the check: a failed check spends the row, so the check must not run for
 * a caller who does not own it (spec 8.13, plan 9h final fix wave round 2).
 */
async function heldStep(
  config: ResolvedConfig,
  requestId: string,
  session: ResolvedSession | null,
): Promise<AuthorizeStep> {
  const held = await readHeld(config, requestId);
  if (!held) return { kind: "error", error: "invalid_request" };
  if (held.data.userId !== null && held.data.userId !== session?.user.id)
    return { kind: "error", error: "invalid_request" };
  const params = new URLSearchParams(held.data.params);
  const c = await checkAuthorize(config, params);
  if (!c.ok) {
    const { step } = c;
    return settle(config, held, () => Promise.resolve(step));
  }
  if (!session || !signedInSince(session, held)) return signInStep(config, held.id);
  return sessionStep(config, c, params, session, held);
}

/**
 * The GET of the authorization endpoint. With no session: the request is
 * held, and the browser goes to the sign-in page with `next` back to it.
 * With `request_id`: the held request, which comes alone.
 */
export async function authorizeStep(
  config: ResolvedConfig,
  input: { params: URLSearchParams; session: ResolvedSession | null; ip: string | null },
): Promise<AuthorizeStep> {
  if (await limited(config, input.ip)) return { kind: "error", error: "rate_limited" };
  const requestId = single(input.params, "request_id");
  if (requestId !== null) {
    // A parameter beside the id would be a second request in one URL.
    if (requestId === undefined || [...input.params.keys()].length !== 1)
      return { kind: "error", error: "invalid_request" };
    return heldStep(config, requestId, input.session);
  }
  const c = await checkAuthorize(config, input.params);
  if (!c.ok) return c.step;
  const { request } = c;
  const fresh = request.login || request.maxAge !== null;
  if (input.session && !needsSignIn(config, request, input.session.session))
    return sessionStep(config, c, input.params, input.session, null);
  // OIDC Core 1.0 section 3.1.2.1: `prompt=none` shows no page.
  if (request.prompt === "none") return denied(config, request, "login_required");
  // The held request needs a sign-in at or after now, so no session from
  // before the request goes on. The held query drops `login`: `minAuthTime`
  // holds the rule now.
  const now = config.clock.now().getTime();
  const back = request.login ? withoutLogin(input.params) : input.params;
  return signInStep(
    config,
    await holdRequest(config, request.clientId, back, null, fresh ? now : null),
  );
}

/**
 * The POST of the consent form (plan 9h: it binds to the held request). The
 * route checked the session and the Origin. The form carries the short id
 * and the decision only, so a changed field changes nothing. The page
 * showed the request to one user; a post of another user decides nothing.
 */
export async function decideAuthorize(
  config: ResolvedConfig,
  input: { requestId: string; decision: string; session: ResolvedSession; ip: string | null },
): Promise<AuthorizeStep> {
  if (await limited(config, input.ip)) return { kind: "error", error: "rate_limited" };
  const held = await readHeld(config, input.requestId);
  if (!held || held.data.userId !== input.session.user.id)
    return { kind: "error", error: "invalid_request" };
  // The same user's older session decides nothing and spends nothing (plan 12e).
  if (!signedInSince(input.session, held)) return signInStep(config, held.id);
  if (!(await spendHeld(config, held))) return { kind: "error", error: "invalid_request" };
  const c = await checkAuthorize(config, new URLSearchParams(held.data.params));
  if (!c.ok) return c.step;
  if (input.decision !== "allow" || !input.session.user.emailVerified)
    return denied(config, c.request, "access_denied");
  await grantConsent(config, input.session.user.id, c.request.clientId, c.request.scopes);
  return codeRedirect(config, c.request, input.session);
}
