import { type ApiTokenSummaryJSON, type ClientFailure, createTransport } from "@authtempo/client";
import type { PublicSession } from "@authtempo/core";
import {
  ACCESS_TOKEN_TYPE,
  API_TOKEN_PREFIX,
  decodeJws,
  isResourceUrl,
  JWS_RE,
  readBearer,
  resourceOf,
  SESSION_JWT_TYPE,
  SESSION_TOKEN_PREFIX,
  verifyJws,
} from "@authtempo/core/credentials";
import { VERIFY_CALLS, type VerifyOperation } from "./calls.js";
import { ownedFetch, TIMEOUT_DEFAULT_MS, TIMEOUT_MAX_MS, TIMEOUT_MIN_MS } from "./fetch.js";
import { createKeyCache } from "./jwks.js";
import {
  type ChallengeInput,
  insufficientScopeResponse,
  unauthorizedResponse,
} from "./unauthorized.js";

export type CallerKind = "session-jwt" | "oauth" | "api-token" | "session-token";
const KINDS: readonly CallerKind[] = ["session-jwt", "oauth", "api-token", "session-token"];

/** The caller of a request, by the credential it carried (plan 11d). Mirrors `auth.caller` of core. */
export type Caller =
  | {
      kind: "session-jwt";
      userId: string;
      sessionId: string;
      email: string;
      emailVerified: boolean;
      name: string | null;
      organizationId: string | null;
      /** Every claim of the token, the app's own `jwtMint.claims` among them. */
      claims: Readonly<Record<string, unknown>>;
      expiresAt: Date;
    }
  | {
      kind: "oauth";
      userId: string;
      clientId: string;
      scopes: string[];
      resource: string;
      tokenId: string;
      expiresAt: Date;
    }
  | { kind: "api-token"; user: PublicSession["user"]; apiToken: ApiTokenSummaryJSON }
  | { kind: "session-token"; user: PublicSession["user"]; session: PublicSession["session"] };

/** A caller, null for no valid credential, or a failure when the auth app did not answer. */
export type VerifyResult = { ok: true; value: Caller | null } | ClientFailure;

/** The longest `tk_` answer cache. A revoke then takes effect within a minute at most. */
export const API_TOKEN_CACHE_MAX_SECONDS = 60;
/** The `tk_` answers a verifier keeps at most; the oldest goes first. */
const API_TOKEN_CACHE_MAX = 1000;
/** Core's rule of a `jwtMint.audience` entry (config.ts): 1 to 10 entries of 1 to 2048 characters. */
const AUDIENCE_MAX = 10;
const AUDIENCE_LENGTH_MAX = 2048;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the rule refuses control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export interface VerifierOptions {
  /** `baseURL + basePath` of the auth app, the `iss` of its tokens, such as `https://api.example.com/auth`. */
  issuer: string;
  /** The session JWT audience of this server: one or more `jwtMint.audience` entries. Needed for `session-jwt`. */
  audience?: string | readonly string[] | undefined;
  /** The `oauth.resources` entries that this server serves. Needed for `oauth`. */
  resources?: readonly string[] | undefined;
  /** The credential kinds to accept. Default `["session-jwt"]`. */
  accept?: readonly CallerKind[] | undefined;
  /** Ask `POST /token/live` for each session JWT, so a sign-out ends access at once. Default false. */
  checkSessionEnd?: boolean | undefined;
  /** `apiTokenSeconds`: how long a `tk_` answer is kept, 0 to 60. Default 0: a revoke takes effect at once. */
  cache?: { apiTokenSeconds?: number | undefined } | undefined;
  /** The deadline of each call to the auth app, 100 to 30000 ms. Default 5000. */
  timeoutMs?: number | undefined;
  /** The fetch of the calls to the auth app. Any function of a request and its init that answers a Response. */
  fetch?: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined;
  /** Tests inject a clock. */
  clock?: { now(): Date } | undefined;
}

export interface Verifier {
  /** The caller of a request. Never throws for an answer. */
  verifyRequest(request: Request): Promise<VerifyResult>;
  /** The 401 of a request with no valid credential (RFC 6750, RFC 9728). Pass the scope that the route needs. */
  unauthorized(input?: ChallengeInput): Response;
  /** The 403 of a valid token without a scope that the operation needs. */
  insufficientScope(input: ChallengeInput & { scope: string | readonly string[] }): Response;
}

function pathOf(operation: VerifyOperation): string {
  const c = VERIFY_CALLS.find((x) => x.operation === operation);
  // Unreachable: the type of `operation` is a name of the table.
  if (!c) throw new Error(`authtempo verify: no call ${operation}`);
  return c.path;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True for an object with a string `id`: the run-time check of a 200 answer of the auth app.
 * The client types the body at compile time only.
 */
function hasId(value: unknown): boolean {
  return isObject(value) && typeof value.id === "string" && value.id !== "";
}

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The claim rule of a session JWT: a copy of `verifySessionJwt` in core's `engine/jwt.ts`.
 * It holds the checks after the signature. `typ` is `JWT`, and `iss` is the issuer.
 * `sub` and `sid` are strings, and `exp` is a number after now with no clock skew.
 * `aud`, a string or a list, holds an entry of the audience.
 * THE TWO COPIES MUST STAY EQUAL: `test/engine-parity.test.ts` asks both copies about the same tokens.
 */
type Claims = Record<string, unknown>;

function sessionClaimsPass(
  p: Claims,
  issuer: string,
  audience: readonly string[],
  nowSeconds: number,
): p is Claims & { sub: string; sid: string; exp: number } {
  if (p.iss !== issuer || typeof p.sub !== "string" || typeof p.sid !== "string") return false;
  if (typeof p.exp !== "number" || p.exp <= nowSeconds) return false;
  const aud: unknown[] = typeof p.aud === "string" ? [p.aud] : Array.isArray(p.aud) ? p.aud : [];
  return aud.some((a) => typeof a === "string" && audience.includes(a));
}

/**
 * The claim rule of an access token: a copy of `resolveAccessToken` in core's `engine/oauth-token.ts`.
 * It also copies the resource check of `callerFromRequest` in `engine/tokens.ts`.
 * `typ` is `at+jwt`, and `iss` is the issuer.
 * `aud` is a string, and it is the resource that the request URL falls under, by `resourceOf`.
 * `exp` is a number after now with no clock skew.
 * `sub`, `client_id`, `scope`, and `jti` are strings.
 * Core also makes checks that an offline check cannot make, because each one reads core's
 * storage or config. For a user token: the user exists, and each scope is in `oauth.scopes`.
 * For a client token: the client exists, it holds the `client_credentials` grant, and each
 * scope is in its `credentialsScopes` and in `oauth.scopes` (plan 12e rulings 28 and 29).
 * THE COPIES MUST STAY EQUAL: `test/engine-parity.test.ts` pins them.
 */
function accessClaimsPass(
  p: Claims,
  issuer: string,
  resource: string | null,
  nowSeconds: number,
): p is Claims & { sub: string; client_id: string; scope: string; jti: string; exp: number } {
  if (p.iss !== issuer || typeof p.aud !== "string" || resource === null || p.aud !== resource)
    return false;
  if (typeof p.exp !== "number" || p.exp <= nowSeconds) return false;
  return (
    typeof p.sub === "string" &&
    typeof p.client_id === "string" &&
    typeof p.scope === "string" &&
    typeof p.jti === "string"
  );
}

/**
 * The resource-server SDK (plan 11d, spec 20).
 * A session JWT and an access token verify offline against the key set.
 * A `tk_` token and a `ts_` token verify by one call to the auth app.
 * It reads the `Authorization` header only: a resource server never reads the session cookie.
 * A wrong config throws here.
 */
export function createVerifier(options: VerifierOptions): Verifier {
  let issuerURL: URL;
  try {
    issuerURL = new URL(options.issuer);
  } catch {
    throw new Error("authtempo verify: issuer must be an absolute URL");
  }
  if (
    (issuerURL.protocol !== "https:" && issuerURL.protocol !== "http:") ||
    issuerURL.search ||
    issuerURL.hash ||
    issuerURL.username ||
    issuerURL.password
  )
    throw new Error(
      "authtempo verify: issuer must be an http or https URL with no query, fragment, or user info",
    );
  const issuer = options.issuer.replace(/\/$/, "");
  const accept = options.accept ?? ["session-jwt"];
  if (accept.length === 0 || accept.some((k) => !KINDS.includes(k)))
    throw new Error(`authtempo verify: accept must list one or more of ${KINDS.join(", ")}`);
  const audience =
    options.audience === undefined
      ? []
      : typeof options.audience === "string"
        ? [options.audience]
        : [...options.audience];
  if (
    audience.length > AUDIENCE_MAX ||
    audience.some(
      (a) =>
        typeof a !== "string" || a.length < 1 || a.length > AUDIENCE_LENGTH_MAX || CONTROL.test(a),
    )
  )
    throw new Error(
      "authtempo verify: audience must be 1 to 10 strings of 1 to 2048 characters with no control character",
    );
  const resources = [...(options.resources ?? [])];
  // The rule of core's `oauth.resources` check, by its one copy (Task 1 review): a
  // malformed resource throws here, not at each request.
  for (const r of resources)
    if (!isResourceUrl(r))
      throw new Error(
        `authtempo verify: the resource ${JSON.stringify(r)} must be an http or https URL with no query, fragment, or user info`,
      );
  if (accept.includes("session-jwt") && audience.length === 0)
    throw new Error("authtempo verify: accept holds session-jwt, so audience is required");
  if (accept.includes("oauth") && resources.length === 0)
    throw new Error("authtempo verify: accept holds oauth, so resources is required");
  // Spec 8.12 (review I-2): one key signs both kinds of token with one issuer.
  // So a URL that is both could let one kind pass as the other where a check skips typ.
  for (const a of audience)
    if (resources.includes(a))
      throw new Error(`authtempo verify: ${a} is both an audience and a resource`);
  const apiTokenSeconds = options.cache?.apiTokenSeconds ?? 0;
  if (
    !Number.isInteger(apiTokenSeconds) ||
    apiTokenSeconds < 0 ||
    apiTokenSeconds > API_TOKEN_CACHE_MAX_SECONDS
  )
    throw new Error(
      `authtempo verify: cache.apiTokenSeconds must be an integer from 0 to ${API_TOKEN_CACHE_MAX_SECONDS}`,
    );
  const timeoutMs = options.timeoutMs ?? TIMEOUT_DEFAULT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < TIMEOUT_MIN_MS || timeoutMs > TIMEOUT_MAX_MS)
    throw new Error(
      `authtempo verify: timeoutMs must be an integer from ${TIMEOUT_MIN_MS} to ${TIMEOUT_MAX_MS}`,
    );
  const doFetch = ownedFetch(options.fetch ?? globalThis.fetch.bind(globalThis), timeoutMs);
  const clock = options.clock ?? { now: () => new Date() };
  const now = () => clock.now().getTime();
  const keys = createKeyCache({ url: `${issuer}${pathOf("verify.jwks")}`, fetch: doFetch, now });
  const transport = (bearer: string) =>
    createTransport({
      baseURL: issuerURL.origin,
      basePath: issuerURL.pathname.replace(/\/$/, ""),
      fetch: doFetch,
      credentials: "omit",
      token: () => bearer,
    });
  const none: VerifyResult = { ok: true, value: null };
  // A 200 answer whose shape is not core's: a proxy page or a wrong route, never a caller.
  const unexpected200: VerifyResult = { ok: false, code: "unexpected", status: 200 };
  const apiCache = new Map<string, { until: number; caller: Caller }>();

  async function apiToken(bearer: string): Promise<VerifyResult> {
    const hash = apiTokenSeconds > 0 ? await sha256Hex(bearer) : "";
    const hit = apiTokenSeconds > 0 ? apiCache.get(hash) : undefined;
    if (hit && hit.until > now()) return { ok: true, value: hit.caller };
    const r = await transport(bearer)<{
      user: PublicSession["user"];
      apiToken: ApiTokenSummaryJSON;
    }>("GET", "/tokens/current");
    if (!r.ok) return r.code === "unauthorized" ? none : r;
    const body: unknown = r.value;
    if (!isObject(body) || !hasId(body.user) || !hasId(body.apiToken)) return unexpected200;
    const caller: Caller = {
      kind: "api-token",
      user: body.user as PublicSession["user"],
      apiToken: body.apiToken as ApiTokenSummaryJSON,
    };
    if (apiTokenSeconds > 0) {
      apiCache.delete(hash);
      apiCache.set(hash, { until: now() + apiTokenSeconds * 1000, caller });
      while (apiCache.size > API_TOKEN_CACHE_MAX) {
        const oldest = apiCache.keys().next().value;
        if (oldest === undefined) break;
        apiCache.delete(oldest);
      }
    }
    return { ok: true, value: caller };
  }

  async function sessionToken(token: string): Promise<VerifyResult> {
    const r = await transport(token)<PublicSession>("GET", "/session");
    if (!r.ok) return r.code === "unauthorized" ? none : r;
    const body: unknown = r.value;
    if (!isObject(body) || !hasId(body.user) || !hasId(body.session)) return unexpected200;
    return {
      ok: true,
      value: {
        kind: "session-token",
        user: body.user as PublicSession["user"],
        session: body.session as PublicSession["session"],
      },
    };
  }

  async function jwt(token: string, url: string): Promise<VerifyResult> {
    const d = decodeJws(token);
    if (!d) return none;
    const kind =
      d.header.typ === SESSION_JWT_TYPE
        ? "session-jwt"
        : d.header.typ === ACCESS_TOKEN_TYPE
          ? "oauth"
          : null;
    if (kind === null || !accept.includes(kind)) return none;
    const k = await keys.key(d.header.kid);
    if (!k.ok) return k;
    if (!k.value || !(await verifyJws(d, k.value))) return none;
    const p = d.payload;
    const nowSeconds = Math.floor(now() / 1000);
    if (kind === "session-jwt") {
      if (!sessionClaimsPass(p, issuer, audience, nowSeconds)) return none;
      // Core writes these claims in every session JWT (`mintSessionJwt`), and only core holds the key.
      // So a token without them is not core's: null, never a throw.
      if (typeof p.email !== "string" || typeof p.email_verified !== "boolean") return none;
      if (options.checkSessionEnd) {
        const live = await transport(token)<{ live: boolean }>("POST", "/token/live");
        if (!live.ok) return live.code === "unauthorized" ? none : live;
        const answer: unknown = live.value;
        if (!isObject(answer) || typeof answer.live !== "boolean") return unexpected200;
        if (!answer.live) return none;
      }
      return {
        ok: true,
        value: {
          kind,
          userId: p.sub,
          sessionId: p.sid,
          email: p.email,
          emailVerified: p.email_verified,
          name: typeof p.name === "string" ? p.name : null,
          organizationId: typeof p.org === "string" ? p.org : null,
          claims: p,
          expiresAt: new Date(p.exp * 1000),
        },
      };
    }
    const resource = resourceOf(resources, url);
    if (!accessClaimsPass(p, issuer, resource, nowSeconds) || resource === null) return none;
    return {
      ok: true,
      value: {
        kind,
        userId: p.sub,
        clientId: p.client_id,
        scopes: p.scope.split(" ").filter((s) => s.length > 0),
        resource,
        tokenId: p.jti,
        expiresAt: new Date(p.exp * 1000),
      },
    };
  }

  return {
    async verifyRequest(request) {
      // The bearer only (Task 1 review): a resource server never reads the session cookie.
      // So a browser's cookie on a cross-site request is no credential here.
      const bearer = readBearer(request);
      if (bearer === null) return none;
      if (bearer.startsWith(API_TOKEN_PREFIX))
        return accept.includes("api-token") ? apiToken(bearer) : none;
      if (bearer.startsWith(SESSION_TOKEN_PREFIX))
        return accept.includes("session-token") ? sessionToken(bearer) : none;
      if (JWS_RE.test(bearer)) return jwt(bearer, request.url);
      return none;
    },
    unauthorized: (input = {}) => unauthorizedResponse(input),
    insufficientScope: (input) => insufficientScopeResponse(input),
  };
}
